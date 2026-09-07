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
import { DaemonClient } from "../../src/daemon/client.js";
import { loadPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import { assertHarnessReady } from "./harness.js";
import { withSelectedPostgreSqlProject, type SelectedPostgreSqlProject } from "./operational-fixture.js";

const migrations = loadPostgreSqlMigrations();
const expectedLedger = migrations.map(({ id, sha256 }) => ({ id, checksum_sha256: sha256 }));
let scratch: string;
let tarball: string;

beforeAll(async () => {
  await assertHarnessReady();
  scratch = mkdtempSync(join(tmpdir(), "lcm-pg-packed-startup-"));
  const filename = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", scratch], {
    cwd: process.cwd(), encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024,
  }).trim();
  expect(filename).toMatch(/^donadiosolutions-lcm-[A-Za-z0-9.+-]+\.tgz$/u);
  tarball = join(scratch, filename);
}, 120_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, 120_000);

function stagePackage(label: string): string {
  const directory = join(scratch, label);
  stagePortableArtifact(tarball, directory);
  return join(directory, "node_modules/@donadiosolutions/lcm");
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

/** Execute the installed CLI, keeping diagnostics bounded and out of runner logs. */
async function withPackagedDaemon(
  packageRoot: string,
  fixture: SelectedPostgreSqlProject,
  callback: (daemon: {
    port: number;
    pid: number;
    entrypoint: string;
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    started: () => boolean;
  }) => Promise<void>,
): Promise<void> {
  const port = await unusedPort();
  setConfigValue({ configPath: join(fixture.homeDir, ".lcm/config.json"), path: "daemon.port", value: String(port), json: true });
  const entrypoint = join(packageRoot, "dist/lcm.mjs");
  const environment: NodeJS.ProcessEnv = {
    ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir,
    XDG_CONFIG_HOME: join(fixture.homeDir, ".config"),
    XDG_CACHE_HOME: join(fixture.homeDir, ".cache"),
    XDG_STATE_HOME: join(fixture.homeDir, ".local/state"),
    XDG_RUNTIME_DIR: join(fixture.homeDir, ".runtime"),
    TMPDIR: join(fixture.homeDir, "tmp"),
  };
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) {
    mkdirSync(environment[name]!, { recursive: true, mode: 0o700 });
  }
  delete environment.NODE_PATH;
  const child = spawn(process.execPath, [entrypoint, "daemon", "start", "--foreground"], {
    cwd: fixture.projectPath, env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let bytes = 0;
  let overflow = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { overflow = true; child.kill("SIGKILL"); }
      else output += chunk.toString();
    });
  }
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    expect(child.pid).toBeTypeOf("number");
    await callback({ port, pid: child.pid!, entrypoint, closed,
      started: () => output.includes(`lcm daemon started on port ${port}`) });
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const backstop = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await closed; } finally { clearTimeout(backstop); }
    expect(overflow).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
    expect(await isListening(port)).toBe(false);
    expect(existsSync(join(fixture.homeDir, ".lcm/daemon.pid"))).toBe(false);
    assertNoSqlite(fixture.homeDir);
    assertNoSqlite(fixture.projectRoot);
  }
}

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
