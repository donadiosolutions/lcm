import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { collectStats, StatsUnavailableError } from "../src/stats.js";

const forkCount = vi.hoisted(() => ({ value: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, fork: (...args: Parameters<typeof original.fork>) => {
    forkCount.value++;
    return original.fork(...args);
  } };
});
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, {recursive:true,force:true}); });

function fixture(): { home: string; root: string; database: string } {
  const home = mkdtempSync(join(tmpdir(), "lcm-stats-observation-"));
  homes.push(home);
  chmodSync(home, 0o700);
  const root = join(home, ".lcm");
  for (const directory of [root, join(root,"projects"),join(root,"projects","a".repeat(64)),join(root,"events")]) mkdirSync(directory,{mode:0o700});
  writeFileSync(join(root,"config.json"),"{}\n",{mode:0o600});
  const database = join(root,"projects","a".repeat(64),"db.sqlite");
  const db = new DatabaseSync(database);
  runLcmMigrations(db);
  db.exec("INSERT INTO conversations(conversation_id,session_id) VALUES (1,'private-session'); INSERT INTO messages(conversation_id,seq,role,content,token_count) VALUES (1,1,'user','private-message',4)");
  db.close();
  return {home,root,database};
}

function witness(path: string): unknown {
  const stat = statSync(path, { bigint:true });
  if (stat.isDirectory()) return Object.fromEntries(readdirSync(path).filter(name=>!name.endsWith("-wal")&&!name.endsWith("-shm")).map(name=>[name,witness(join(path,name))]));
  return {bytes:readFileSync(path).toString("base64"),inode:stat.ino,mtime:stat.mtimeNs};
}

describe("integrated diagnostic observation", () => {
  it("uses the configured home and leaves authority and main database witnesses unchanged", async () => {
    const {home,root}=fixture();
    const before=witness(root);
    const result=await collectStats({homeDir:home});
    expect(result).toMatchObject({projects:1,messages:1,backendDiagnostics:{backend:"sqlite",classification:"healthy",schema:"ready",outbox:{status:"ready"}}});
    expect(JSON.stringify(result)).not.toMatch(/private-message|private-session/);
    expect(witness(root)).toEqual(before);
  });

  it.each([40, 100])("collects all %i synthetic projects and sidecars within the whole snapshot deadline", async count => {
    const {home, root, database} = fixture();
    rmSync(join(root, "projects", "a".repeat(64)), {recursive:true});
    // Every database is generated here; no host or user database is copied.
    const template = new DatabaseSync(database.replace("a".repeat(64) + "/db.sqlite", "template.sqlite"));
    runLcmMigrations(template);
    template.exec("INSERT INTO conversations(conversation_id,session_id) VALUES (1,'synthetic'); INSERT INTO messages(conversation_id,seq,role,content,token_count) VALUES (1,1,'user','synthetic',4)");
    template.close();
    const templatePath = join(root, "projects", "template.sqlite");
    for (let index = 0; index < count; index++) {
      const id = index.toString(16).padStart(64, "0");
      mkdirSync(join(root, "projects", id), {mode:0o700});
      copyFileSync(templatePath, join(root, "projects", id, "db.sqlite"));
      const sidecar = new DatabaseSync(join(root, "events", id + ".db"));
      sidecar.exec(`CREATE TABLE events(created_at TEXT, processed_at TEXT, delivery_state TEXT, remote_inbox_id TEXT, remote_pruned_at TEXT);
        CREATE TABLE error_log(created_at TEXT, hook TEXT);
        INSERT INTO events VALUES ('2026-09-01', NULL, 'pending', NULL, NULL)`);
      sidecar.close();
    }
    rmSync(templatePath);
    const before = witness(root);
    forkCount.value = 0;
    const started = performance.now();
    const result = await collectStats({homeDir:home});
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({projects:count,messages:count,eventsCaptured:count,
      backendDiagnostics:{classification:"healthy",outbox:{status:"ready",captured:count}}});
    expect(forkCount.value).toBe(1);
    expect(witness(root)).toEqual(before);
  });

  it("observes zero local events when the optional events directory is absent", async () => {
    const {home,root}=fixture();
    rmSync(join(root,"events"),{recursive:true});
    const before=witness(root);
    const result=await collectStats({homeDir:home});
    expect(result).toMatchObject({messages:1,eventsCaptured:0,backendDiagnostics:{classification:"healthy",outbox:{status:"ready"}}});
    expect(witness(root)).toEqual(before);
  });

  it("reports a missing project as unavailable without creating any state", async () => {
    const {home,root}=fixture();
    const before=witness(root);
    const result=await collectStats({homeDir:home,projectId:"b".repeat(64)}).catch(error=>error);
    expect(result).toBeInstanceOf(StatsUnavailableError);
    expect(result.diagnostics.classification).toBe("unavailable");
    expect(witness(root)).toEqual(before);
  });
});
