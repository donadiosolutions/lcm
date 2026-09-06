import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { withCliProjectStorage, listCliProjects } from "../src/cli-storage.js";
import { clearProjectMapCache, addProjectAlias } from "../src/project-map.js";
import { clearWorktreeReconciliationCache } from "../src/worktree-reconciliation.js";
import * as factoryModule from "../src/storage/factory.js";
import * as configModule from "../src/daemon/config.js";
import * as publicationModule from "../src/storage/backend-publication.js";
import * as projectModule from "../src/daemon/project.js";
import { SqliteStorageBackendFactory } from "../src/storage/sqlite/factory.js";
import { hashProjectPath } from "../src/project-map.js";
import { isLcmConnectionOpen } from "../src/db/connection.js";

describe("CLI selected project storage", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-cli-storage-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    cwd = join(home, "project");
    mkdirSync(cwd);
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    rmSync(home, { recursive: true, force: true });
  });
  it("creates selected SQLite storage, preserves data, and closes handles", async () => {
    const path = await withCliProjectStorage(cwd, { create: true }, async ({storage, project}) => {
      await storage.conversations.getOrCreateConversation("session");
      return project.dbPath;
    });
    expect(existsSync(path)).toBe(true);
    expect(isLcmConnectionOpen(path)).toBe(false);
    expect(await withCliProjectStorage(cwd, { create: false }, async ({storage}) =>
      (await storage.conversations.listConversations()).map(row => row.sessionId)))
      .toEqual(["session"]);
  });
  it("does not create a missing database on existing-only access", async () => {
    await expect(withCliProjectStorage(cwd, {create:false}, async () => true)).rejects.toThrow("No LCM storage");
    expect(await listCliProjects()).toHaveLength(1);
  });
  it("prepares before opening and closes after a callback failure", async () => {
    const failure = new Error("callback failure");
    await expect(withCliProjectStorage(cwd, {create:true, prepare:async () => { throw failure; }}, async () => true))
      .rejects.toBe(failure);
    let path = "";
    await expect(withCliProjectStorage(cwd, {create:true}, async ({project}) => {
      path = project.dbPath;
      throw failure;
    })).rejects.toBe(failure);
    expect(isLcmConnectionOpen(path)).toBe(false);
  });
  it("enumerates map-backed canonical projects once across aliases", async () => {
    await withCliProjectStorage(cwd, {create:true}, async () => undefined);
    mkdirSync(join(home, "alias"));
    addProjectAlias(join(home, "alias"), { canonical: cwd });
    const projects = await listCliProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.canonical).toBe(cwd);
  });
  it("attempts both closes and preserves a callback error when cleanup fails", async () => {
    const primary = new Error("primary");
    const realCreate = factoryModule.createStorageBackendFactory;
    let factoryClosed = false;
    vi.spyOn(factoryModule,"createStorageBackendFactory").mockImplementation(async (...args) => {
      const factory = await realCreate(...args);
      const close = factory.close.bind(factory);
      vi.spyOn(factory,"close").mockImplementation(async () => { await close(); factoryClosed=true; throw new Error("CANARY cleanup"); });
      return factory;
    });
    await expect(withCliProjectStorage(cwd,{create:true},async ({storage}) => {
      const close=storage.close.bind(storage);
      vi.spyOn(storage,"close").mockImplementation(async () => { await close(); throw new Error("CANARY close"); });
      throw primary;
    })).rejects.toBe(primary);
    expect(factoryClosed).toBe(true);
    await expect(withCliProjectStorage(cwd,{create:false},async () => true))
      .rejects.toThrow("LCM storage could not be closed.");
  });
  it("refuses PG custom local paths and absent remote projects without creating SQLite", async () => {
    const config=configModule.loadDaemonConfig(join(home,".lcm","config.json"));
    vi.spyOn(configModule,"loadDaemonConfig").mockReturnValue({...config,storage:{...config.storage,backend:"postgresql"}});
    vi.spyOn(publicationModule,"assertBackendPublicationConsumerAccess").mockReturnValue(undefined);
    await expect(withCliProjectStorage(cwd,{create:true,_lcmBaseDir:join(home,"other")},async () => true))
      .rejects.toThrow("Custom local storage paths are unavailable");
    expect(existsSync(join(home,"other"))).toBe(false);
    vi.spyOn(projectModule,"projectIdentity").mockReturnValue({id:"remote",localProjectId:hashProjectPath(cwd),canonical:cwd});
    const factory=new SqliteStorageBackendFactory();
    vi.spyOn(factory,"openExistingProject").mockResolvedValue(null);
    vi.spyOn(factory,"close").mockRejectedValue(new Error("CANARY close"));
    vi.spyOn(factoryModule,"createStorageBackendFactory").mockResolvedValue(factory);
    await expect(withCliProjectStorage(cwd,{create:true},async () => true))
      .rejects.toThrow("The bound PostgreSQL project is unavailable.");
    expect(existsSync(join(home,".lcm","projects",hashProjectPath(cwd),"db.sqlite"))).toBe(false);
  });

  it("deduplicates a stale linked-worktree binding only when its old database is absent", async () => {
    const git=(...args:string[])=>execFileSync("git",args,{cwd,stdio:"ignore"});
    git("init","-q");
    git("config","user.email","test@example.invalid");
    git("config","user.name","test");
    git("commit","--allow-empty","-qm","init");
    const linked=join(home,"linked");
    git("worktree","add","-qb","linked",linked);
    await withCliProjectStorage(cwd,{create:true},async () => undefined);
    const id=hashProjectPath(cwd), legacyId=hashProjectPath(linked);
    writeFileSync(join(home,".lcm","map.json"),JSON.stringify({
      [id]:{canonical:cwd,aliases:[]},[legacyId]:{canonical:linked,aliases:[]},
    }),{mode:0o600});
    clearProjectMapCache();
    const listed=await listCliProjects();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.aliases).toContain(linked);
    const legacyDir=join(home,".lcm","projects",legacyId);
    mkdirSync(legacyDir,{mode:0o700});
    writeFileSync(join(legacyDir,"db.sqlite"),"legacy data",{mode:0o600});
    await expect(listCliProjects()).rejects.toThrow("Legacy worktree storage requires reconciliation");
    rmSync(join(legacyDir,"db.sqlite"));
    rmSync(join(home,".lcm","projects",id,"meta.json"));
    writeFileSync(join(home,".lcm","map.json"),JSON.stringify({
      [legacyId]:{canonical:linked,aliases:[]},
    }),{mode:0o600});
    clearProjectMapCache();
    expect((await listCliProjects())[0]?.id).toBe(legacyId);
    writeFileSync(join(home,".lcm","map.json"),JSON.stringify({
      [id]:{canonical:cwd,aliases:[],remoteProjectId:"01940000-0000-7000-8000-000000000001"},
      [legacyId]:{canonical:linked,aliases:[],remoteProjectId:"01940000-0000-7000-8000-000000000002"},
    }),{mode:0o600});
    clearProjectMapCache();
    await expect(listCliProjects()).rejects.toThrow("Legacy worktree storage has a conflicting remote project binding");
  });

});
