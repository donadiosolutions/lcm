/**
 * Time budget for Codex Interrupt and SessionEnd hooks.
 *
 * Codex kills the hook's process group three seconds after launch, and that
 * timer also covers login-shell startup. The hook therefore plans around the
 * Node process's own uptime: it stops starting work after 1350ms and keeps the
 * last 150ms for the outcome diagnostic. Shell startup and synchronous
 * filesystem stalls are outside this arithmetic; the process test measures
 * them and the documentation states the bound as an engineering target.
 */
export const TERMINAL_NODE_BUDGET_MS = 1500;
export const TERMINAL_WORK_CUTOFF_MS = 1350;
export const TERMINAL_STDIN_CAP_MS = 200;
export const TERMINAL_VERIFY_CAP_MS = 400;

export type TerminalPhase = "stdin" | "verify" | "post";

const PHASE_CAP_MS: Readonly<Record<TerminalPhase, number>> = {
  stdin: TERMINAL_STDIN_CAP_MS,
  verify: TERMINAL_VERIFY_CAP_MS,
  post: TERMINAL_WORK_CUTOFF_MS,
};

/** Milliseconds a phase may run when it starts after `elapsedMs` of Node uptime. */
export function terminalPhaseBudgetMs(phase: TerminalPhase, elapsedMs: number): number {
  return Math.min(PHASE_CAP_MS[phase], TERMINAL_WORK_CUTOFF_MS - elapsedMs);
}

/** Milliseconds left for the outcome diagnostic once `elapsedMs` have passed. */
export function terminalOutcomeBudgetMs(elapsedMs: number): number {
  return Math.max(0, TERMINAL_NODE_BUDGET_MS - elapsedMs);
}

export type TerminalPhaseScope = Readonly<{
  /** Aborts when the phase budget ends; already aborted when no budget remains. */
  signal: AbortSignal;
  budgetMs: number;
  /** Releases the phase timer. Call exactly once from a finally block. */
  dispose: () => void;
}>;

export type TerminalDeadline = Readonly<{
  openPhase: (phase: TerminalPhase) => TerminalPhaseScope;
  outcomeBudgetMs: () => number;
}>;

export type TerminalDeadlineDeps = Readonly<{
  /** Milliseconds of Node uptime, including module loading. */
  elapsedMs?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}>;

export function createTerminalDeadline(deps: TerminalDeadlineDeps = {}): TerminalDeadline {
  const elapsedMs = deps.elapsedMs ?? ((): number => process.uptime() * 1000);
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  return {
    openPhase: (phase) => {
      const budgetMs = terminalPhaseBudgetMs(phase, elapsedMs());
      const controller = new AbortController();
      if (budgetMs <= 0) {
        controller.abort();
        return { signal: controller.signal, budgetMs, dispose: () => undefined };
      }
      const timer = setTimer(() => controller.abort(), budgetMs);
      return { signal: controller.signal, budgetMs, dispose: () => clearTimer(timer) };
    },
    outcomeBudgetMs: () => terminalOutcomeBudgetMs(elapsedMs()),
  };
}

