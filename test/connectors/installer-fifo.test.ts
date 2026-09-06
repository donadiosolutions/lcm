import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const STARTUP_BUDGET_MS = 10_000;
const OPERATION_BUDGET_MS = 1_000;
const CLOSE_GRACE_MS = 2_000;
const CHILD_TEST_TIMEOUT_MS = 20_000;

const roots: string[] = [];
const activeChildren = new Set<ChildProcess>();
const closedChildren = new WeakSet<ChildProcess>();
const reapPromises = new WeakMap<ChildProcess, Promise<void>>();

type ChildPhase = "startup" | "operation" | "exited";
type ChildResult = {
  readonly outcome: "completed" | "timeout" | "error";
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
};

type ChildOptions = {
  readonly source: string;
  readonly startupBudgetMs?: number;
  readonly operationBudgetMs?: number;
  readonly closeGraceMs?: number;
  readonly spawnFactory?: () => ChildProcess;
};

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  killCalls = 0;
  disconnectCalls = 0;

  constructor(private readonly onDisconnect?: () => void) {
    super();
  }

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
    this.onDisconnect?.();
  }

  send(_message: unknown, callback?: (error: Error | null) => void): boolean {
    callback?.(null);
    return true;
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function killQuietly(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited between the state check and kill.
  }
}

function disconnectQuietly(child: ChildProcess): void {
  if (!child.connected) return;
  try {
    child.disconnect();
  } catch {
    // The child may have disconnected between the state check and disconnect.
  }
}

async function reapChild(child: ChildProcess, graceMs = CLOSE_GRACE_MS): Promise<void> {
  if (closedChildren.has(child)) {
    activeChildren.delete(child);
    return;
  }
  const existingReap = reapPromises.get(child);
  if (existingReap !== undefined) {
    await existingReap;
    return;
  }

  let resolveReap!: () => void;
  let settled = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const reap = new Promise<void>((resolve) => {
    resolveReap = resolve;
    const complete = (): void => {
      if (settled) return;
      settled = true;
      if (grace !== undefined) clearTimeout(grace);
      child.removeListener("close", onClose);
      activeChildren.delete(child);
      resolveReap();
    };
    const onClose = (): void => {
      closedChildren.add(child);
      complete();
    };
    child.once("close", onClose);
    grace = setTimeout(complete, graceMs);
    if (child.exitCode === null && child.signalCode === null) {
      disconnectQuietly(child);
      killQuietly(child);
    }
  });
  const trackedReap = reap.finally(() => {
    reapPromises.delete(child);
  });
  reapPromises.set(child, trackedReap);
  await trackedReap;
}

function runChild({
  source,
  startupBudgetMs = STARTUP_BUDGET_MS,
  operationBudgetMs = OPERATION_BUDGET_MS,
  closeGraceMs = CLOSE_GRACE_MS,
  spawnFactory,
}: ChildOptions): Promise<ChildResult> {
  const sourceLoader = `data:text/javascript,${encodeURIComponent([
    "export async function resolve(specifier, context, nextResolve) {",
    "  if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);",
    "  return nextResolve(specifier, context);",
    "}",
  ].join("\n"))}`;
  const child = spawnFactory?.() ?? spawn(process.execPath, [
      "--experimental-transform-types",
      "--loader",
      sourceLoader,
      "--input-type=module",
      "--eval",
      source,
    ], {
      env: process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  activeChildren.add(child);

  const lifecycle = new Promise<ChildResult>((resolveResult) => {
    let phase: ChildPhase = "startup";
    let settled = false;
    let timedOut = false;
    let operationResultSeen = false;
    let exitSnapshot: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
    let result: ChildResult | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      if (operationTimer !== undefined) clearTimeout(operationTimer);
      if (closeGraceTimer !== undefined) clearTimeout(closeGraceTimer);
      startupTimer = undefined;
      operationTimer = undefined;
      closeGraceTimer = undefined;
    };

    const finish = (nextResult: ChildResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolveResult(nextResult);
    };

    const setFailure = (error: Error, timeout: boolean): void => {
      if (result !== undefined || settled) return;
      timedOut = timeout;
      result = {
        outcome: timeout ? "timeout" : "error",
        code: exitSnapshot?.code ?? child.exitCode,
        signal: exitSnapshot?.signal ?? child.signalCode,
        error,
      };
    };

    const armCloseGrace = (): void => {
      if (closeGraceTimer !== undefined) return;
      closeGraceTimer = setTimeout(() => {
        finish(result ?? {
          outcome: timedOut ? "timeout" : "error",
          code: exitSnapshot?.code ?? child.exitCode,
          signal: exitSnapshot?.signal ?? child.signalCode,
          error: new Error("child close cleanup timed out"),
        });
      }, closeGraceMs);
    };

    const killForFailure = (error: Error, timeout: boolean): void => {
      if (settled) return;
      setFailure(error, timeout);
      armCloseGrace();
      if (child.exitCode !== null || child.signalCode !== null) return;
      killQuietly(child);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const phaseAtExit = phase;
      exitSnapshot = { code, signal };
      phase = "exited";
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      if (operationTimer !== undefined) clearTimeout(operationTimer);
      startupTimer = undefined;
      operationTimer = undefined;
      if (result !== undefined || settled) return;
      if (timedOut) return;
      if (phaseAtExit === "operation" && code === 0 && signal === null) {
        result = { outcome: "completed", code, signal };
      } else if (phaseAtExit === "startup" && code === 0 && signal === null) {
        result = {
          outcome: "error",
          code,
          signal,
          error: new Error("child exited before completing the operation"),
        };
      } else {
        result = {
          outcome: "error",
          code,
          signal,
          error: new Error(`child exited before completion (code=${String(code)}, signal=${String(signal)})`),
        };
      }
      armCloseGrace();
    };

    child.once("error", (error) => {
      killForFailure(error instanceof Error ? error : new Error(String(error)), false);
    });
    child.once("exit", onExit);
    child.once("close", (code, signal) => {
      closedChildren.add(child);
      activeChildren.delete(child);
      if (exitSnapshot === undefined) exitSnapshot = { code, signal };
      if (result !== undefined && result.outcome === "timeout") {
        result = {
          ...result,
          code: exitSnapshot.code,
          signal: exitSnapshot.signal,
        };
      }
      if (result === undefined && !settled) {
        if (timedOut) {
          result = {
            outcome: "timeout",
            code: exitSnapshot.code,
            signal: exitSnapshot.signal,
          };
        } else if (phase === "operation" && code === 0 && signal === null) {
          result = { outcome: "completed", code, signal };
        } else {
          result = {
            outcome: "error",
            code,
            signal,
            error: new Error("child closed before readiness or completion"),
          };
        }
      }
      finish(result ?? {
        outcome: timedOut ? "timeout" : "error",
        code: exitSnapshot.code,
        signal: exitSnapshot.signal,
        error: new Error("child closed without an outcome"),
      });
    });
    child.once("disconnect", () => {
      if (!settled && phase !== "exited" && !operationResultSeen) {
        killForFailure(new Error("child disconnected before completion"), false);
      }
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "result") {
        operationResultSeen = true;
        return;
      }
      if (message.type !== "ready" || phase !== "startup" || settled) return;
      phase = "operation";
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      startupTimer = undefined;
      operationTimer = setTimeout(() => {
        if (settled || phase !== "operation") return;
        if (child.exitCode !== null || child.signalCode !== null) return;
        killForFailure(new Error("child operation timed out"), true);
      }, operationBudgetMs);
      try {
        child.send({ type: "go" }, (error) => {
          if (error !== null) {
            killForFailure(error, false);
          }
        });
      } catch (error) {
        killForFailure(error instanceof Error ? error : new Error(String(error)), false);
      }
    });

    startupTimer = setTimeout(() => {
      if (settled || phase !== "startup") return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      killForFailure(new Error("child startup timed out"), true);
    }, startupBudgetMs);
  });

  return lifecycle.finally(async () => {
    if (activeChildren.has(child)) await reapChild(child);
  });
}

function installerChildSource(
  root: string,
  installerUrl: string,
  options: { readonly startupDelayMs?: number; readonly hangAfterGo?: boolean } = {},
): string {
  const startupDelayMs = options.startupDelayMs ?? 0;
  const hangAfterGo = options.hangAfterGo ?? false;
  const operation = hangAfterGo
    ? [
        "  try { installConnector(\"claude-code\", \"skill\", root); } catch {",
        "    // The keepalive, rather than an unresolved promise, defines the hang.",
        "  }",
        "  setInterval(() => undefined, 1000);",
      ]
    : [
        "  try {",
        '    installConnector("claude-code", "skill", root);',
        "    process.exitCode = 1;",
        "  } catch (error) {",
        '    process.exitCode = error instanceof Error && error.message.includes("Unable to inspect LCM skill") ? 0 : 1;',
        "  }",
      ];
  return [
    `import { installConnector } from ${JSON.stringify(installerUrl)};`,
    `const root = ${JSON.stringify(root)};`,
    "process.once(\"disconnect\", () => { process.exitCode ??= 1; });",
    "const reportResult = (code) => {",
    "  if (process.connected) process.send?.({ type: \"result\", code }, () => process.disconnect());",
    "};",
    "process.once(\"message\", (message) => {",
    '  if (!message || message.type !== "go") return;',
    ...operation,
    hangAfterGo ? "" : "  reportResult(process.exitCode);",
    "});",
    `const announceReady = () => process.send?.({ type: "ready" });`,
    startupDelayMs === 0 ? "announceReady();" : `setTimeout(announceReady, ${startupDelayMs});`,
  ].join("\n");
}

afterEach(async () => {
  await Promise.all([...activeChildren].map((child) => reapChild(child)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("connector installer child ownership", () => {
  it("settles an error after an exited child reports an exit code without close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let run: Promise<ChildResult> | undefined;
    let settled = false;
    const child = new FakeChild();
    const originalError = new Error("original exit-code failure");
    child.exitCode = 7;
    try {
      run = runChild({
        source: "",
        closeGraceMs: 5,
        spawnFactory: () => child.asChildProcess(),
      });
      run.then(() => { settled = true; });
      child.emit("error", originalError);
      child.emit("exit", 11, "SIGTERM");

      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();
      expect(activeChildren.has(child.asChildProcess())).toBe(true);

      await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      expect(child.killCalls).toBe(0);
      expect(child.disconnectCalls).toBe(0);
      expect(activeChildren.has(child.asChildProcess())).toBe(false);
      expect(child.listenerCount("close")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      const result = await run;
      expect(result).toMatchObject({ outcome: "error", code: 7, signal: null });
      expect(result.error).toBe(originalError);
    } finally {
      if (run !== undefined) {
        child.emit("close", 7, null);
        await vi.runAllTimersAsync();
        await run;
      }
      vi.useRealTimers();
    }
  });

  it("settles an error after an exited child reports a signal without close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let run: Promise<ChildResult> | undefined;
    let settled = false;
    const child = new FakeChild();
    const originalError = new Error("original signal failure");
    child.signalCode = "SIGTERM";
    try {
      run = runChild({
        source: "",
        closeGraceMs: 5,
        spawnFactory: () => child.asChildProcess(),
      });
      run.then(() => { settled = true; });
      child.emit("error", originalError);
      child.emit("exit", 11, null);

      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();
      expect(activeChildren.has(child.asChildProcess())).toBe(true);

      await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      expect(child.killCalls).toBe(0);
      expect(child.disconnectCalls).toBe(0);
      expect(activeChildren.has(child.asChildProcess())).toBe(false);
      expect(child.listenerCount("close")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      const result = await run;
      expect(result).toMatchObject({ outcome: "error", code: null, signal: "SIGTERM" });
      expect(result.error).toBe(originalError);
    } finally {
      if (run !== undefined) {
        child.emit("close", null, "SIGTERM");
        await vi.runAllTimersAsync();
        await run;
      }
      vi.useRealTimers();
    }
  });

  it("preserves an already-exited failure when close arrives before grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let run: Promise<ChildResult> | undefined;
    let settled = false;
    const child = new FakeChild();
    const originalError = new Error("close-before-grace failure");
    child.exitCode = 13;
    try {
      run = runChild({
        source: "",
        closeGraceMs: 5,
        spawnFactory: () => child.asChildProcess(),
      });
      run.then(() => { settled = true; });
      child.emit("error", originalError);
      child.emit("exit", 17, "SIGTERM");
      child.emit("close", 13, null);

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(child.killCalls).toBe(0);
      expect(child.disconnectCalls).toBe(0);
      expect(activeChildren.has(child.asChildProcess())).toBe(false);
      expect(child.listenerCount("close")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      const result = await run;
      expect(result).toMatchObject({ outcome: "error", code: 13, signal: null });
      expect(result.error).toBe(originalError);
    } finally {
      if (run !== undefined) {
        child.emit("close", 13, null);
        await vi.runAllTimersAsync();
        await run;
      }
      vi.useRealTimers();
    }
  });

  it("retains ownership until the final reap completes after exit without close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let run: Promise<ChildResult> | undefined;
    let settled = false;
    const child = new FakeChild();
    try {
      run = runChild({
        source: "",
        closeGraceMs: 5,
        spawnFactory: () => child.asChildProcess(),
      });
      run.then(() => { settled = true; });
      child.emit("exit", 0, null);

      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();

      expect(activeChildren.has(child.asChildProcess())).toBe(true);
      expect(settled).toBe(false);
      expect(child.listenerCount("close")).toBe(2);

      await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS);
      await run;

      expect(activeChildren.has(child.asChildProcess())).toBe(false);
      expect(child.listenerCount("close")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (run !== undefined) {
        await vi.runAllTimersAsync();
        await run;
      }
      vi.useRealTimers();
    }
  });

  it("observes close during the final reap and cleans its temporary listener", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let run: Promise<ChildResult> | undefined;
    const child = new FakeChild(() => child.emit("close", 0, null));
    try {
      run = runChild({
        source: "",
        closeGraceMs: 5,
        spawnFactory: () => child.asChildProcess(),
      });
      child.emit("exit", 1, null);

      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();

      await run;

      expect(child.disconnectCalls).toBe(1);
      expect(child.killCalls).toBe(1);
      expect(activeChildren.has(child.asChildProcess())).toBe(false);
      expect(child.listenerCount("close")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (run !== undefined) {
        await vi.runAllTimersAsync();
        await run;
      }
      vi.useRealTimers();
    }
  });

  it("releases ownership when the final reap grace expires without close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let run: Promise<ChildResult> | undefined;
    const child = new FakeChild();
    try {
      run = runChild({
        source: "",
        closeGraceMs: 5,
        spawnFactory: () => child.asChildProcess(),
      });
      child.emit("exit", 1, null);

      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();
      expect(activeChildren.has(child.asChildProcess())).toBe(true);
      expect(child.listenerCount("close")).toBe(2);

      await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS);
      await run;

      expect(activeChildren.has(child.asChildProcess())).toBe(false);
      expect(child.listenerCount("close")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (run !== undefined) {
        await vi.runAllTimersAsync();
        await run;
      }
      vi.useRealTimers();
    }
  });

  it("releases ownership on a normal close without leaving timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let run: Promise<ChildResult> | undefined;
    const child = new FakeChild();
    try {
      run = runChild({
        source: "",
        spawnFactory: () => child.asChildProcess(),
      });
      child.emit("close", 0, null);

      await run;

      expect(activeChildren.has(child.asChildProcess())).toBe(false);
      expect(child.listenerCount("close")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (run !== undefined) {
        await vi.runAllTimersAsync();
        await run;
      }
      vi.useRealTimers();
    }
  });
});

describe("connector installer FIFO safety", () => {
  it.runIf(process.platform === "linux")("rejects a FIFO without blocking the public installer API", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-installer-fifo-"));
    roots.push(root);
    const skillPath = join(root, ".claude", "skills", "lcm-memory", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    execFileSync("mkfifo", [skillPath]);

    const installerUrl = pathToFileURL(resolve("src/connectors/installer.ts")).href;
    const result = await runChild({
      source: installerChildSource(root, installerUrl),
    });

    expect(result).toMatchObject({ outcome: "completed", code: 0, signal: null });
  }, CHILD_TEST_TIMEOUT_MS);

  it.runIf(process.platform === "linux")("does not charge loader startup against the FIFO operation budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-installer-fifo-delay-"));
    roots.push(root);
    const skillPath = join(root, ".claude", "skills", "lcm-memory", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    execFileSync("mkfifo", [skillPath]);

    const installerUrl = pathToFileURL(resolve("src/connectors/installer.ts")).href;
    const result = await runChild({
      source: installerChildSource(root, installerUrl, { startupDelayMs: 1_500 }),
    });

    expect(result).toMatchObject({ outcome: "completed", code: 0, signal: null });
  }, CHILD_TEST_TIMEOUT_MS);

  it("kills a ready child that hangs during the operation phase", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-installer-fifo-hang-"));
    roots.push(root);
    const installerUrl = pathToFileURL(resolve("src/connectors/installer.ts")).href;
    const result = await runChild({
      source: installerChildSource(root, installerUrl, { hangAfterGo: true }),
    });

    expect(result.outcome).toBe("timeout");
    expect(result.signal).toBe("SIGKILL");
  }, CHILD_TEST_TIMEOUT_MS);

  it("rejects a child that exits cleanly before announcing readiness", async () => {
    const result = await runChild({
      source: "process.exitCode = 0;",
    });

    expect(result.outcome).toBe("error");
    expect(result.error?.message).toContain("before completion");
  }, CHILD_TEST_TIMEOUT_MS);
});
