/** State model for the ninja CLI progress renderer. */

export interface ProgressPhase {
  name: string;
  status: 'pending' | 'active' | 'done';
}

export interface ProgressError {
  sessionId: string;
  message: string;
}

export interface ProgressPhaseError {
  phase: string;
  target?: string;
  message: string;
}

export interface ProgressCurrentSession {
  sessionId: string;
  messages: number;
  tokens: number;
  startedAt: number;
}

export interface ProgressLastResult {
  sessionId: string;
  messages: number;
  tokensBefore: number;
  tokensAfter?: number;
  provider?: string;
  elapsed: number;
}

export interface ProgressDag {
  nodes: number;
  newNodes: number;
  depth: number;
  memoriesPromoted: number;
}

export interface ProgressState {
  /** Phase tracking (multi-phase pipelines like curate) */
  phases: ProgressPhase[];

  /** Multi-project tracking (--all mode) */
  currentProject?: string;

  /** Total sessions to process */
  total: number;
  /** Completed sessions (success + skip) */
  completed: number;
  /** Failed sessions — derived from errors.length to avoid drift */
  errors: ProgressError[];
  /** Phase-level failures that must not affect session totals. */
  phaseErrors: ProgressPhaseError[];

  /** Running metrics */
  tokensIn: number;
  tokensOut: number;     // 0 when no compaction (no replay)
  messagesIn: number;

  /** Current session being processed */
  current?: ProgressCurrentSession;
  /** Every session currently admitted to the compact worker pool. */
  activeSessions: ProgressCurrentSession[];

  /** Last completed session (drives line 3 of ninja display) */
  lastResult?: ProgressLastResult;

  /** DAG metrics (updated after compact/promote phases) */
  dag?: ProgressDag;

  /** Wall-clock start time */
  startedAt: number;

  /** Flags */
  dryRun: boolean;
  aborted: boolean;
}

export function makeProgressState(opts: {
  phases?: ProgressPhase[];
  total?: number;
  dryRun?: boolean;
}): ProgressState {
  return {
    phases: opts.phases ?? [],
    total: opts.total ?? 0,
    completed: 0,
    errors: [],
    phaseErrors: [],
    tokensIn: 0,
    tokensOut: 0,
    messagesIn: 0,
    activeSessions: [],
    startedAt: Date.now(),
    dryRun: opts.dryRun ?? false,
    aborted: false,
  };
}

/** Return the oldest active session, preserving insertion order for ties. */
export function progressCurrentSession(
  sessions: readonly ProgressCurrentSession[],
): ProgressCurrentSession | undefined {
  let oldest: ProgressCurrentSession | undefined;
  for (const session of sessions) {
    if (oldest === undefined || session.startedAt < oldest.startedAt) oldest = session;
  }
  return oldest;
}

/** Replace active-session accounting and its representative current value. */
export function updateProgressActiveSessions(
  state: ProgressState,
  sessions: readonly ProgressCurrentSession[],
): void {
  state.activeSessions = [...sessions];
  state.current = progressCurrentSession(state.activeSessions);
}
