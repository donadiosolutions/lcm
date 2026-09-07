import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { stagePortableArtifact } from "../../scripts/portable-package-smoke.mjs";
import { setConfigValue } from "../../src/config-manager.js";
import { DaemonClient, type DaemonHealth } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { hashProjectPath } from "../../src/project-map.js";
import { loadPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import { assertHarnessReady } from "./harness.js";
import { withSelectedPostgreSqlProject, type SelectedPostgreSqlProject } from "./operational-fixture.js";

const migrations = loadPostgreSqlMigrations();
const expectedLedger = migrations.map(({ id, sha256 }) => ({ id, checksum_sha256: sha256 }));
let scratch: string;
let tarball: string;
let tarballSha256: string;

beforeAll(async () => {
  await assertHarnessReady();
  scratch = mkdtempSync(join(tmpdir(), "lcm-pg-packed-startup-"));
  const filename = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", scratch], {
    cwd: process.cwd(), encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024,
  }).trim();
  expect(filename).toMatch(/^donadiosolutions-lcm-[A-Za-z0-9.+-]+\.tgz$/u);
  tarball = join(scratch, filename);
  tarballSha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  // Retain artifact identity in the bounded harness log after fixture cleanup.
  console.info("Packed canonical recall artifact", JSON.stringify({
    tarballSha256,
    entrypointSha256: createHash("sha256").update(readFileSync(join(process.cwd(), "dist/lcm.mjs"))).digest("hex"),
  }));
}, 120_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, 120_000);

function stagePackage(label: string): string {
  expect(createHash("sha256").update(readFileSync(tarball)).digest("hex")).toBe(tarballSha256);
  const directory = join(scratch, label);
  stagePortableArtifact(tarball, directory);
  const packageRoot = join(directory, "node_modules/@donadiosolutions/lcm");
  expect(readFileSync(join(packageRoot, "dist/lcm.mjs")))
    .toEqual(readFileSync(join(process.cwd(), "dist/lcm.mjs")));
  return packageRoot;
}

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback address");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (listening: boolean): void => { socket.destroy(); resolve(listening); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

function assertNoSqlite(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    expect(entry.name).not.toBe("db.sqlite");
    if (entry.isDirectory()) assertNoSqlite(join(directory, entry.name));
  }
}

type PackedFixture = Pick<SelectedPostgreSqlProject, "homeDir" | "projectRoot" | "projectPath">;
type PackedBackend = "sqlite" | "postgresql";
interface PackedDaemon {
  port: number;
  pid: number;
  entrypoint: string;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  started: () => boolean;
}

/** Execute the installed CLI, keeping diagnostics bounded and out of runner logs. */
async function withPackagedDaemon(
  packageRoot: string,
  fixture: PackedFixture,
  callback: (daemon: PackedDaemon) => Promise<void>,
  backend: PackedBackend = "postgresql",
): Promise<void> {
  const port = await unusedPort();
  setConfigValue({ configPath: join(fixture.homeDir, ".lcm/config.json"), path: "daemon.port", value: String(port), json: true });
  const entrypoint = join(packageRoot, "dist/lcm.mjs");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL,
    TZ: "UTC", HOME: fixture.homeDir, USERPROFILE: fixture.homeDir,
    XDG_CONFIG_HOME: join(fixture.homeDir, ".config"),
    XDG_CACHE_HOME: join(fixture.homeDir, ".cache"),
    XDG_STATE_HOME: join(fixture.homeDir, ".local/state"),
    XDG_RUNTIME_DIR: join(fixture.homeDir, ".runtime"),
    TMPDIR: join(fixture.homeDir, "tmp"),
  };
  if (backend === "postgresql") {
    for (const name of ["LCM_POSTGRES_URL", "LCM_POSTGRES_CA_FILE", "LCM_POSTGRES_MIGRATION_ROLE"]) {
      expect(process.env[name], `selected fixture must supply ${name}`).toBeTruthy();
      environment[name] = process.env[name];
    }
  }
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) {
    mkdirSync(environment[name]!, { recursive: true, mode: 0o700 });
  }
  expect(loadDaemonConfig(join(fixture.homeDir, ".lcm/config.json"), undefined, environment))
    .toMatchObject({ storage: { backend }, restoration: {
      promptSearchMinScore: 2, crossSessionAffinity: 0.85, promptSearchMaxResults: 3,
      maxInjectedMemoryBytes: 2048, reservedForLearningInstruction: 1024,
    } });
  const child = spawn(process.execPath, [entrypoint, "daemon", "start", "--foreground"], {
    cwd: fixture.projectPath, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  const signalOwnedGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let output = "";
  let bytes = 0;
  let overflow = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { overflow = true; signalOwnedGroup("SIGKILL"); }
      else output += chunk.toString();
    });
  }
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const deadline = setTimeout(() => signalOwnedGroup("SIGKILL"), 45_000);
  try {
    expect(child.pid).toBeTypeOf("number");
    await callback({ port, pid: child.pid!, entrypoint, closed,
      started: () => output.includes(`lcm daemon started on port ${port}`) });
  } finally {
    clearTimeout(deadline);
    signalOwnedGroup("SIGTERM");
    const backstop = setTimeout(() => signalOwnedGroup("SIGKILL"), 5000);
    try { await closed; } finally { clearTimeout(backstop); signalOwnedGroup("SIGKILL"); }
    expect(overflow).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
    expect(() => process.kill(-child.pid!, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
    expect(await isListening(port)).toBe(false);
    expect(existsSync(join(fixture.homeDir, ".lcm/daemon.pid"))).toBe(false);
    if (backend === "postgresql") {
      assertNoSqlite(fixture.homeDir);
      assertNoSqlite(fixture.projectRoot);
    } else {
      expect(existsSync(join(fixture.homeDir, ".lcm/projects", hashProjectPath(fixture.projectPath), "db.sqlite")))
        .toBe(true);
    }
  }
}

async function withRecallFixture(
  backend: PackedBackend,
  label: string,
  callback: (fixture: PackedFixture) => Promise<void>,
): Promise<void> {
  if (backend === "postgresql") {
    let owned: PackedFixture | undefined;
    try {
      // This fixture also awaits the authenticated, run-owned database drop.
      await withSelectedPostgreSqlProject(label, async fixture => {
        owned = fixture;
        await callback(fixture);
      });
    } finally {
      if (owned) {
        expect(existsSync(owned.homeDir)).toBe(false);
        expect(existsSync(owned.projectRoot)).toBe(false);
      }
    }
    return;
  }
  const homeDir = mkdtempSync(join(scratch, "recall-sqlite-home-"));
  const projectRoot = mkdtempSync(join(scratch, "recall-sqlite-project-"));
  const projectPath = join(projectRoot, "project");
  mkdirSync(projectPath, { mode: 0o700 });
  try {
    setConfigValue({ configPath: join(homeDir, ".lcm/config.json"), path: "storage.backend", value: "sqlite" });
    await callback({ homeDir, projectRoot, projectPath });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    expect(existsSync(homeDir)).toBe(false);
    expect(existsSync(projectRoot)).toBe(false);
  }
}

async function awaitPackedHealth(daemon: PackedDaemon, fixture: PackedFixture): Promise<{
  client: DaemonClient;
  health: DaemonHealth;
}> {
  const tokenPath = join(fixture.homeDir, ".lcm/daemon.token");
  let exited = false;
  void daemon.closed.then(() => { exited = true; });
  for (let attempt = 0; attempt < 150 && !exited; attempt += 1) {
    if (daemon.started() && existsSync(tokenPath)) {
      // Recreate the client so a missing token during startup is never cached.
      const client = new DaemonClient(`http://127.0.0.1:${daemon.port}`, tokenPath);
      const health = await client.health({ signal: AbortSignal.timeout(1000) });
      if (health?.status === "ok") return { client, health };
    }
    await delay(100);
  }
  throw new Error("packed canonical CLI did not become healthy");
}

async function withCanonicalRecall(
  backend: PackedBackend,
  label: string,
  callback: (client: DaemonClient, cwd: string) => Promise<void>,
): Promise<void> {
  const packageRoot = stagePackage(`recall-${backend}-${label}`);
  await withRecallFixture(backend, `recall-${label}`, async fixture => {
    await withPackagedDaemon(packageRoot, fixture, async daemon => {
      const { client, health } = await awaitPackedHealth(daemon, fixture);
      const identity = { status: "ok", storageBackend: backend,
        pid: daemon.pid, entrypoint: daemon.entrypoint, daemonInstanceId: health.daemonInstanceId };
      expect(health.daemonInstanceId).toEqual(expect.any(String));
      expect(health.daemonInstanceId!.length).toBeGreaterThan(0);
      expect(health).toMatchObject(identity);
      expect(readFileSync(join(fixture.homeDir, ".lcm/daemon.pid"), "utf8").trim()).toBe(String(daemon.pid));
      try {
        await callback(client, fixture.projectPath);
      } finally {
        expect(await client.health({ signal: AbortSignal.timeout(1000) })).toMatchObject(identity);
      }
    }, backend);
  });
}

const backgrounds = [
  "Copper telescope spectrometry calibration",
  "Indigo pottery kiln temperature",
  "Silver violin bowing articulation",
  "Basalt tidal turbine maintenance",
] as const;
const originalText = "quince espalier pollination orchard";

async function storeRecallMemory(client: DaemonClient, cwd: string, text: string, tags?: string[]): Promise<string> {
  const stored = await client.post<{ stored: boolean; id: string }>("/store", {
    cwd, text, ...(tags === undefined ? {} : { tags }),
  });
  expect(stored).toMatchObject({ stored: true, id: expect.any(String) });
  return stored.id;
}

async function seedRecallCorpus(client: DaemonClient, cwd: string, text: string): Promise<string> {
  for (const background of backgrounds) await storeRecallMemory(client, cwd, background);
  return storeRecallMemory(client, cwd, text, ["parity-hook-recall"]);
}

interface RecallDebugCandidate {
  id: string;
  rank: number;
  queryTermCount: number;
  matchedTermCount: number;
  lexicalScore: number;
  strongMatchBonus: number;
  wholeTextMatch: boolean;
  baseScore: number;
  finalScore: number;
}

interface RecallResponse {
  hints: string[];
  ids: string[];
  debug: {
    candidates: RecallDebugCandidate[];
    budget: { availableHintBytes: number; usedHintBytes: number; emittedCount: number;
      dedupedCount: number; droppedForBudget: number };
  };
}

async function assertCanonicalRecall(
  client: DaemonClient,
  cwd: string,
  query: string,
  queryTermCount: number,
  expected: { id: string; content: string; matchedTermCount: number; strongMatchBonus: number; surfaced: boolean }[],
): Promise<void> {
  const search = await client.post<{ episodic: unknown[]; promoted: { id: string; content: string; rank: number }[] }>(
    "/search", { cwd, query, layers: ["promoted"], limit: 10 },
  );
  expect(search.episodic).toEqual([]);
  expect(search.promoted.map(row => row.id).sort()).toEqual(expected.map(row => row.id).sort());
  for (const row of expected) expect(search.promoted.find(result => result.id === row.id)?.content).toBe(row.content);
  const requestsStarted = Date.now();
  const responses: RecallResponse[] = [];
  for (const session_id of [undefined, "parity-prompt-route"]) {
    const response = await client.post<RecallResponse>("/prompt-search", {
      cwd, query, ...(session_id === undefined ? {} : { session_id }), debug: true, logSurfacing: false,
    });
    responses.push(response);
    const surfaced = expected.filter(row => row.surfaced);
    expect(response.ids).toEqual(surfaced.map(row => row.id));
    expect(response.hints).toEqual(surfaced.map(row => row.content));
    expect(response.hints).toHaveLength(response.ids.length);
    expect(response.debug.budget).toMatchObject({
      availableHintBytes: 1024, emittedCount: surfaced.length, dedupedCount: 0, droppedForBudget: 0,
    });
    expect(response.debug.budget.usedHintBytes).toBeLessThanOrEqual(1024);
    expect(response.debug.candidates).toHaveLength(expected.length);
    for (const row of expected) {
      const candidate = response.debug.candidates.find(result => result.id === row.id)!;
      const lexicalScore = row.matchedTermCount + row.strongMatchBonus;
      expect(candidate).toMatchObject({
        id: row.id, queryTermCount, matchedTermCount: row.matchedTermCount,
        lexicalScore, strongMatchBonus: row.strongMatchBonus, wholeTextMatch: row.strongMatchBonus > 0,
        rank: search.promoted.find(result => result.id === row.id)!.rank,
        usageCount: 0, surfacingCount: 0, lastSurfacedAt: null, cooledDown: false,
        usageBoost: 1, unusedPenalty: 0, stalePenalty: 0, surfaced: row.surfaced,
      });
      expect(candidate.finalScore).toBe(candidate.baseScore);
      expect(candidate.baseScore).toBeLessThanOrEqual(lexicalScore * (session_id === undefined ? 1 : 0.85));
      expect(candidate.baseScore).toBeGreaterThanOrEqual(lexicalScore * (session_id === undefined ? 1 : 0.85) * 0.999);
    }
  }
  // The only expected difference is affinity plus measured elapsed recency.
  const ageTolerance = 1 - Math.pow(0.5, (Date.now() - requestsStarted + 1000) / (24 * 3_600_000));
  for (const candidate of responses[0].debug.candidates) {
    if (candidate.baseScore === 0) continue;
    const cross = responses[1].debug.candidates.find(row => row.id === candidate.id)!;
    expect(Math.abs(cross.baseScore / candidate.baseScore - 0.85)).toBeLessThanOrEqual(ageTolerance);
  }
}

it.each(["sqlite", "postgresql"] as const)("recalls the unchanged five-record corpus through the packed %s CLI", async backend => {
  await withCanonicalRecall(backend, "original", async (client, cwd) => {
    const id = await seedRecallCorpus(client, cwd, originalText);
    await assertCanonicalRecall(client, cwd, originalText, 4, [
      { id, content: originalText, matchedTermCount: 4, strongMatchBonus: 4, surfaced: true },
    ]);
    await assertCanonicalRecall(client, cwd, "zqxvunrelatedzz", 1, []);
  });
}, 120_000);

it.each(["sqlite", "postgresql"] as const)("recalls a single whole exact term through the packed %s CLI", async backend => {
  await withCanonicalRecall(backend, "single", async (client, cwd) => {
    const id = await seedRecallCorpus(client, cwd, "orchard");
    const expected = [{ id, content: "orchard", matchedTermCount: 1, strongMatchBonus: 4, surfaced: true }];
    await assertCanonicalRecall(client, cwd, "orchard", 1, expected);
    await assertCanonicalRecall(client, cwd, "  ORCHARD\u2003", 1, expected);
    await assertCanonicalRecall(client, cwd, "parity", 1, [
      { id, content: "orchard", matchedTermCount: 1, strongMatchBonus: 0, surfaced: false },
    ]);
    // PostgreSQL's substring fallback selects this row; SQLite FTS does not.
    // A positive public fallback rank must not manufacture native evidence.
    await assertCanonicalRecall(client, cwd, "orchar", 1, backend === "postgresql" ? [
      { id, content: "orchard", matchedTermCount: 0, strongMatchBonus: 0, surfaced: false },
    ] : []);
  });
}, 120_000);

const longPromptWords = Array.from({ length: 76 }, (_, index) =>
  `zzrecallextra${String(index + 1).padStart(4, "0")}`);

it.each(["sqlite", "postgresql"] as const)("preserves full versus partial evidence in long prompts through the packed %s CLI", async backend => {
  await withCanonicalRecall(backend, "partial-long", async (client, cwd) => {
    const full = await seedRecallCorpus(client, cwd, originalText);
    const partial = await storeRecallMemory(client, cwd, "quince unrelated");
    const terms = originalText.split(" ");
    for (const appended of [0, 36, 76]) {
      const query = [...terms, ...longPromptWords.slice(0, appended)].join(backend === "postgresql" ? " OR " : " ");
      await assertCanonicalRecall(client, cwd, query, terms.length + appended, [
        { id: full, content: originalText, matchedTermCount: 4,
          strongMatchBonus: backend === "sqlite" && appended === 0 ? 4 : 0, surfaced: true },
        { id: partial, content: "quince unrelated", matchedTermCount: 1, strongMatchBonus: 0, surfaced: false },
      ]);
    }
  });
}, 120_000);

it("preserves full Porter matches and refuses weak partials in packed SQLite short and long prompts", async () => {
  await withCanonicalRecall("sqlite", "porter", async (client, cwd) => {
    const full = await seedRecallCorpus(client, cwd, "run swim jump walk");
    const query = "running swimming jumping walking";
    const fullExpected = { id: full, content: "run swim jump walk", matchedTermCount: 4, strongMatchBonus: 0, surfaced: true };
    await assertCanonicalRecall(client, cwd, query, 4, [fullExpected]);
    const partial = await storeRecallMemory(client, cwd, "run unrelated");
    for (const appended of [0, 36, 76]) {
      await assertCanonicalRecall(client, cwd, [query, ...longPromptWords.slice(0, appended)].join(" "), 4 + appended, [
        fullExpected,
        { id: partial, content: "run unrelated", matchedTermCount: 1, strongMatchBonus: 0, surfaced: false },
      ]);
    }
    await assertCanonicalRecall(client, cwd, "running", 1, [
      { ...fullExpected, matchedTermCount: 1, surfaced: false },
      { id: partial, content: "run unrelated", matchedTermCount: 1, strongMatchBonus: 0, surfaced: false },
    ]);
  });
}, 120_000);

it("starts the installed packed CLI with PostgreSQL and all six verified migration assets", async () => {
  const packageRoot = stagePackage("pristine");
  expect(migrations).toHaveLength(6);
  expect(createHash("sha256").update(readFileSync(join(packageRoot, "dist/lcm.mjs"))).digest("hex"))
    .toBe(createHash("sha256").update(readFileSync(join(process.cwd(), "dist/lcm.mjs"))).digest("hex"));
  for (const migration of migrations) {
    expect(createHash("sha256").update(readFileSync(join(packageRoot, "dist/src/storage/postgresql/migrations", migration.filename))).digest("hex"))
      .toBe(migration.sha256);
  }
  const compiled = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    const { loadPostgreSqlMigrations } = await import(${JSON.stringify(pathToFileURL(join(packageRoot, "dist/src/storage/postgresql/migrations.js")).href)});
    const api = await import("@donadiosolutions/lcm/storage/postgresql");
    assert.equal(typeof api.createPostgreSqlStorageBackendFactory, "function");
    process.stdout.write(JSON.stringify(loadPostgreSqlMigrations().map(({id, sha256}) => ({id, checksum_sha256: sha256}))));
  `], { cwd: packageRoot, encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
  expect(compiled.status).toBe(0);
  expect(JSON.parse(compiled.stdout)).toEqual(expectedLedger);
  await withSelectedPostgreSqlProject("packed-startup", async fixture => {
    await withPackagedDaemon(packageRoot, fixture, async daemon => {
      const tokenPath = join(fixture.homeDir, ".lcm/daemon.token");
      // Recreate the client while waiting so an early missing token is not cached.
      let exited = false;
      void daemon.closed.then(() => { exited = true; });
      const readiness = (async () => {
        for (let attempt = 0; attempt < 150 && !exited; attempt += 1) {
          if (daemon.started() && existsSync(tokenPath)) {
            const health = await new DaemonClient(`http://127.0.0.1:${daemon.port}`, tokenPath)
              .health({ signal: AbortSignal.timeout(1000) });
            if (health?.status === "ok") return health;
          }
          await delay(100);
        }
        return null;
      })();
      const health = await readiness;
      expect(health, "installed CLI must become healthy before exiting").toMatchObject({
        status: "ok", storageBackend: "postgresql", pid: daemon.pid, entrypoint: daemon.entrypoint,
      });
      expect(readFileSync(join(fixture.homeDir, ".lcm/daemon.pid"), "utf8").trim()).toBe(String(daemon.pid));
      const ledger = await fixture.administrator.query<{ id: string; checksum_sha256: string }>({
        text: "SELECT id, checksum_sha256 FROM lcm.schema_migrations ORDER BY id",
      }, { domain: "factory", operation: "verifyPackagedMigrationLedger" });
      expect(ledger.rows).toEqual(expectedLedger);
    });
  });
}, 120_000);


it.each(["missing-file", "tampered-file", "missing-directory-with-source"] as const)(
  "refuses %s in an owned installation without listening or SQLite fallback",
  async corruption => {
    const packageRoot = stagePackage(corruption);
    const migrationDirectory = join(packageRoot, "dist/src/storage/postgresql/migrations");
    const firstMigration = join(migrationDirectory, migrations[0].filename);
    if (corruption === "missing-file") rmSync(firstMigration);
    else if (corruption === "tampered-file") appendFileSync(firstMigration, "\n-- changed after packaging\n");
    else {
      const sourceDirectory = join(packageRoot, "src/storage/postgresql/migrations");
      cpSync(migrationDirectory, sourceDirectory, { recursive: true });
      for (const migration of migrations) {
        expect(createHash("sha256").update(readFileSync(join(sourceDirectory, migration.filename))).digest("hex"))
          .toBe(migration.sha256);
      }
      rmSync(migrationDirectory, { recursive: true });
    }
    await withSelectedPostgreSqlProject(`packed-${corruption}`, async fixture => {
      await withPackagedDaemon(packageRoot, fixture, async daemon => {
        let exited = false;
        void daemon.closed.then(() => { exited = true; });
        let listened = false;
        while (!exited) {
          listened = await isListening(daemon.port) || listened;
          await delay(50);
        }
        expect(await daemon.closed).toEqual({ code: 1, signal: null });
        expect(daemon.started()).toBe(false);
        expect(listened).toBe(false);
        expect(await new DaemonClient(`http://127.0.0.1:${daemon.port}`, join(fixture.homeDir, ".lcm/daemon.token"))
          .health({ signal: AbortSignal.timeout(1000) })).toBeNull();
      });
    });
  }, 120_000,
);
