import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import { assertSemanticEqual } from "./assertions.mjs";
import { createAdmissionLedger } from "./prepared-projects.mjs";

type Message = { type: string; seq?: number; scenario?: string };
interface Worker {
  start(): Promise<void>;
  run(scenario: string): Promise<unknown>;
  stop(): Promise<void>;
}

function actualWorkerFixture() {
  // Extract exact source declarations rather than importing the integration
  // module, whose top-level imports require built production code/PostgreSQL.
  // No worker method or branch is replaced by this distless harness.
  const source = readFileSync(new URL("../postgresql/surface-parity.integration.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("surface-parity.integration.ts", source, ts.ScriptTarget.ES2022, true);
  const needed = new Set(["failure", "requireThat", "object", "exact", "deferred", "bounded", "digestError", "workerError", "FixedBackendWorker"]);
  const declarations = ast.statements.filter(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && needed.has(node.name.text));
  expect(declarations.map(node => (node as ts.FunctionDeclaration).name!.text).sort()).toEqual([...needed].sort());
  const javascript = ts.transpileModule(declarations.map(node => node.getText(ast)).join("\n") + "\nFixedBackendWorker;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const sent: Message[] = [];
  const probes: [number, number | string][] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 987654, connected: true, stdout: new EventEmitter(), stderr: new EventEmitter(),
    send(message: Message, callback: (error: Error | null) => void) {
      sent.push(structuredClone(message)); callback(null);
      if (message.type === "stop") queueMicrotask(() => {
        child.emit("message", { type: "stopped", backend: "sqlite", cleanup: { verdict: "passed" } });
        child.emit("exit", 0, null);
      });
    },
  });
  const WorkerClass = runInNewContext(javascript, {
    Buffer, Error, setTimeout, clearTimeout, performance, join,
    process: { cwd: () => "/owned/fixture", kill: (pid: number, signal: number | string) => {
      probes.push([pid, signal]);
      if (signal !== 0) queueMicrotask(() => child.emit("exit", 0, null));
      throw Object.assign(new Error("owned group absent"), { code: "ESRCH" });
    } },
    fork: () => child,
    createAdmissionLedger,
    // VM objects have another prototype; IPC JSON values do not. Recreate that
    // real IPC boundary before invoking the unchanged semantic comparator.
    assertSemanticEqual: (actual: unknown, expected: unknown, id: string) =>
      assertSemanticEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), id),
    matrix: [], REQUEST_TIMEOUT: 1000, STREAM_LIMIT: 65536, IPC_LIMIT: 262144,
  }) as new (backend: string, env: object, administrator: object) => Worker;
  const worker = new WorkerClass("sqlite", {}, {});
  child.emit("message", { type: "ready", backend: "sqlite", routes: [], tools: [] });
  return { worker, child, sent, probes };
}

it("keeps FAILED terminal for runs while completing the owned STOP IPC roundtrip", async () => {
  const f = actualWorkerFixture();
  await f.worker.start();
  let admittedResults = 0;
  const running = f.worker.run("identity").then(value => { admittedResults++; return value; });
  const outcome = running.catch(error => error);
  expect(f.sent).toEqual([{ type: "run", seq: 1, scenario: "identity" }]);
  f.child.emit("message", { type: "failed", seq: 1, backend: "sqlite", scenario: "identity", error: { id: "original-live-failure", digest: "a".repeat(64) } });
  const primary = await outcome;
  expect(primary).toBeInstanceOf(Error);
  expect(primary.message).toBe(`surface-parity-parent:worker:sqlite:original-live-failure:${"a".repeat(64)}`);
  // Check no dependent scenario/fault can execute, independently from whether
  // cleanup can complete. Stop is the only legal follow-up IPC command.
  await expect(f.worker.run("admin")).rejects.toBe(primary);
  await expect(f.worker.run("fault-denial")).rejects.toBe(primary);
  expect(f.sent).toHaveLength(1);
  expect(admittedResults).toBe(0);
  await expect(f.worker.stop()).resolves.toBeUndefined();
  expect(f.sent).toEqual([{ type: "run", seq: 1, scenario: "identity" }, { type: "stop", seq: 2 }]);
  expect(f.probes.length).toBeGreaterThan(0);
  expect(f.probes.every(([pid, signal]) => pid === -987654 && signal === 0)).toBe(true);
  expect(admittedResults).toBe(0);
  expect(primary.message).toContain("original-live-failure");
  await expect(f.worker.run("identity")).rejects.toBe(primary);
  expect(f.sent).toHaveLength(2);
});
