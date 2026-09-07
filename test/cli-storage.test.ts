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
import { PrivateMutationLockContentionError, withPrivateMutationLock, withPrivateMutationLockAsync } from "../src/private-mutation-lock.js";
import { createPublicationConvergence } from "../src/storage/publication-convergence.js";
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
    let factoryCloses = 0;
    vi.spyOn(factoryModule,"createStorageBackendFactory").mockImplementation(async (...args) => {
      const factory = await realCreate(...args);
      const close = factory.close.bind(factory);
      vi.spyOn(factory,"close").mockImplementation(async () => { await close(); factoryCloses++; throw new Error("CANARY cleanup"); });
      return factory;
    });
    await expect(withCliProjectStorage(cwd,{create:true},async ({storage}) => {
      const close=storage.close.bind(storage);
      vi.spyOn(storage,"close").mockImplementation(async () => { await close(); throw new Error("CANARY close"); });
      throw primary;
    })).rejects.toBe(primary);
    expect(factoryCloses).toBe(1);
    await expect(withCliProjectStorage(cwd,{create:false},async () => true))
      .rejects.toThrow("LCM storage could not be closed.");
  });
  it.each([false, true])("holds publication authority through work and both closes (failure=%s)", async (fail) => {
    const lockPath = join(home, ".lcm.backend-publication.lock");
    const primary = new Error("callback failure");
    const phases: string[] = [];
    const assertPublisherBlocked = async (phase: string) => {
      await Promise.resolve();
      expect(() => withPrivateMutationLock(lockPath, "backend publication", () => {
        writeFileSync(join(home, "published"), phase);
      })).toThrow(PrivateMutationLockContentionError);
      expect(existsSync(join(home, "published"))).toBe(false);
      phases.push(phase);
    };
    const realCreate = factoryModule.createStorageBackendFactory;
    vi.spyOn(factoryModule, "createStorageBackendFactory").mockImplementation(async (...args) => {
      const factory = await realCreate(...args);
      const close = factory.close.bind(factory);
      vi.spyOn(factory, "close").mockImplementation(async () => {
        await assertPublisherBlocked("factory close");
        await close();
      });
      return factory;
    });
    const operation = withCliProjectStorage(cwd, { create: true }, async ({ storage }) => {
      const close = storage.close.bind(storage);
      vi.spyOn(storage, "close").mockImplementation(async () => {
        await assertPublisherBlocked("storage close");
        await close();
      });
      await assertPublisherBlocked("callback");
      await storage.conversations.getOrCreateConversation("committed");
      if (fail) throw primary;
      return "done";
    });
    if (fail) await expect(operation).rejects.toBe(primary);
    else await expect(operation).resolves.toBe("done");
    expect(phases).toEqual(["callback", "storage close", "factory close"]);
    expect(withPrivateMutationLock(lockPath, "backend publication", () => "published")).toBe("published");
    expect(await withCliProjectStorage(cwd, {}, async ({ storage }) =>
      (await storage.conversations.listConversations()).map(row => row.sessionId))).toEqual(["committed"]);
  });

  it.each(["callback", "storage close", "factory close"])("checks publication evidence after %s and closes once", async (phase) => {
    let storageCloses = 0;
    let factoryCloses = 0;
    const invalidatePublication = () => mkdirSync(join(home, ".lcm", "backend-publication"), { mode: 0o700 });
    const realCreate = factoryModule.createStorageBackendFactory;
    vi.spyOn(factoryModule, "createStorageBackendFactory").mockImplementation(async (...args) => {
      const factory = await realCreate(...args);
      const close = factory.close.bind(factory);
      vi.spyOn(factory, "close").mockImplementation(async () => {
        factoryCloses++;
        await close();
        if (phase === "factory close") invalidatePublication();
      });
      return factory;
    });
    let path = "";
    await expect(withCliProjectStorage(cwd, { create: true }, async ({ storage, project }) => {
      path = project.dbPath;
      const close = storage.close.bind(storage);
      vi.spyOn(storage, "close").mockImplementation(async () => {
        storageCloses++;
        await close();
        if (phase === "storage close") invalidatePublication();
      });
      if (phase === "callback") invalidatePublication();
      return "must not report success";
    })).rejects.toBeInstanceOf(publicationModule.BackendPublicationJournalError);
    expect(storageCloses).toBe(1);
    expect(factoryCloses).toBe(1);
    expect(isLcmConnectionOpen(path)).toBe(false);
  });

  function convergence(sleep: (ms: number) => Promise<void>, syntheticOwner = false) {
    const identity = {
      pid: process.pid, version: "1.0.0", storageBackend: "sqlite" as const,
      entrypoint: "/opt/lcm.mjs", runtimeDigest: "a".repeat(64),
    };
    let now = 0;
    return createPublicationConvergence({
      port: 3737, identity,
      deps: {
        homeDir: home, now: () => now,
        readToken: () => "fixture-token",
        ...(syntheticOwner ? {
          readOwner: () => ({ version: 1 as const, pid: process.pid, processStartTime: "birth", nonce: "a".repeat(32) }),
          processBirth: () => "birth",
        } : {}),
        fetch: async () => new Response(JSON.stringify({ status: "ok", ...identity })),
        sleep: async ms => { now += ms; await sleep(ms); },
      },
    });
  }

  it("retries contended admission before preparing or opening storage", async () => {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const publisher = withPrivateMutationLockAsync(join(home, ".lcm.backend-publication.lock"), "backend publication", () => released);
    let prepared = 0;
    let invoked = 0;
    let sleeps = 0;
    const retry = convergence(async () => {
      sleeps++;
      expect(prepared).toBe(0);
      expect(invoked).toBe(0);
      expect(existsSync(join(home, ".lcm", "projects"))).toBe(false);
      writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({ daemon: { port: 4321 } }), { mode: 0o600 });
      release();
      await publisher;
    });
    try {
      await expect(withCliProjectStorage(cwd, {
        create: true, _publicationConvergence: retry,
        prepare: async ({ config }) => { prepared++; expect(config.daemon.port).toBe(4321); },
      }, async ({ storage }) => {
        invoked++;
        await storage.conversations.getOrCreateConversation("once");
        return "admitted";
      })).resolves.toBe("admitted");
    } finally {
      release();
      await publisher;
    }
    expect(sleeps).toBe(1);
    expect(prepared).toBe(1);
    expect(invoked).toBe(1);
  });

  it.each(["prepare", "open", "callback", "post-check"])("does not replay admitted work after %s contention", async (phase) => {
    const contention = new PrivateMutationLockContentionError("post-admission contention");
    let prepared = 0;
    let opened = 0;
    let invoked = 0;
    let storageCloses = 0;
    let factoryCloses = 0;
    // Authenticate a potential retry even after the operation has released its lock.
    const retry = convergence(async () => undefined, true);
    const realLock = publicationModule.withBackendPublicationConsumerLockAsync;
    vi.spyOn(publicationModule, "withBackendPublicationConsumerLockAsync").mockImplementation(async (...args) => {
      const result = await realLock(...args);
      if (phase === "post-check") throw contention;
      return result;
    });
    const realCreate = factoryModule.createStorageBackendFactory;
    vi.spyOn(factoryModule, "createStorageBackendFactory").mockImplementation(async (...args) => {
      const factory = await realCreate(...args);
      const open = factory.openProject.bind(factory);
      vi.spyOn(factory, "openProject").mockImplementation(async (...openArgs) => {
        opened++;
        if (phase === "open") throw contention;
        const storage = await open(...openArgs);
        const close = storage.close.bind(storage);
        vi.spyOn(storage, "close").mockImplementation(async () => { storageCloses++; await close(); });
        return storage;
      });
      const close = factory.close.bind(factory);
      vi.spyOn(factory, "close").mockImplementation(async () => { factoryCloses++; await close(); });
      return factory;
    });
    await expect(withCliProjectStorage(cwd, {
      create: true, _publicationConvergence: retry,
      prepare: async () => { prepared++; if (phase === "prepare") throw contention; },
    }, async ({ storage }) => {
      invoked++;
      await storage.conversations.getOrCreateConversation(`effect-${invoked}`);
      if (phase === "callback") throw contention;
      return "committed";
    })).rejects.toBe(contention);
    expect(prepared).toBe(1);
    expect(opened).toBe(phase === "prepare" ? 0 : 1);
    expect(invoked).toBe(phase === "prepare" || phase === "open" ? 0 : 1);
    expect(storageCloses).toBe(invoked);
    expect(factoryCloses).toBe(phase === "prepare" ? 0 : 1);
    vi.restoreAllMocks();
    if (invoked !== 0) {
      expect(await withCliProjectStorage(cwd, {}, async ({ storage }) =>
        (await storage.conversations.listConversations()).map(row => row.sessionId))).toEqual(["effect-1"]);
    }
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
