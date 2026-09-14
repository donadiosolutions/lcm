import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runIdentityScenario } from "../postgresql/fixtures/surface-parity-identity.mjs";

// Injected fixture recorder: these results exercise the real scenario's order
// and lifetime assertions, and are never backend conformance evidence.
const hash = (path: string) => createHash("sha256").update(path).digest("hex");
const invalid = "--surface-parity-invalid-option";
const absent = "01900000-0000-7000-8000-000000000099";
const names = ["machine register", "machine show", "machine recover", "project create", "project show", "project link", "project list", "project reconcile-worktrees", "project unlink"];

function fixture(drift?: { command: "link" | "unlink"; field: "pid" | "generation" }) {
  const homeDir = mkdtempSync(join(tmpdir(), "surface-identity-recorder-"));
  mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
  writeFileSync(join(homeDir, ".lcm", "map.json"), "{}\n", { mode: 0o600 });
  const projectPath = join(homeDir, "projects", "primary");
  const root = join(homeDir, "projects", "surface-identity");
  const other = join(homeDir, "projects", "surface-identity-other");
  const alias = join(homeDir, "projects", "surface-identity-alias");
  const worktree = join(homeDir, "projects", "surface-identity-linked-worktree");
  const id = hash(root);
  const aliases: string[] = [];
  const trace: unknown[][] = [];
  const calls: string[][] = [];
  let lifetime = { pid: 100, generation: 1 };
  const result = (value: unknown, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: "" });
  const stop = () => { trace.push(["stop"]); lifetime = { pid: lifetime.pid + 1, generation: lifetime.generation + 1 }; };
  const context = {
    homeDir, projectPath, backend: "sqlite",
    matrix: names.map(name => ({ id: `cli:${name}`, scenario: "identity", assertions: ["arguments", "result", "effects"] })),
    currentDaemonIdentity: () => ({ ...lifetime }), runtimeState: () => ({}),
    async isolateAsyncWork() { stop(); },
    async finishSqliteRebound() { trace.push(["sqlite-rebound"]); stop(); },
    async prepareProjects(caseId: string, setup: () => Promise<unknown>) {
      trace.push(["prepare", caseId]); stop();
      const value = await setup();
      expect(value).toEqual({ caseId: "identity-roots", created: [] });
      trace.push(["prepared", caseId]);
    },
    async cli(args: string[]) {
      calls.push([...args]); trace.push(["cli", ...args]);
      if (args.includes(invalid)) return { code: 1, stdout: "", stderr: "unknown option" };
      const [noun, command, target] = args;
      if (noun === "machine") return result({ error: command === "show" ? "machine identity is not registered" : "requires storage.backend postgresql" }, 1);
      if (command === "create") return result({ error: "requires storage.backend postgresql" }, 1);
      if (command === "link") {
        aliases.push(args[3]);
        if (drift?.command === "link" && args[3] === alias) lifetime[drift.field]++;
        return result({ local: { id } });
      }
      if (command === "unlink") {
        aliases.splice(aliases.indexOf(target), 1);
        if (drift?.command === "unlink") lifetime[drift.field]++;
        return result({ hash: id, aliasRemoved: true });
      }
      if (command === "show") return result({ hash: id, entry: { canonical: root, aliases: [...aliases] } });
      if (command === "list") return result({ local: [{ hash: id, aliases: [...aliases] }, { hash: hash(other), aliases: [] }] });
      if (command === "reconcile-worktrees") return result({ status: "not-needed", targetHash: id, sourceHashes: [], backupPaths: [], aliases: [worktree] });
      throw new Error("unexpected recorder CLI");
    },
    async request(method: string, path: string, body?: { cwd: string }) {
      trace.push(["http", method, path, body]);
      if (path === "/health/observe") return { status: 200, body: { pid: lifetime.pid, daemonInstanceId: lifetime.generation } };
      if (path === "/health") return { status: 200, body: {} };
      if (path === "/ingest") return { status: 200, body: { ingested: 1 } };
      if (path === "/grep") return { status: 200, body: { messages: body?.cwd === other ? [] : [{}] } };
      throw new Error("unexpected recorder HTTP");
    },
  };
  return { context, root, other, alias, worktree, id, trace, calls, cleanup: () => rmSync(homeDir, { recursive: true, force: true }) };
}

it("records the unchanged SQLite CLI occurrence sequence and completes each live proof before stop", async () => {
  const f = fixture();
  try {
    const rows = await runIdentityScenario("identity", f.context);
    expect(rows).toHaveLength(names.length);
    expect(f.calls).toEqual([
      ["machine", "register", invalid], ["machine", "register", "--name", "Surface parity machine", "--json"],
      ["machine", "show", invalid], ["machine", "show", "--json"], ["machine", "recover", absent, "--json"],
      ["project", "create", f.root, invalid], ["project", "create", f.root, "--name", "Surface parity identity", "--json"],
      ["project", "show", f.root, invalid], ["project", "show", f.root, "--json"],
      ["project", "link", f.id, f.alias, invalid], ["project", "link", f.id, f.alias, "--json"], ["project", "show", f.alias, "--json"],
      ["project", "list", invalid], ["project", "list", "--json"],
      ["project", "link", f.id, f.worktree, "--json"], ["project", "reconcile-worktrees", f.root, invalid],
      ["project", "reconcile-worktrees", f.worktree, "--dry-run", "--json"], ["project", "reconcile-worktrees", f.worktree, "--json"],
      ["project", "show", f.worktree, "--json"], ["project", "unlink", f.alias, invalid],
      ["project", "unlink", f.alias, "--json"], ["project", "show", f.root, "--json"],
    ]);
    const boundaries = f.trace.reduce<number[]>((out, event, index) => event[0] === "stop" ? [...out, index] : out, []);
    expect(boundaries).toHaveLength(5);
    const preparation = f.trace.slice(f.trace.findIndex(event => event[0] === "prepare"), f.trace.findIndex(event => event[0] === "prepared") + 1);
    expect(preparation).toEqual([["prepare", "identity-roots"], ["stop"],
      ["cli", "project", "create", f.root, invalid], ["cli", "project", "create", f.root, "--name", "Surface parity identity", "--json"], ["prepared", "identity-roots"]]);
    const ingests = f.trace.filter(event => event[0] === "http" && event[2] === "/ingest");
    expect(ingests).toEqual([
      ["http", "POST", "/ingest", { cwd: f.root, session_id: "surface-identity-main", messages: [{ role: "user", content: "Identity corpus amber nautical separator", tokenCount: 8 }] }],
      ["http", "POST", "/ingest", { cwd: f.other, session_id: "surface-identity-other", messages: [{ role: "user", content: "Identity corpus cobalt unrelated separator", tokenCount: 8 }] }],
    ]);
    const firstLive = f.trace.slice(boundaries[0] + 1, boundaries[1]);
    expect(firstLive.filter(event => event[0] === "http").map(event => event[2])).toEqual(["/ingest", "/health/observe", "/ingest", "/health", "/health/observe"]);
    const aliasLive = f.trace.slice(boundaries[1] + 1, boundaries[2]);
    expect(aliasLive.filter(event => event[0] === "http").map(event => event[2])).toEqual(["/health/observe", "/health/observe", "/grep", "/health/observe", "/grep", "/health/observe", "/health/observe"]);
    expect(aliasLive.findIndex(event => event[0] === "cli" && event[2] === "link" && event.at(-1) === "--json"))
      .toBeLessThan(aliasLive.findIndex(event => event[0] === "cli" && event[2] === "show"));
    const unlinkLive = f.trace.slice(boundaries[3] + 1, boundaries[4]);
    expect(unlinkLive.filter(event => event[0] === "http").map(event => event[2])).toEqual(["/health/observe", "/grep", "/health/observe"]);
  } finally { f.cleanup(); }
});

it.each([
  ["link", "pid"], ["link", "generation"], ["unlink", "pid"], ["unlink", "generation"],
] as const)("rejects %s %s drift before the next stop can hide it", async (command, field) => {
  const f = fixture({ command, field });
  try {
    await expect(runIdentityScenario("identity", f.context)).rejects.toThrow("surface-identity:live-owner");
    const mutation = f.trace.findIndex(event => event[0] === "cli" && event[2] === command && event.at(-1) === "--json");
    expect(mutation).toBeGreaterThan(0);
    expect(f.trace.slice(mutation + 1).some(event => event[0] === "stop")).toBe(false);
    expect(f.trace.some(event => event[0] === "sqlite-rebound")).toBe(false);
  } finally { f.cleanup(); }
});
