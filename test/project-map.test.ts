import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  addProjectAlias,
  clearRemoteProjectBinding,
  clearProjectMapCache,
  hashProjectPath,
  listProjectMapEntries,
  normalizeProjectPath,
  oldMapsDir,
  projectMapPathsForHash,
  projectMapPath,
  projectMapEntryHasStoredData,
  isProjectHash,
  reloadProjectMapCache,
  removeProjectAlias,
  resolveProjectIdentity,
  setRemoteProjectBinding,
  showProjectMapEntry,
  validateProjectMap,
  watchProjectMap,
} from "../src/project-map.js";
import { eventsDbPath } from "../src/db/events-path.js";
import { projectDbPath, projectId, projectMetaPath } from "../src/daemon/project.js";

function resetLcmHome(): void {
  rmSync(join(homedir(), ".lcm"), { recursive: true, force: true });
  mkdirSync(join(homedir(), ".lcm"), { recursive: true });
  clearProjectMapCache();
}

function makeDir(name: string): string {
  const path = join(homedir(), name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("project map", () => {
  const remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-project-map-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    resetLcmHome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearProjectMapCache();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("auto-creates a formatted canonical entry for a newly seen project path", () => {
    const canonical = makeDir("canonical");
    const identity = resolveProjectIdentity(canonical);
    const content = readFileSync(projectMapPath(), "utf-8");

    expect(identity.id).toMatch(/^[a-f0-9]{64}$/);
    expect(content).toBe(JSON.stringify({
      [identity.id]: { canonical: normalizeProjectPath(canonical), aliases: [] },
    }, null, 2) + "\n");
  });

  it("does not lose a concurrent remote binding while auto-creating an entry", () => {
    const canonical = makeDir("automatic-entry-binding-race");

    const resolved = resolveProjectIdentity(canonical, {
      _beforeMissingEntryLockForTesting: () => {
        const concurrent = resolveProjectIdentity(canonical);
        setRemoteProjectBinding(remoteProjectId, { hash: concurrent.id });
      },
    });

    expect(resolved.remoteProjectId).toBe(remoteProjectId);
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBe(remoteProjectId);
    expect(listProjectMapEntries()[resolved.id].remoteProjectId).toBe(remoteProjectId);
  });

  it("resolves canonical and alias paths to the same project paths", () => {
    const canonical = makeDir("canonical");
    const alias = makeDir("alias");
    const canonicalId = projectId(canonical);

    addProjectAlias(alias, { canonical });

    expect(projectId(alias)).toBe(canonicalId);
    expect(projectDbPath(alias)).toBe(projectDbPath(canonical));
    expect(projectMetaPath(alias)).toBe(projectMetaPath(canonical));
    expect(eventsDbPath(alias)).toBe(eventsDbPath(canonical));
  });

  it("evolves legacy entries with an optional remote UUID without changing the local hash", () => {
    const canonical = makeDir("remote-binding");
    const local = resolveProjectIdentity(canonical);

    const bound = setRemoteProjectBinding(remoteProjectId.toUpperCase(), { canonical });

    expect(bound).toMatchObject({ hash: local.id, changed: true });
    expect(bound.entry.remoteProjectId).toBe(remoteProjectId);
    expect(showProjectMapEntry(remoteProjectId.toUpperCase()).hash).toBe(local.id);
    expect(resolveProjectIdentity(canonical)).toEqual({
      ...local,
      remoteProjectId,
    });
    expect(setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toMatchObject({ hash: local.id, changed: false });
    expect(isProjectHash(local.id)).toBe(true);
    expect(isProjectHash(remoteProjectId)).toBe(false);
  });

  it("clears only the remote binding while retaining the local entry", () => {
    const canonical = makeDir("remote-unlink");
    const local = resolveProjectIdentity(canonical);
    setRemoteProjectBinding(remoteProjectId, { canonical });

    const cleared = clearRemoteProjectBinding(canonical, remoteProjectId);

    expect(cleared).toMatchObject({
      hash: local.id,
      remoteProjectId,
      changed: true,
    });
    expect(cleared.entry.remoteProjectId).toBeUndefined();
    expect(() => clearRemoteProjectBinding(canonical, remoteProjectId))
      .toThrow(`project ${local.id} remote binding changed; expected ${remoteProjectId}`);
    expect(resolveProjectIdentity(canonical)).toEqual(local);
  });

  it("fails closed when a remote UUID ambiguously names multiple local entries", () => {
    const first = makeDir("remote-ambiguous-first");
    const second = makeDir("remote-ambiguous-second");
    const firstHash = hashProjectPath(first);
    const secondHash = hashProjectPath(second);
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [], remoteProjectId },
      [secondHash]: { canonical: second, aliases: [], remoteProjectId },
    }));

    expect(() => showProjectMapEntry(remoteProjectId.toUpperCase()))
      .toThrow("maps to multiple local hashes");
  });

  it("reports an unknown remote UUID target without treating it as a path", () => {
    expect(() => showProjectMapEntry(remoteProjectId))
      .toThrow(`unknown remote project UUIDv7: ${remoteProjectId}`);
  });

  it("serializes remote binding mutations with a private exclusive lock", () => {
    const canonical = makeDir("remote-lock");
    const local = resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    let nestedError: unknown;
    let liveOwner = "";

    const bound = setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _afterLockForTesting: () => {
        expect(statSync(lockPath).mode & 0o777).toBe(0o600);
        liveOwner = readFileSync(lockPath, "utf8");
        try {
          setRemoteProjectBinding(remoteProjectId, { canonical });
        } catch (error) {
          nestedError = error;
        }
      },
    });

    expect(bound).toMatchObject({ hash: local.id, changed: true });
    expect(nestedError).toBeInstanceOf(Error);
    expect((nestedError as Error).message).toContain("project map mutation is already in progress");
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, liveOwner, { mode: 0o600 });
    expect(() => clearRemoteProjectBinding(canonical, remoteProjectId))
      .toThrow(`owned by live PID ${process.pid}`);
    rmSync(lockPath);

    const ambiguousOwner = JSON.parse(liveOwner) as Record<string, unknown>;
    ambiguousOwner.processStartTime = null;
    ambiguousOwner.nonce = "c".repeat(32);
    writeFileSync(lockPath, `${JSON.stringify(ambiguousOwner)}\n`, { mode: 0o600 });
    expect(() => clearRemoteProjectBinding(canonical, remoteProjectId))
      .toThrow("owner state is ambiguous");
    rmSync(lockPath);

    writeFileSync(lockPath, "", { mode: 0o600 });
    expect(() => clearRemoteProjectBinding(canonical, remoteProjectId))
      .toThrow("project map lock is malformed");
    expect(listProjectMapEntries()[local.id].remoteProjectId).toBe(remoteProjectId);
  });

  it("publishes a complete lock owner atomically when another contender wins initialization", () => {
    const canonical = makeDir("remote-lock-publication-race");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const completeWinner = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime: null,
      nonce: "f".repeat(32),
    })}\n`;

    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: (event, path) => {
        if (event !== "before-main-lock-publish") return;
        expect(path).toBe(lockPath);
        expect(existsSync(path)).toBe(false);
        writeFileSync(path, completeWinner, { mode: 0o600 });
      },
    })).toThrow("owner state is ambiguous");
    expect(readFileSync(lockPath, "utf8")).toBe(completeWinner);
  });

  it("retries lock publication when the winning owner releases before inspection", () => {
    const canonical = makeDir("remote-lock-owner-release-race");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const winner = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime: null,
      nonce: "7".repeat(32),
    })}\n`;
    let publications = 0;

    expect(setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: (event, path) => {
        if (event === "before-main-lock-publish") {
          publications += 1;
          if (publications === 1) writeFileSync(path, winner, { mode: 0o600 });
        }
        if (event === "before-main-lock-owner-read") rmSync(path);
      },
    })).toMatchObject({ changed: true });
    expect(publications).toBe(2);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("bounds repeated lock-owner disappearance retries", () => {
    const canonical = makeDir("remote-lock-owner-release-churn");
    const local = resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const winner = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime: null,
      nonce: "8".repeat(32),
    })}\n`;
    let publications = 0;

    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: (event, path) => {
        if (event === "before-main-lock-publish") {
          publications += 1;
          writeFileSync(path, winner, { mode: 0o600 });
        }
        if (event === "before-main-lock-owner-read") rmSync(path);
      },
    })).toThrow("project map mutation lock changed repeatedly during acquisition");
    expect(publications).toBe(2);
    expect(existsSync(lockPath)).toBe(false);
    expect(listProjectMapEntries()[local.id].remoteProjectId).toBeUndefined();
  });

  it("does not retry permission failures while inspecting the winning lock", () => {
    const canonical = makeDir("remote-lock-owner-read-denied");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const winner = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime: null,
      nonce: "9".repeat(32),
    })}\n`;
    const denied = Object.assign(new Error("lock owner read denied"), { code: "EACCES" });
    let publications = 0;
    let thrown: unknown;

    try {
      setRemoteProjectBinding(remoteProjectId, {
        canonical,
        _lockObserverForTesting: (event, path) => {
          if (event === "before-main-lock-publish") {
            publications += 1;
            writeFileSync(path, winner, { mode: 0o600 });
          }
          if (event === "before-main-lock-owner-read") throw denied;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(denied);
    expect(publications).toBe(1);
    expect(readFileSync(lockPath, "utf8")).toBe(winner);
  });

  it("reclaims only dead or PID-reused map lock owners", () => {
    const canonical = makeDir("remote-stale-lock");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const lock = (pid: number, processStartTime: string | null, nonce: string): string =>
      `${JSON.stringify({ version: 1, pid, processStartTime, nonce })}\n`;

    writeFileSync(lockPath, lock(2_147_483_647, "1", "a".repeat(32)), { mode: 0o600 });
    expect(setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toMatchObject({ changed: true });
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, lock(process.pid, "definitely-not-this-process", "b".repeat(32)), { mode: 0o600 });
    expect(setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toMatchObject({ changed: false });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("never reclaims a stale generation already claimed by another contender", () => {
    const canonical = makeDir("remote-competing-reclaimer");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const nonce = "d".repeat(32);
    const stale = `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "1",
      nonce,
    })}\n`;
    writeFileSync(lockPath, stale, { mode: 0o600 });
    const claimPath = `${lockPath}.reclaim-${nonce}`;
    mkdirSync(claimPath, { mode: 0o700 });
    writeFileSync(join(claimPath, "owner.json"), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime: null,
      nonce: "e".repeat(32),
    })}\n`, { mode: 0o600 });

    expect(() => setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toThrow("reclamation is already in progress");
    expect(readFileSync(lockPath, "utf8")).toBe(stale);
  });

  it("reports a reclaim claim whose owner publication is still incomplete", () => {
    const canonical = makeDir("remote-reclaim-owner-publication-race");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const nonce = "d".repeat(32);
    const stale = `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "1",
      nonce,
    })}\n`;
    const claimPath = `${lockPath}.reclaim-${nonce}`;
    writeFileSync(lockPath, stale, { mode: 0o600 });

    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: (event, path) => {
        if (event === "before-claim-mkdir") mkdirSync(path, { mode: 0o700 });
      },
    })).toThrow(
      "project map lock reclamation changed during acquisition; retry the operation",
    );
    expect(readFileSync(lockPath, "utf8")).toBe(stale);
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(join(claimPath, "owner.json"))).toBe(false);
  });

  it("recovers a reclaim claim whose owner crashed without deleting a successor generation", () => {
    const canonical = makeDir("remote-crashed-reclaimer");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const mainNonce = "f".repeat(32);
    const claimNonce = "1".repeat(32);
    const stale = `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "1",
      nonce: mainNonce,
    })}\n`;
    const staleClaim = `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "1",
      nonce: claimNonce,
    })}\n`;
    const claimPath = `${lockPath}.reclaim-${mainNonce}`;
    writeFileSync(lockPath, stale, { mode: 0o600 });
    mkdirSync(claimPath, { mode: 0o700 });
    writeFileSync(join(claimPath, "owner.json"), staleClaim, { mode: 0o600 });

    expect(setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toMatchObject({ changed: true });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
    expect(readFileSync(`${claimPath}.stale-${claimNonce}/owner.json`, "utf8"))
      .toBe(staleClaim);
  });

  it("fails closed for malformed and symlinked reclaim claim owners", () => {
    const canonical = makeDir("remote-unsafe-reclaimer");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const mainNonce = "2".repeat(32);
    const stale = `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "1",
      nonce: mainNonce,
    })}\n`;
    const claimPath = `${lockPath}.reclaim-${mainNonce}`;
    writeFileSync(lockPath, stale, { mode: 0o600 });
    mkdirSync(claimPath, { mode: 0o700 });
    writeFileSync(join(claimPath, "owner.json"), "{broken", { mode: 0o600 });
    expect(() => setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toThrow("project map lock is malformed");

    rmSync(claimPath, { recursive: true });
    mkdirSync(claimPath, { mode: 0o700 });
    const target = join(homedir(), "claim-owner-target");
    writeFileSync(target, stale);
    symlinkSync(target, join(claimPath, "owner.json"));
    expect(() => setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toThrow();
    expect(readFileSync(lockPath, "utf8")).toBe(stale);
  });

  it("covers platform, unreadable proc, and empty process-start observations", () => {
    for (const [name, observer] of [
      ["non-linux", (event: string, _path: string, mutable?: { value: string }) => {
        if (event === "platform") mutable!.value = "darwin";
      }],
      ["unreadable-proc", (event: string) => {
        if (event === "before-process-stat-read") throw new Error("proc unavailable");
      }],
      ["empty-proc", (event: string, _path: string, mutable?: { value: string }) => {
        if (event === "after-process-stat-read") mutable!.value = "1 (x) S";
      }],
    ] as const) {
      resetLcmHome();
      const canonical = makeDir(`lock-process-${name}`);
      resolveProjectIdentity(canonical);
      expect(setRemoteProjectBinding(remoteProjectId, {
        canonical,
        _lockObserverForTesting: observer,
      })).toMatchObject({ changed: true });
    }
  });

  it("uses portable process birth identities and never age-reclaims an unverifiable live owner", () => {
    const canonical = makeDir("portable-lock-owner");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const writeOwner = (
      processStartTime: string | null,
      nonce: string,
      createdAtMs?: number,
    ) => {
      writeFileSync(lockPath, `${JSON.stringify({
        version: 1,
        pid: process.pid,
        processStartTime,
        nonce,
        ...(createdAtMs === undefined ? {} : { createdAtMs }),
      })}\n`, { mode: 0o600 });
    };
    const portableObserver = (
      selectedPlatform: string,
      observedBirth: string,
    ) => (event: string, _path: string, mutable?: { value: string }) => {
      if (event === "platform") mutable!.value = selectedPlatform;
      if (event === "after-process-birth-command") mutable!.value = observedBirth;
    };

    writeOwner("darwin-birth", "a".repeat(32), Date.now() - 10 * 60 * 1000);
    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: portableObserver("darwin", "darwin-birth"),
    })).toThrow(`owned by live PID ${process.pid}`);
    rmSync(lockPath);

    writeOwner("old-darwin-birth", "b".repeat(32), Date.now());
    expect(setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: portableObserver("darwin", "new-darwin-birth"),
    })).toMatchObject({ changed: true });

    writeOwner("windows-birth", "c".repeat(32), Date.now());
    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: portableObserver("win32", "windows-birth"),
    })).toThrow(`owned by live PID ${process.pid}`);
    rmSync(lockPath);

    writeOwner(null, "d".repeat(32), Date.now());
    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: portableObserver("darwin", ""),
    })).toThrow("owner state is ambiguous");
    rmSync(lockPath);

    writeOwner(null, "e".repeat(32), Date.now() - 10 * 60 * 1000);
    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: portableObserver("darwin", ""),
    })).toThrow("owner state is ambiguous");
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath);

    writeOwner(null, "f".repeat(32));
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath, oldTime, oldTime);
    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: portableObserver("darwin", ""),
    })).toThrow("owner state is ambiguous");
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath);

    writeOwner(null, "1".repeat(32), 0);
    expect(() => setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toThrow("project map lock has an invalid owner");
  });

  it("fails closed when probing a lock owner is not permitted", () => {
    const canonical = makeDir("lock-probe-denied");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "1",
      nonce: "3".repeat(32),
    })}\n`, { mode: 0o600 });

    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: (event) => {
        if (event === "before-process-probe") {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
      },
    })).toThrow("owner state is ambiguous");
  });

  it("reports a live reclaim claim owner distinctly", () => {
    const canonical = makeDir("remote-live-reclaimer");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const mainNonce = "4".repeat(32);
    const processFields = readFileSync(`/proc/${process.pid}/stat`, "utf8")
      .slice(readFileSync(`/proc/${process.pid}/stat`, "utf8").lastIndexOf(")") + 2)
      .trim()
      .split(" ");
    const processStartTime = processFields[19];
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "1",
      nonce: mainNonce,
    })}\n`, { mode: 0o600 });
    const claimPath = `${lockPath}.reclaim-${mainNonce}`;
    mkdirSync(claimPath, { mode: 0o700 });
    writeFileSync(join(claimPath, "owner.json"), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime,
      nonce: "5".repeat(32),
    })}\n`, { mode: 0o600 });

    expect(() => setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toThrow(`owned by live PID ${process.pid}`);
  });

  it("fails closed at every reclaim protocol filesystem boundary", () => {
    type Scenario = {
      readonly name: string;
      readonly existingClaim?: boolean;
      readonly observer: (event: string, path: string) => void;
      readonly expected: string;
    };
    const scenarios: Scenario[] = [
      {
        name: "claim-mkdir",
        observer: (event) => {
          if (event === "before-claim-mkdir") {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
        },
        expected: "denied",
      },
      {
        name: "claim-owner-write",
        observer: (event) => {
          if (event === "after-claim-mkdir") throw new Error("owner write failed");
        },
        expected: "owner write failed",
      },
      {
        name: "claim-owner-collision",
        observer: (event, path) => {
          if (event === "after-claim-mkdir") {
            writeFileSync(join(path, "owner.json"), "occupied", { mode: 0o600 });
          }
        },
        expected: "owner already exists",
      },
      {
        name: "claim-rename",
        existingClaim: true,
        observer: (event, path) => {
          if (event === "before-claim-rename") {
            const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { nonce: string };
            const tombstone = `${path}.stale-${owner.nonce}`;
            mkdirSync(tombstone, { mode: 0o700 });
            writeFileSync(join(tombstone, "owner.json"), "occupied", { mode: 0o600 });
          }
        },
        expected: "reclamation changed",
      },
      {
        name: "claim-successor",
        existingClaim: true,
        observer: (event, path) => {
          if (event === "after-claim-rename") {
            mkdirSync(path, { mode: 0o700 });
            writeFileSync(join(path, "owner.json"), "successor", { mode: 0o600 });
          }
        },
        expected: "claimed concurrently",
      },
      {
        name: "claim-removal-read",
        observer: (event, path) => {
          if (event === "before-claim-removal-read") writeFileSync(path, "changed");
        },
        expected: "ownership changed",
      },
      {
        name: "stale-lock-read",
        observer: (event, path) => {
          if (event === "before-stale-lock-read") writeFileSync(path, "changed");
        },
        expected: "lock changed",
      },
      {
        name: "stale-lock-delete",
        observer: (event, path) => {
          if (event === "before-stale-lock-delete") rmSync(path);
        },
        expected: "lock disappeared",
      },
      {
        name: "successor-create",
        observer: (event, path) => {
          if (event === "before-successor-lock-create") {
            writeFileSync(path, "successor", { mode: 0o600 });
          }
        },
        expected: "claimed concurrently",
      },
    ];

    for (const scenario of scenarios) {
      resetLcmHome();
      const canonical = makeDir(`lock-boundary-${scenario.name}`);
      resolveProjectIdentity(canonical);
      const lockPath = `${projectMapPath()}.lock`;
      const mainNonce = scenario.name.padEnd(32, "a").slice(0, 32)
        .replace(/[^a-f0-9]/gu, "a");
      writeFileSync(lockPath, `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        processStartTime: "1",
        nonce: mainNonce,
      })}\n`, { mode: 0o600 });
      if (scenario.existingClaim) {
        const claimPath = `${lockPath}.reclaim-${mainNonce}`;
        mkdirSync(claimPath, { mode: 0o700 });
        writeFileSync(join(claimPath, "owner.json"), `${JSON.stringify({
          version: 1,
          pid: 2_147_483_647,
          processStartTime: "1",
          nonce: "6".repeat(32),
        })}\n`, { mode: 0o600 });
      }

      expect(() => setRemoteProjectBinding(remoteProjectId, {
        canonical,
        _lockObserverForTesting: scenario.observer,
      })).toThrow(scenario.expected);
    }
  });

  it.each([
    {
      name: "ownership read",
      observer: (event: string, path: string) => {
        if (event === "before-claim-release-read") writeFileSync(path, "changed");
      },
    },
    {
      name: "owner deletion",
      observer: (event: string, path: string) => {
        if (event === "before-claim-release-delete") rmSync(path);
      },
    },
    {
      name: "claim directory removal",
      observer: (event: string, path: string) => {
        if (event === "before-claim-release-delete") {
          writeFileSync(join(dirname(path), "concurrent"), "occupied", { mode: 0o600 });
        }
      },
    },
  ])("does not strand a published successor when reclaim-claim $name fails", ({ name, observer }) => {
    const canonical = makeDir(`lock-post-publish-${name.replaceAll(" ", "-")}`);
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const mainNonce = "d".repeat(32);
    const reclaimPath = `${lockPath}.reclaim-${mainNonce}`;
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "1",
      nonce: mainNonce,
    })}\n`, { mode: 0o600 });

    expect(setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: observer,
    }).changed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(reclaimPath)).toBe(true);
    expect(showProjectMapEntry(canonical).entry.remoteProjectId).toBe(remoteProjectId);

    expect(clearRemoteProjectBinding(canonical, remoteProjectId).changed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(showProjectMapEntry(canonical).entry.remoteProjectId).toBeUndefined();
  });

  it("detects main lock ownership changes before releasing a completed mutation", () => {
    const canonical = makeDir("remote-release-owner-change");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;

    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _afterLockForTesting: () => writeFileSync(lockPath, "changed"),
    })).toThrow("ownership changed before release");
  });

  it.each([
    ["release read", "before-main-lock-release-read"],
    ["release delete", "before-main-lock-release-delete"],
  ])("preserves a callback error when the main lock %s also fails", (_case, failureEvent) => {
    const canonical = makeDir(`remote-primary-${failureEvent}`);
    resolveProjectIdentity(canonical);
    const primary = new Error(`primary callback failure at ${failureEvent}`);
    let thrown: unknown;

    try {
      setRemoteProjectBinding(remoteProjectId, {
        canonical,
        _afterLockForTesting: () => {
          throw primary;
        },
        _lockObserverForTesting: (event, path) => {
          if (event === failureEvent) rmSync(path, { force: true });
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(primary);
  });

  it("reports a disappeared main lock when deletion follows a successful callback", () => {
    const canonical = makeDir("remote-release-delete-disappeared");
    resolveProjectIdentity(canonical);

    expect(() => setRemoteProjectBinding(remoteProjectId, {
      canonical,
      _lockObserverForTesting: (event, path) => {
        if (event === "before-main-lock-release-delete") rmSync(path);
      },
    })).toThrow("project map mutation lock disappeared before release");
  });

  it("fails closed for invalid, symlinked, and non-regular map locks", () => {
    const canonical = makeDir("remote-unsafe-lock");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;

    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      pid: -1,
      processStartTime: null,
      nonce: "bad",
    }), { mode: 0o600 });
    expect(() => setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toThrow("invalid owner");
    rmSync(lockPath);

    const target = join(homedir(), "lock-target");
    writeFileSync(target, "unsafe");
    symlinkSync(target, lockPath);
    expect(() => setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toThrow();
    rmSync(lockPath);

    mkdirSync(lockPath);
    expect(() => setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toThrow();
  });

  it("serializes alias mutations and compares the complete expected entry", () => {
    const canonical = makeDir("alias-lock-canonical");
    const alias = makeDir("alias-lock-first");
    const concurrent = makeDir("alias-lock-concurrent");
    const local = resolveProjectIdentity(canonical);
    const expectedEntry = showProjectMapEntry(local.id).entry;
    let nestedError: unknown;

    addProjectAlias(alias, {
      hash: local.id,
      expectedEntry,
      _afterLockForTesting: () => {
        try {
          addProjectAlias(concurrent, { hash: local.id });
        } catch (error) {
          nestedError = error;
        }
      },
    });

    expect((nestedError as Error).message).toContain("project map mutation is already in progress");
    expect(() => setRemoteProjectBinding(remoteProjectId, {
      hash: local.id,
      expectedEntry,
    })).toThrow("changed during coordinated mutation");
    const current = showProjectMapEntry(local.id).entry;
    expect(() => removeProjectAlias(alias, {
      hash: local.id,
      expectedEntry,
    })).toThrow("changed during coordinated mutation");
    expect(removeProjectAlias(alias, {
      hash: local.id,
      expectedEntry: current,
    })).toMatchObject({ removed: true });
  });

  it("does not accept swapping the canonical path with an alias as the same expected entry", () => {
    const canonical = makeDir("entry-cas-canonical");
    const alias = makeDir("entry-cas-alias");
    const local = resolveProjectIdentity(canonical);
    addProjectAlias(alias, { hash: local.id });
    const expectedEntry = showProjectMapEntry(local.id).entry;
    writeFileSync(projectMapPath(), JSON.stringify({
      [local.id]: {
        canonical: alias,
        aliases: [canonical],
      },
    }, null, 2) + "\n");

    expect(() => setRemoteProjectBinding(remoteProjectId, {
      hash: local.id,
      expectedEntry,
    })).toThrow("changed during coordinated mutation");
  });

  it("fails closed when a remote binding changes or disappears before clear", () => {
    const canonical = makeDir("remote-clear-cas");
    const local = resolveProjectIdentity(canonical);
    const replacement = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
    setRemoteProjectBinding(remoteProjectId, { canonical });

    expect(() => clearRemoteProjectBinding(canonical, remoteProjectId, {
      _afterLockForTesting: () => {
        writeFileSync(projectMapPath(), JSON.stringify({
          [local.id]: {
            canonical,
            aliases: [],
            remoteProjectId: replacement,
          },
        }, null, 2) + "\n");
      },
    })).toThrow(`remote binding changed; expected ${remoteProjectId}`);
    expect(listProjectMapEntries()[local.id].remoteProjectId).toBe(replacement);

    expect(() => clearRemoteProjectBinding(canonical, replacement, {
      _afterLockForTesting: () => {
        writeFileSync(projectMapPath(), "{}\n");
      },
    })).toThrow("project is not mapped");
    expect(listProjectMapEntries()[local.id]).toBeUndefined();
    expect(existsSync(`${projectMapPath()}.lock`)).toBe(false);
  });

  it("requires explicit acknowledgement before binding or rebinding data-bearing projects", () => {
    const canonical = makeDir("remote-data");
    const local = resolveProjectIdentity(canonical);
    mkdirSync(join(homedir(), ".lcm", "projects", local.id), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", local.id, "db.sqlite"), "");
    expect(projectMapEntryHasStoredData(local.id)).toBe(true);

    expect(setRemoteProjectBinding(remoteProjectId, { canonical }))
      .toMatchObject({ changed: true });

    const other = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
    expect(() => setRemoteProjectBinding(other, { canonical }))
      .toThrow("--allow-existing-data");
    expect(setRemoteProjectBinding(other, {
      canonical,
      allowExistingData: true,
    })).toMatchObject({ changed: true, entry: { remoteProjectId: other } });
  });

  it("guards remote binding input and unmapped unlink targets", () => {
    const canonical = makeDir("remote-invalid");
    resolveProjectIdentity(canonical);
    expect(() => setRemoteProjectBinding("not-a-uuid", { canonical }))
      .toThrow("invalid remote project UUIDv7");
    expect(() => clearRemoteProjectBinding(canonical, "not-a-uuid"))
      .toThrow("invalid expected remote project UUIDv7");
    expect(() => clearRemoteProjectBinding(makeDir("remote-unmapped"), remoteProjectId))
      .toThrow("project is not mapped");
  });

  it("rejects missing aliases before they can be reinterpreted as symlinks", () => {
    const canonical = makeDir("canonical");
    projectId(canonical);
    const missingAlias = join(homedir(), "missing-alias");

    expect(() => addProjectAlias(missingAlias, { canonical })).toThrow("alias path does not exist");
    expect(existsSync(projectMapPath())).toBe(true);
  });

  it("rejects alias paths that are not directories", () => {
    const canonical = makeDir("file-alias-canonical");
    const alias = join(homedir(), "file-alias");
    writeFileSync(alias, "not a directory");

    expect(() => addProjectAlias(alias, { canonical })).toThrow("alias path must be an existing directory");
  });

  it("creates a private backup before adding an existing alias", () => {
    const canonical = makeDir("canonical-with-backup");
    const alias = makeDir("existing-alias");
    projectId(canonical);

    const result = addProjectAlias(alias, { canonical });

    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect((statSync(result.backupPath!).mode & 0o777)).toBe(0o600);
  });

  it("creates distinct current backups when multiple writes share a timestamp", () => {
    const canonical = makeDir("canonical-exclusive-backup");
    const firstAlias = makeDir("first-exclusive-alias");
    const secondAlias = makeDir("second-exclusive-alias");
    projectId(canonical);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const first = addProjectAlias(firstAlias, { canonical });
    const firstBackup = readFileSync(first.backupPath!, "utf-8");
    const second = addProjectAlias(secondAlias, { canonical });
    const secondBackup = readFileSync(second.backupPath!, "utf-8");

    expect(second.backupPath).not.toBe(first.backupPath);
    expect(second.backupPath).toBe(join(oldMapsDir(), "map-1700000000-1.json"));
    expect(readFileSync(first.backupPath!, "utf-8")).toBe(firstBackup);
    expect(firstBackup).not.toContain(firstAlias);
    expect(secondBackup).toContain(firstAlias);
    expect(secondBackup).not.toContain(secondAlias);
  });

  it("does not overwrite a concurrently reserved same-timestamp backup name", () => {
    const canonical = makeDir("canonical-concurrent-backup");
    const alias = makeDir("concurrent-backup-alias");
    projectId(canonical);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mkdirSync(oldMapsDir(), { recursive: true });
    const reserved = join(oldMapsDir(), "map-1700000000.json");
    writeFileSync(reserved, "concurrent winner", { mode: 0o600 });

    const result = addProjectAlias(alias, { canonical });

    expect(readFileSync(reserved, "utf8")).toBe("concurrent winner");
    expect(result.backupPath).toBe(join(oldMapsDir(), "map-1700000000-1.json"));
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
  });

  it("fails without mutating the map when all bounded backup suffixes are occupied", () => {
    const canonical = makeDir("canonical-backup-exhaustion");
    const alias = makeDir("backup-exhaustion-alias");
    projectId(canonical);
    const before = readFileSync(projectMapPath(), "utf8");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mkdirSync(oldMapsDir(), { recursive: true });
    for (let suffix = 0; suffix < 1_000; suffix += 1) {
      const discriminator = suffix === 0 ? "" : `-${suffix}`;
      writeFileSync(
        join(oldMapsDir(), `map-1700000000${discriminator}.json`),
        String(suffix),
        { mode: 0o600 },
      );
    }

    expect(() => addProjectAlias(alias, { canonical }))
      .toThrow("could not create an exclusive project map backup after 1000 attempts");
    expect(readFileSync(projectMapPath(), "utf8")).toBe(before);
  });

  it("keeps an alias identity stable when its path is later replaced by a symlink", () => {
    const canonical = makeDir("stable-alias-canonical");
    const alias = makeDir("stable-alias");
    const victim = makeDir("stable-alias-victim");
    const canonicalId = projectId(canonical);
    addProjectAlias(alias, { canonical });

    rmSync(alias, { recursive: true });
    symlinkSync(victim, alias, "dir");

    expect(projectId(victim)).not.toBe(canonicalId);
    expect(projectId(alias)).toBe(canonicalId);
    expect(projectMapPathsForHash(canonicalId)).toContain(alias);
    expect(projectMapPathsForHash(canonicalId)).not.toContain(victim);
  });

  it("supports hash-targeted removal and reports an absent alias without rewriting", () => {
    const canonical = makeDir("hash-remove-canonical");
    const alias = makeDir("hash-remove-alias");
    const unrelated = makeDir("hash-remove-unrelated");
    const hash = projectId(canonical);
    addProjectAlias(alias, { hash });

    expect(removeProjectAlias(unrelated, { hash })).toMatchObject({ hash, removed: false });
    expect(removeProjectAlias(alias, { hash })).toMatchObject({ hash, removed: true });
  });

  it("auto-populates missing entries from existing project metadata", () => {
    const canonical = makeDir("from-meta");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    mkdirSync(join(homedir(), ".lcm", "projects", hash), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", hash, "meta.json"), JSON.stringify({ cwd: canonical }));

    const map = listProjectMapEntries();

    expect(map[hash]?.canonical).toBe(normalizeProjectPath(canonical));
  });

  it("rechecks metadata under the mutation lock after a concurrent backfill", () => {
    const canonical = makeDir("from-meta-race");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    mkdirSync(join(homedir(), ".lcm", "projects", hash), { recursive: true });
    writeFileSync(
      join(homedir(), ".lcm", "projects", hash, "meta.json"),
      JSON.stringify({ cwd: canonical }),
    );

    const identity = resolveProjectIdentity(canonical, {
      _beforeMetadataLockForTesting: () => {
        expect(listProjectMapEntries()[hash]?.canonical).toBe(
          normalizeProjectPath(canonical),
        );
      },
    });

    expect(identity.id).toBe(hash);
    expect(listProjectMapEntries()[hash]?.canonical).toBe(normalizeProjectPath(canonical));
  });

  it("backfills metadata directly while an alias mutation already owns the lock", () => {
    const canonical = makeDir("from-meta-during-alias");
    const alias = makeDir("from-meta-during-alias-alias");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    mkdirSync(join(homedir(), ".lcm", "projects", hash), { recursive: true });
    writeFileSync(
      join(homedir(), ".lcm", "projects", hash, "meta.json"),
      JSON.stringify({ cwd: canonical }),
    );

    const added = addProjectAlias(alias, { canonical });

    expect(added.hash).toBe(hash);
    expect(added.entry.aliases).toContain(normalizeProjectPath(alias));
  });

  it("shows metadata-backed map entries by hash and path", () => {
    const canonical = makeDir("show-from-meta");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    mkdirSync(join(homedir(), ".lcm", "projects", hash), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", hash, "meta.json"), JSON.stringify({ cwd: canonical }));

    const byHash = showProjectMapEntry(hash);
    const byPath = showProjectMapEntry(canonical);

    expect(byHash.transient).toBeUndefined();
    expect(byHash.entry.canonical).toBe(normalizeProjectPath(canonical));
    expect(byPath.hash).toBe(hash);
    expect(byPath.entry.canonical).toBe(normalizeProjectPath(canonical));
  });

  it("skips metadata backfill entries that would create path ambiguity", () => {
    const shared = makeDir("shared-meta");
    const firstHash = hashProjectPath(`${normalizeProjectPath(shared)}-first`);
    const secondHash = hashProjectPath(`${normalizeProjectPath(shared)}-second`);
    mkdirSync(join(homedir(), ".lcm", "projects", firstHash), { recursive: true });
    mkdirSync(join(homedir(), ".lcm", "projects", secondHash), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", firstHash, "meta.json"), JSON.stringify({ cwd: shared }));
    writeFileSync(join(homedir(), ".lcm", "projects", secondHash, "meta.json"), JSON.stringify({ cwd: shared }));

    const map = listProjectMapEntries();
    const validation = validateProjectMap({ fix: true });

    expect(Object.keys(map)).toHaveLength(1);
    expect(validation.ok).toBe(true);
  });

  it("reports an absent map as a valid empty map", () => {
    expect(validateProjectMap()).toEqual({
      ok: true,
      map: {},
      path: projectMapPath(),
      errors: [],
      warnings: ["map.json does not exist yet"],
      fixApplied: false,
    });
  });

  it("reports invalid JSON without rewriting the map", () => {
    writeFileSync(projectMapPath(), "{not-json");

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.fixApplied).toBe(false);
    expect(readFileSync(projectMapPath(), "utf-8")).toBe("{not-json");
  });

  it("reports a stable validation error when parsing throws a non-Error value", (): void => {
    writeFileSync(projectMapPath(), "{not-json");
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "parse failed";
    });

    const validation = validateProjectMap({ fix: true });

    expect(validation.errors).toEqual(["map.json is invalid"]);
    expect(validation.fixApplied).toBe(false);
  });

  it("does not overwrite invalid map edits from a stale cache", () => {
    const canonical = makeDir("cached-canonical");
    resolveProjectIdentity(canonical);
    writeFileSync(projectMapPath(), "{not-json");

    const unseen = makeDir("unseen-while-invalid");

    expect(() => resolveProjectIdentity(unseen)).toThrow(/refusing to overwrite invalid map\.json/);
    expect(readFileSync(projectMapPath(), "utf-8")).toBe("{not-json");
  });

  it("refuses an overwrite when map parsing throws a non-Error value", (): void => {
    const canonical = makeDir("cached-canonical-non-error");
    resolveProjectIdentity(canonical);
    const unseen = makeDir("unseen-while-non-error");
    vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw "parse failed";
    });

    expect(() => resolveProjectIdentity(unseen)).toThrow(
      "refusing to overwrite invalid map.json: map.json is invalid",
    );
  });

  it("rejects a non-regular map file through the public read seam", () => {
    const target = join(homedir(), "map-symlink-target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, projectMapPath());

    expect(() => listProjectMapEntries()).toThrow();
  });

  it("refuses an invalid edit made after a mutation snapshot", () => {
    const canonical = makeDir("invalid-after-snapshot");
    const local = resolveProjectIdentity(canonical);
    const expectedEntry = showProjectMapEntry(local.id).entry;
    const options = {
      hash: local.id,
      get expectedEntry() {
        writeFileSync(projectMapPath(), "{not-json");
        return expectedEntry;
      },
    };

    expect(() => setRemoteProjectBinding(remoteProjectId, options))
      .toThrow(/refusing to overwrite invalid map\.json/);
    expect(readFileSync(projectMapPath(), "utf8")).toBe("{not-json");
  });

  it("normalizes a primitive parse failure after a mutation snapshot", () => {
    const canonical = makeDir("primitive-invalid-after-snapshot");
    const local = resolveProjectIdentity(canonical);
    const expectedEntry = showProjectMapEntry(local.id).entry;
    const options = {
      hash: local.id,
      get expectedEntry() {
        vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
          throw "parse failed";
        });
        return expectedEntry;
      },
    };

    expect(() => setRemoteProjectBinding(remoteProjectId, options))
      .toThrow("refusing to overwrite invalid map.json: map.json is invalid");
  });

  it("keeps cached aliases when map.json temporarily disappears", () => {
    const canonical = makeDir("cached-missing-canonical");
    const alias = makeDir("cached-missing-alias");
    const unseen = makeDir("cached-missing-unseen");
    const canonicalId = projectId(canonical);
    addProjectAlias(alias, { canonical });
    rmSync(projectMapPath());

    const unseenId = projectId(unseen);
    const map = listProjectMapEntries();

    expect(map[canonicalId].aliases).toContain(normalizeProjectPath(alias));
    expect(map[unseenId].canonical).toBe(normalizeProjectPath(unseen));
    expect(readFileSync(projectMapPath(), "utf-8")).toBe(JSON.stringify(map, null, 2) + "\n");
  });

  it("keeps cached aliases when a map reload sees a transient missing file", () => {
    const canonical = makeDir("reload-missing-canonical");
    const alias = makeDir("reload-missing-alias");
    const unseen = makeDir("reload-missing-unseen");
    const canonicalId = projectId(canonical);
    addProjectAlias(alias, { canonical });
    rmSync(projectMapPath());

    expect(reloadProjectMapCache({ reformat: true })).toBe(true);
    expect(existsSync(projectMapPath())).toBe(false);

    const unseenId = projectId(unseen);
    const map = listProjectMapEntries();

    expect(map[canonicalId].aliases).toContain(normalizeProjectPath(alias));
    expect(map[unseenId].canonical).toBe(normalizeProjectPath(unseen));
  });

  it("rejects relative canonical paths in manually edited maps", () => {
    const hash = hashProjectPath("/absolute-project");
    writeFileSync(projectMapPath(), JSON.stringify({
      [hash]: { canonical: "relative-project", aliases: [] },
    }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("canonical must be an absolute path");
  });

  it("rejects relative aliases in manually edited maps", () => {
    const canonical = makeDir("absolute-canonical");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    writeFileSync(projectMapPath(), JSON.stringify({
      [hash]: { canonical, aliases: ["relative-alias"] },
    }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("aliases must contain only absolute paths");
  });

  it.each([
    ["array root", []],
    ["bad hash", { not_a_hash: { canonical: "/tmp/project", aliases: [] } }],
    ["non-object entry", { ["a".repeat(64)]: null }],
    ["empty canonical", { ["a".repeat(64)]: { canonical: "", aliases: [] } }],
    ["bad aliases", { ["a".repeat(64)]: { canonical: "/tmp/project", aliases: [""] } }],
    ["bad remote ID", { ["a".repeat(64)]: { canonical: "/tmp/project", aliases: [], remoteProjectId: "bad" } }],
  ])("rejects invalid map schema: %s", (_label: string, map: unknown) => {
    writeFileSync(projectMapPath(), JSON.stringify(map));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.fixApplied).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it("reformats valid compact JSON and creates a backup", () => {
    const canonical = makeDir("compact");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    writeFileSync(projectMapPath(), JSON.stringify({ [hash]: { canonical, aliases: [] } }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(true);
    expect(validation.fixApplied).toBe(true);
    expect(validation.backupPath).toBeDefined();
    expect(readFileSync(projectMapPath(), "utf-8")).toBe(JSON.stringify({
      [hash]: { canonical, aliases: [] },
    }, null, 2) + "\n");
  });

  it("repairs duplicate aliases within one hash", () => {
    const canonical = makeDir("dedupe");
    const alias = makeDir("dedupe-alias");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    writeFileSync(projectMapPath(), JSON.stringify({
      [hash]: { canonical, aliases: [alias, alias, canonical] },
    }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(true);
    expect(validation.fixApplied).toBe(true);
    expect(validation.map?.[hash].aliases).toEqual([alias]);
  });

  it("fails validation for cross-hash path ambiguity", () => {
    const first = makeDir("first");
    const second = makeDir("second");
    const shared = makeDir("shared");
    const firstHash = hashProjectPath(normalizeProjectPath(first));
    const secondHash = hashProjectPath(normalizeProjectPath(second));
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [shared] },
      [secondHash]: { canonical: second, aliases: [shared] },
    }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("multiple hashes");
  });

  it("shows, adds, and removes aliases", () => {
    const canonical = makeDir("cli-canonical");
    const alias = makeDir("cli-alias");

    const added = addProjectAlias(alias, { canonical });
    const shown = showProjectMapEntry(added.hash);
    const removed = removeProjectAlias(alias);

    expect(shown.entry.aliases).toContain(normalizeProjectPath(alias));
    expect(removed.removed).toBe(true);
    expect(listProjectMapEntries()[added.hash].aliases).toEqual([]);
  });

  it("shows the current mapped project when no target is provided", () => {
    const originalCwd = process.cwd();
    const canonical = makeDir("show-current-canonical");
    const hash = projectId(canonical);
    process.chdir(canonical);

    try {
      const shown = showProjectMapEntry();

      expect(shown).toMatchObject({
        hash,
        entry: { canonical: normalizeProjectPath(canonical), aliases: [] },
      });
      expect(shown.transient).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("shows the current unmapped project without writing map.json", () => {
    const originalCwd = process.cwd();
    const target = makeDir("show-current-unmapped");
    process.chdir(target);

    try {
      const shown = showProjectMapEntry();

      expect(shown.transient).toBe(true);
      expect(shown.hash).toBe(hashProjectPath(normalizeProjectPath(target)));
      expect(shown.entry).toEqual({ canonical: normalizeProjectPath(target), aliases: [] });
      expect(existsSync(projectMapPath())).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("adds an alias to the current project by default", () => {
    const originalCwd = process.cwd();
    const canonical = makeDir("default-add-canonical");
    const alias = makeDir("default-add-alias");
    const hash = projectId(canonical);
    process.chdir(canonical);

    try {
      const added = addProjectAlias(alias);

      expect(added.hash).toBe(hash);
      expect(added.entry.aliases).toContain(normalizeProjectPath(alias));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects ambiguous project identity resolution", () => {
    const first = makeDir("identity-first");
    const second = makeDir("identity-second");
    const shared = makeDir("identity-shared");
    const firstHash = hashProjectPath(normalizeProjectPath(first));
    const secondHash = hashProjectPath(normalizeProjectPath(second));
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [shared] },
      [secondHash]: { canonical: second, aliases: [shared] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    expect(() => resolveProjectIdentity(shared)).toThrow(/multiple hashes/);
  });

  it("preserves a remote binding on a legacy hash entry whose canonical path drifted", () => {
    const target = makeDir("identity-drift-target");
    const hash = hashProjectPath(normalizeProjectPath(target));
    writeFileSync(projectMapPath(), JSON.stringify({
      [hash]: {
        canonical: makeDir("identity-drift-canonical"),
        aliases: [],
        remoteProjectId,
      },
    }));
    clearProjectMapCache();

    expect(resolveProjectIdentity(target)).toEqual({
      id: hash,
      canonical: expect.stringContaining("identity-drift-canonical"),
      remoteProjectId,
    });
  });

  it("rejects a lexical path owned as both an alias and another canonical path", () => {
    const first = makeDir("identity-alias-owner");
    const shared = makeDir("identity-alias-canonical-collision");
    const firstHash = hashProjectPath(normalizeProjectPath(first));
    const secondHash = hashProjectPath(normalizeProjectPath(shared));
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [shared] },
      [secondHash]: { canonical: shared, aliases: [] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    expect(() => resolveProjectIdentity(shared)).toThrow(/multiple hashes/);
  });

  it("rejects alias add and remove targets with both canonical and hash", () => {
    const canonical = makeDir("mutual-canonical");
    const alias = makeDir("mutual-alias");
    const hash = projectId(canonical);

    expect(() => addProjectAlias(alias, { canonical, hash })).toThrow(/mutually exclusive/);
    expect(() => removeProjectAlias(alias, { canonical, hash })).toThrow(/mutually exclusive/);
  });

  it("rejects duplicate aliases on the target project", () => {
    const canonical = makeDir("duplicate-canonical");
    const alias = makeDir("duplicate-alias");

    addProjectAlias(alias, { canonical });

    expect(() => addProjectAlias(alias, { canonical })).toThrow(/already mapped/);
  });

  it("rejects aliases already owned by another non-adoptable hash", () => {
    const first = makeDir("nonadopt-first");
    const second = makeDir("nonadopt-second");
    const alias = makeDir("nonadopt-alias");
    const firstHash = hashProjectPath(normalizeProjectPath(first));
    const secondHash = hashProjectPath(normalizeProjectPath(second));
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [alias] },
      [secondHash]: { canonical: second, aliases: [] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    expect(() => addProjectAlias(alias, { hash: secondHash })).toThrow(/already mapped to another hash/);
  });

  it("rejects aliases equal to the target canonical path", () => {
    const canonical = makeDir("same-canonical");
    const hash = projectId(canonical);

    expect(() => addProjectAlias(canonical, { hash })).toThrow(/matches canonical path/);
  });

  it("rejects ambiguous canonical targets when removing aliases", () => {
    const canonical = makeDir("ambiguous-canonical");
    const firstHash = hashProjectPath(`${normalizeProjectPath(canonical)}-first`);
    const secondHash = hashProjectPath(`${normalizeProjectPath(canonical)}-second`);
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical, aliases: [] },
      [secondHash]: { canonical, aliases: [] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    expect(() => removeProjectAlias(makeDir("ambiguous-remove-alias"), { canonical })).toThrow(/multiple hashes/);
  });

  it("removes an alias selected by its canonical path", () => {
    const canonical = makeDir("canonical-remove-target");
    const alias = makeDir("canonical-remove-alias");
    projectId(canonical);
    addProjectAlias(alias, { canonical });

    const removed = removeProjectAlias(alias, { canonical });
    expect(removed.removed).toBe(true);
    expect(removed.entry.aliases).not.toContain(normalizeProjectPath(alias));
  });

  it("converts an already-seen canonical-only path into an alias", () => {
    const canonical = makeDir("adopt-canonical");
    const alias = makeDir("adopt-alias");
    const canonicalId = projectId(canonical);
    const staleAliasId = projectId(alias);

    const added = addProjectAlias(alias, { canonical });
    const map = listProjectMapEntries();

    expect(added.hash).toBe(canonicalId);
    expect(map[canonicalId].aliases).toContain(normalizeProjectPath(alias));
    expect(map[staleAliasId]).toBeUndefined();
    expect(projectId(alias)).toBe(canonicalId);
  });

  it("refuses to adopt an already-seen canonical-only project with a remote binding", () => {
    const canonical = makeDir("remote-canonical");
    const alias = makeDir("remote-alias");
    projectId(canonical);
    const staleAliasId = projectId(alias);
    const remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
    setRemoteProjectBinding(remoteProjectId, { canonical: alias });

    expect(() => addProjectAlias(alias, { canonical }))
      .toThrow(/already mapped to another hash/);
    expect(listProjectMapEntries()[staleAliasId]).toMatchObject({
      canonical: normalizeProjectPath(alias),
      aliases: [],
      remoteProjectId,
    });
  });

  it("refuses to adopt an already-seen alias project that has stored data", () => {
    const canonical = makeDir("data-canonical");
    const alias = makeDir("data-alias");
    projectId(canonical);
    const staleAliasId = projectId(alias);
    mkdirSync(join(homedir(), ".lcm", "projects", staleAliasId), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", staleAliasId, "db.sqlite"), "");

    expect(() => addProjectAlias(alias, { canonical })).toThrow(/stored data/);
    expect(listProjectMapEntries()[staleAliasId]).toBeDefined();
  });

  it("refuses to adopt an already-seen alias project that has an event sidecar", () => {
    const canonical = makeDir("events-canonical");
    const alias = makeDir("events-alias");
    projectId(canonical);
    const staleAliasId = projectId(alias);
    mkdirSync(join(homedir(), ".lcm", "events"), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "events", `${staleAliasId}.db`), "");

    expect(() => addProjectAlias(alias, { canonical })).toThrow(/stored data/);
    expect(listProjectMapEntries()[staleAliasId]).toBeDefined();
  });

  it("shows an unmapped path without creating or rewriting map.json", () => {
    const target = join(homedir(), "unmapped-show-target");

    const shown = showProjectMapEntry(target);

    expect(shown.transient).toBe(true);
    expect(shown.hash).toBe(hashProjectPath(normalizeProjectPath(target)));
    expect(shown.entry).toEqual({ canonical: normalizeProjectPath(target), aliases: [] });
    expect(existsSync(projectMapPath())).toBe(false);
  });

  it("does not create a map entry when removing from an unmapped canonical target", () => {
    const canonical = makeDir("remove-unmapped-canonical");
    const alias = join(homedir(), "remove-unmapped-alias");

    expect(() => removeProjectAlias(alias, { canonical })).toThrow(/unknown canonical project path/);
    expect(existsSync(projectMapPath())).toBe(false);
  });

  it("rejects missing canonical and unknown hash remove targets", () => {
    const missingCanonical = join(homedir(), "missing-remove-canonical");
    const hash = "a".repeat(64);

    expect(() => removeProjectAlias(makeDir("missing-remove-alias"), { canonical: missingCanonical })).toThrow(/canonical path does not exist/);
    expect(() => removeProjectAlias(makeDir("unknown-hash-remove-alias"), { hash })).toThrow(/unknown project hash/);
  });

  it("requires --canonical targets to be existing directories", () => {
    const canonicalFile = join(homedir(), "canonical-file");
    const alias = makeDir("file-target-alias");
    writeFileSync(canonicalFile, "not a directory");

    expect(() => addProjectAlias(alias, { canonical: canonicalFile })).toThrow(/existing directory/);
    expect(existsSync(projectMapPath())).toBe(false);
  });

  it("reports invalid map reloads without replacing the cache", () => {
    const canonical = makeDir("reload-invalid-canonical");
    const alias = makeDir("reload-invalid-alias");
    const hash = projectId(canonical);
    addProjectAlias(alias, { canonical });
    writeFileSync(projectMapPath(), "{not-json");
    const changedAt = new Date(Date.now() + 1_000);
    utimesSync(projectMapPath(), changedAt, changedAt);

    expect(reloadProjectMapCache({ reformat: true })).toBe(false);
    expect(projectId(alias)).toBe(hash);
  });

  it("refuses ambiguous alias removal without an explicit target", () => {
    const first = makeDir("remove-first");
    const second = makeDir("remove-second");
    const shared = makeDir("remove-shared");
    const firstHash = hashProjectPath(normalizeProjectPath(first));
    const secondHash = hashProjectPath(normalizeProjectPath(second));
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [shared] },
      [secondHash]: { canonical: second, aliases: [shared] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    expect(() => removeProjectAlias(shared)).toThrow(/multiple hashes/);
    expect(readdirSync(join(homedir(), ".lcm")).includes("oldmaps")).toBe(false);
  });

  it("covers missing and invalid project map targets", () => {
    const alias = makeDir("target-errors-alias");
    const missingCanonical = join(homedir(), "missing-add-canonical");
    const unknownHash = "f".repeat(64);

    expect(() => addProjectAlias(alias, { canonical: missingCanonical })).toThrow(/does not exist/);
    expect(() => addProjectAlias(alias, { hash: "not-a-hash" })).toThrow(/invalid project hash/);
    expect(() => removeProjectAlias(alias, { hash: "not-a-hash" })).toThrow(/invalid project hash/);
    expect(() => addProjectAlias(alias, { hash: unknownHash })).toThrow(/unknown project hash/);
    expect(() => removeProjectAlias(join(homedir(), "unmapped-alias"))).toThrow(/not mapped/);
    expect(projectMapPathsForHash(unknownHash)).toEqual([]);
  });

  it("refuses to clear a remote binding from an unmapped transient target", () => {
    expect(() => clearRemoteProjectBinding(
      join(homedir(), "unmapped-clear-target"),
      remoteProjectId,
    ))
      .toThrow(/project is not mapped/);

    const originalCwd = process.cwd();
    const unmapped = makeDir("unmapped-clear-current");
    process.chdir(unmapped);
    try {
      expect(() => clearRemoteProjectBinding(undefined, remoteProjectId))
        .toThrow(`project is not mapped: ${unmapped}`);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects a file as a canonical alias-removal target", () => {
    const canonicalFile = join(homedir(), "remove-canonical-file");
    writeFileSync(canonicalFile, "file");

    expect(() => removeProjectAlias(makeDir("remove-file-alias"), { canonical: canonicalFile }))
      .toThrow(/existing directory/);
  });

  it("detects ambiguous current and explicit show targets", () => {
    const originalCwd = process.cwd();
    const shared = makeDir("show-ambiguous-shared");
    const firstHash = hashProjectPath(`${shared}-first`);
    const secondHash = hashProjectPath(`${shared}-second`);
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: makeDir("show-ambiguous-first"), aliases: [shared] },
      [secondHash]: { canonical: makeDir("show-ambiguous-second"), aliases: [shared] },
    }));
    clearProjectMapCache();

    expect(() => showProjectMapEntry(shared)).toThrow(/multiple hashes/);
    process.chdir(shared);
    try {
      expect(() => showProjectMapEntry()).toThrow(/multiple hashes/);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("ignores non-project metadata entries and malformed metadata", () => {
    const root = join(homedir(), ".lcm", "projects");
    const emptyHash = "1".repeat(64);
    const nonStringHash = "2".repeat(64);
    const corruptHash = "3".repeat(64);
    mkdirSync(join(root, "not-a-hash"), { recursive: true });
    writeFileSync(join(root, "plain-file"), "ignored");
    for (const hash of [emptyHash, nonStringHash, corruptHash]) {
      mkdirSync(join(root, hash), { recursive: true });
    }
    writeFileSync(join(root, emptyHash, "meta.json"), JSON.stringify({ cwd: "" }));
    writeFileSync(join(root, nonStringHash, "meta.json"), JSON.stringify({ cwd: 42 }));
    writeFileSync(join(root, corruptHash, "meta.json"), "{");

    expect(listProjectMapEntries()).toEqual({});
  });

  it("preserves an existing hash entry discovered through a different canonical path", () => {
    const target = makeDir("hash-collision-target");
    const id = hashProjectPath(normalizeProjectPath(target));
    const other = makeDir("hash-collision-other");
    writeFileSync(projectMapPath(), JSON.stringify({
      [id]: { canonical: other, aliases: [] },
    }));
    clearProjectMapCache();

    expect(resolveProjectIdentity(target)).toEqual({ id, canonical: normalizeProjectPath(other) });
  });

  it("cancels a pending map-watch reload when closed", async () => {
    const idleWatcher = watchProjectMap();
    idleWatcher.close();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mapWatcher = watchProjectMap();
    try {
      writeFileSync(projectMapPath(), "{}\n");
      for (let attempt = 0; attempt < 100 && vi.getTimerCount() === 0; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(vi.getTimerCount()).toBe(1);

      mapWatcher.close();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      mapWatcher.close();
      vi.useRealTimers();
    }
  });

  it("retries map-watch reloads while a live writer owns the map lock", () => {
    const canonical = makeDir("watch-live-writer");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    const processStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const processStartTime = processStat
      .slice(processStat.lastIndexOf(")") + 2)
      .trim()
      .split(" ")[19];
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime,
      nonce: "2".repeat(32),
      createdAtMs: Date.now(),
    })}\n`, { mode: 0o600 });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const watcher = watchProjectMap();
    try {
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(25);
      expect(vi.getTimerCount()).toBe(1);

      rmSync(lockPath);
      vi.advanceTimersByTime(25);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      watcher.close();
      vi.useRealTimers();
    }
  });

  it("surfaces unsafe startup locks without throwing from a delayed reload", () => {
    const canonical = makeDir("watch-unsafe-writer");
    resolveProjectIdentity(canonical);
    const lockPath = `${projectMapPath()}.lock`;
    writeFileSync(lockPath, "{broken", { mode: 0o600 });
    expect(() => watchProjectMap()).toThrow("project map lock is malformed");

    const processStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const processStartTime = processStat
      .slice(processStat.lastIndexOf(")") + 2)
      .trim()
      .split(" ")[19];
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime,
      nonce: "3".repeat(32),
      createdAtMs: Date.now(),
    })}\n`, { mode: 0o600 });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const watcher = watchProjectMap();
    try {
      writeFileSync(lockPath, "{broken", { mode: 0o600 });
      expect(() => vi.advanceTimersByTime(25)).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      watcher.close();
      vi.useRealTimers();
    }
  });

  it("reloads map watches for directory creation, deletion, and file changes", async () => {
    const directoryWatcher = watchProjectMap();
    writeFileSync(join(homedir(), ".lcm", "unrelated"), "ignored");
    writeFileSync(projectMapPath(), "{}\n");
    rmSync(projectMapPath());
    await new Promise((resolve) => setTimeout(resolve, 100));
    directoryWatcher.close();

    writeFileSync(projectMapPath(), "{}\n");
    const fileWatcher = watchProjectMap();
    writeFileSync(projectMapPath(), "{ }\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    fileWatcher.close();

    expect(reloadProjectMapCache()).toBe(true);
  });
});
