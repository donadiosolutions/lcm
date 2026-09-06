import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { collectStats, StatsUnavailableError } from "../src/stats.js";

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
