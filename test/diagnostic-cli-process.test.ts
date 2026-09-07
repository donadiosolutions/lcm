import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";

let root: string;
let executable: string;
function witness(path: string): unknown {
  const stat = lstatSync(path, { bigint: true });
  return stat.isDirectory()
    ? Object.fromEntries(readdirSync(path).sort().map(name => [name, witness(join(path, name))]))
    : { bytes: readFileSync(path).toString("hex"), inode: stat.ino, mtime: stat.mtimeNs };
}
function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: home, encoding: "utf8", timeout: 15_000,
    env: { PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), TMPDIR: home, NODE_NO_WARNINGS: "1" },
  });
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lcm-diagnostic-package-"));
  executable = join(root, "package", "dist", "lcm.mjs");
  mkdirSync(join(root, "package", "dist"), { recursive: true });
  writeFileSync(join(root, "package", "package.json"), readFileSync(resolve("package.json")));
  buildSync({ entryPoints: [resolve("bin/lcm.ts")], outfile: executable,
    bundle: true, platform: "node", format: "esm", target: "node22",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  buildSync({ entryPoints: [resolve("src/db/diagnostic-sqlite-worker.ts")], outfile: join(root, "package", "dist", "src", "db", "diagnostic-sqlite-worker.js"), platform: "node", format: "esm", target: "node22" });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe("packaged diagnostic process observation", () => {
  it("leaves a legacy home and authority state unchanged for every diagnostic command", () => {
    const home = join(root, "legacy-home");
    mkdirSync(join(home, ".lossless-claude"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".lossless-claude", "config.json"), '{"legacy":"unchanged-canary"}', { mode: 0o600 });
    const before = witness(home);
    for (const args of [["stats", "--json"], ["stats", "--pool", "--json"], ["status", "--json"], ["doctor"]]) {
      const result = run(home, args);
      expect(result.error).toBeUndefined();
      expect([0, 1]).toContain(result.status);
      expect(result.stdout + result.stderr).not.toContain("unchanged-canary");
      expect(witness(home), args.join(" ") + " output=" + result.stdout + result.stderr).toEqual(before);
    }
  });
  it("reads committed live WAL rows through the packaged child without changing the database", async () => {
    const home = join(root, "wal-home");
    const project = join(home, ".lcm", "projects", "a".repeat(64));
    mkdirSync(project, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".lcm", "config.json"), "{}", { mode: 0o600 });
    const path = join(project, "db.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    runLcmMigrations(db);
    const store = new ConversationStore(db);
    const conversation = await store.getOrCreateConversation("packaged-diagnostic");
    await store.createMessagesBulk([{ conversationId: conversation.conversationId, seq: 0, role: "user", content: "never-display-transcript-canary", tokenCount: 7 }]);
    const before = witness(path);
    try {
      const result = run(home, ["stats", "--json"]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const stats = JSON.parse(result.stdout);
      expect(stats.messages).toBe(1);
      expect(stats.backendDiagnostics.classification).toBe("healthy");
      expect(result.stdout).not.toContain("never-display-transcript-canary");
      expect(witness(path)).toEqual(before);
    } finally { db.close(); }
  });
});
