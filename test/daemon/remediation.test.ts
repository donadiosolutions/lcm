import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  DAEMON_NOTICE_REPEAT_INTERVAL_MS,
  DAEMON_REFUSAL_REASONS,
  DAEMON_REMEDIATION_MARKER_MAX_BYTES,
  DAEMON_REMEDIATION_MARKER_MAX_ENTRIES,
  DAEMON_REMEDIATION_MARKER_MAX_TIME_MS,
  DAEMON_REMEDIATION_MARKER_NAME,
  clearDaemonRemediation,
  daemonRemediationMarkerPath,
  daemonScopeDigest,
  isDaemonRefusalReason,
  mapDaemonRefusalToRemediation,
  readDaemonRemediationMarker,
  recordDaemonRemediation,
} from "../../src/daemon/remediation.js";
import {
  readBoundedRegularFileWithStat,
  type BoundedFileOptions,
} from "../../src/security-files.js";
import type { DaemonRemediationLockOperations } from "../../src/daemon/remediation.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "lcm-remediation-test-"));
}

function input(
  markerPath: string,
  scope: string,
  reason: (typeof DAEMON_REFUSAL_REASONS)[number],
  now: () => number,
) {
  return { markerPath, scope, reason, clock: { now } };
}

function markerEntries(
  count: number,
  timestamp: (index: number) => number = index => index,
): Record<string, { reason: (typeof DAEMON_REFUSAL_REASONS)[number]; lastNotifiedAtMs: number }> {
  const entries: Record<string, { reason: (typeof DAEMON_REFUSAL_REASONS)[number]; lastNotifiedAtMs: number }> = {};
  for (let index = 0; index < count; index += 1) {
    const reason = DAEMON_REFUSAL_REASONS[index % DAEMON_REFUSAL_REASONS.length];
    const digest = daemonScopeDigest(`generated-scope-${index}`);
    entries[`${digest}:${reason}`] = { reason, lastNotifiedAtMs: timestamp(index) };
  }
  return entries;
}

function writeMarkerDocument(
  markerPath: string,
  entries: Record<string, { reason: (typeof DAEMON_REFUSAL_REASONS)[number]; lastNotifiedAtMs: number }>,
): string {
  const raw = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
  writeFileSync(markerPath, raw, { encoding: "utf8", mode: 0o600 });
  chmodSync(markerPath, 0o600);
  return raw;
}

describe("daemon remediation mapping", () => {
  it("maps every bounded reason to safe fixed guidance", () => {
    for (const reason of DAEMON_REFUSAL_REASONS) {
      const mapped = mapDaemonRefusalToRemediation(reason);
      expect(mapped.action).toBe(mapped.kind);
      expect(mapped.command).not.toMatch(/kill|pkill|foreground/u);
      expect(mapped.message).toContain(`(${reason})`);
      expect(mapped.message).not.toMatch(/\/|[A-Za-z]:\\|pid|secret/iu);
    }
    expect(mapDaemonRefusalToRemediation("attacker /tmp/x" as never).kind).toBe("doctor");
    expect(isDaemonRefusalReason("startup-failure")).toBe(true);
    expect(isDaemonRefusalReason("attacker /tmp/x")).toBe(false);
    expect(isDaemonRefusalReason(null)).toBe(false);
  });

  it("keeps the full scope digest and stable marker name", () => {
    const scope = "/canonical/state-root?secret=never-in-message";
    expect(daemonScopeDigest(scope)).toBe(createHash("sha256").update(scope).digest("hex"));
    expect(daemonScopeDigest(scope)).toHaveLength(64);
    expect(daemonRemediationMarkerPath("/canonical/state-root")).toBe(
      `/canonical/state-root/${DAEMON_REMEDIATION_MARKER_NAME}`,
    );
  });
});

describe("daemon remediation marker", () => {
  it("deduplicates same-scope notices across concurrent Promise callers", async () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      const calls = await Promise.all(Array.from({ length: 24 }, () => Promise.resolve().then(() => (
        recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => 1_000))
      ))));
      expect(calls.filter(result => result.emit)).toHaveLength(1);
      expect(calls.filter(result => !result.emit)).toHaveLength(23);
      expect(existsSync(`${markerPath}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes reason transitions and retains only the latest reason", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      const clock = () => 2_000;
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "stale-config", clock))).toMatchObject({
        emit: true,
        markerStatus: "created",
      });
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", clock))).toMatchObject({
        emit: true,
        markerStatus: "reason-changed",
      });
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "stale-config", clock))).toMatchObject({
        emit: true,
        markerStatus: "reason-changed",
      });
      expect(Object.keys(readDaemonRemediationMarker({ markerPath }).entries)).toEqual([
        `${daemonScopeDigest("scope-a")}:stale-config`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reclaims a private stale lock without persisting scope, PID, or path", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      const lockPath = `${markerPath}.lock`;
      writeFileSync(lockPath, JSON.stringify({ version: 1, nonce: "a".repeat(32), createdAtMs: 1 }), { mode: 0o600 });
      const result = recordDaemonRemediation(input(markerPath, "scope-with-secret", "ambiguous", () => 20_000));
      expect(result).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
      expect(existsSync(lockPath)).toBe(false);
      const marker = readFileSync(markerPath, "utf8");
      expect(marker).not.toContain("scope-with-secret");
      expect(marker).not.toContain(String(process.pid));
      expect(marker).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed and remains bounded for live, malformed, symlink, and permission locks", () => {
    const root = makeRoot();
    try {
      const cases = [
        { name: "live", setup: (path: string) => writeFileSync(path, JSON.stringify({ version: 1, nonce: "b".repeat(32), createdAtMs: 20_000 }), { mode: 0o600 }) },
        { name: "malformed", setup: (path: string) => writeFileSync(path, "secret=/private/path", { mode: 0o600 }) },
        { name: "array-owner", setup: (path: string) => writeFileSync(path, "[]", { mode: 0o600 }) },
        { name: "wrong-owner-keys", setup: (path: string) => writeFileSync(path, JSON.stringify({ version: 1, nonce: "b".repeat(32), createdAt: 20_000 }), { mode: 0o600 }) },
        { name: "invalid-owner", setup: (path: string) => writeFileSync(path, JSON.stringify({ version: 1, nonce: "not-a-nonce", createdAtMs: -1 }), { mode: 0o600 }) },
        { name: "permission", setup: (path: string) => {
          writeFileSync(path, JSON.stringify({ version: 1, nonce: "c".repeat(32), createdAtMs: 20_000 }), { mode: 0o600 });
          chmodSync(path, 0o640);
        } },
      ];
      for (const testCase of cases) {
        const markerPath = join(root, `${testCase.name}.json`);
        testCase.setup(`${markerPath}.lock`);
        const started = Date.now();
        const result = recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => 20_000));
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(result).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
        expect(result.remediation.message).not.toMatch(/private|path|secret|pid/iu);
      }

      const target = join(root, "target");
      const symlinkMarkerPath = join(root, "symlink.json");
      const symlinkLockPath = `${symlinkMarkerPath}.lock`;
      writeFileSync(target, "do-not-touch", { mode: 0o600 });
      symlinkSync(target, symlinkLockPath);
      expect(recordDaemonRemediation(input(symlinkMarkerPath, "scope-a", "ambiguous", () => 20_000)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      expect(readFileSync(target, "utf8")).toBe("do-not-touch");

      const metadataMarkerPath = join(root, "metadata.json");
      const metadataOps: Partial<DaemonRemediationLockOperations> = {
        readBoundedRegularFileWithStat: (path: string, options: BoundedFileOptions) => ({
          ...readBoundedRegularFileWithStat(path, options),
          mtimeMs: Number.NaN,
        }),
      };
      expect(recordDaemonRemediation({
        ...input(metadataMarkerPath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: metadataOps,
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const uidMarkerPath = join(root, "uid.json");
      const uidOps: Partial<DaemonRemediationLockOperations> = {
        lstatSync: () => ({
          isFile: () => true,
          mode: 0o600,
          uid: (process.getuid?.() ?? 0) + 1,
        }) as never,
      };
      expect(recordDaemonRemediation({
        ...input(uidMarkerPath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: uidOps,
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const noUidPath = join(root, "no-uid.json");
      const originalGetUid = process.getuid;
      Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
      try {
        expect(recordDaemonRemediation({
          markerPath: noUidPath,
          scope: "scope-a",
          reason: "ambiguous",
          clock: () => 20_000,
        })).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
      } finally {
        Object.defineProperty(process, "getuid", { configurable: true, value: originalGetUid });
      }

      const defaultClockPath = join(root, "default-clock.json");
      expect(recordDaemonRemediation({
        markerPath: defaultClockPath,
        scope: "scope-a",
        reason: "absent",
      })).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("rejects a FIFO lock without blocking and does not follow it", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "fifo.json");
      const lockPath = `${markerPath}.lock`;
      execFileSync("mkfifo", [lockPath]);
      const started = Date.now();
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => 20_000)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reclaim a future lock after a clock rollback", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "rollback.json");
      const lockPath = `${markerPath}.lock`;
      writeFileSync(lockPath, JSON.stringify({ version: 1, nonce: "d".repeat(32), createdAtMs: 20_000 }), { mode: 0o600 });
      const started = Date.now();
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => 10_000)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds injected lock races and leaves ambiguous ownership untouched", () => {
    const root = makeRoot();
    try {
      const errorWithCode = (code: string): Error => Object.assign(new Error(code), { code });

      const writeFailurePath = join(root, "write-failure.json");
      expect(recordDaemonRemediation({
        ...input(writeFailurePath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          writePrivateFileExclusive: () => { throw errorWithCode("EACCES"); },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const eexistPath = join(root, "eexist.json");
      writeFileSync(`${eexistPath}.lock`, JSON.stringify({ version: 1, nonce: "e".repeat(32), createdAtMs: 20_000 }), { mode: 0o600 });
      expect(recordDaemonRemediation({
        ...input(eexistPath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          writePrivateFileExclusive: () => { throw errorWithCode("EEXIST"); },
          readBoundedRegularFileWithStat: () => { throw errorWithCode("EACCES"); },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const createdValidationPath = join(root, "created-validation.json");
      expect(recordDaemonRemediation({
        ...input(createdValidationPath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          writePrivateFileExclusive: () => true,
          readBoundedRegularFileWithStat: () => { throw errorWithCode("EACCES"); },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const disappearedPath = join(root, "disappeared.json");
      writeFileSync(`${disappearedPath}.lock`, JSON.stringify({ version: 1, nonce: "4".repeat(32), createdAtMs: 20_000 }), { mode: 0o600 });
      let disappearedReads = 0;
      expect(recordDaemonRemediation({
        ...input(disappearedPath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          writePrivateFileExclusive: () => false,
          readBoundedRegularFileWithStat: () => {
            disappearedReads += 1;
            throw errorWithCode(disappearedReads === 1 ? "ENOENT" : "EACCES");
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      expect(disappearedReads).toBe(2);

      const staleMismatchPath = join(root, "stale-mismatch.json");
      writeFileSync(`${staleMismatchPath}.lock`, JSON.stringify({ version: 1, nonce: "f".repeat(32), createdAtMs: 1 }), { mode: 0o600 });
      let mismatchReads = 0;
      expect(recordDaemonRemediation({
        ...input(staleMismatchPath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          writePrivateFileExclusive: () => false,
          readBoundedRegularFileWithStat: (path: string, options: BoundedFileOptions) => {
            mismatchReads += 1;
            if (mismatchReads === 2) {
              return {
                ...readBoundedRegularFileWithStat(path, options),
                content: `${JSON.stringify({ version: 1, nonce: "0".repeat(32), createdAtMs: 1 })}\n`,
              };
            }
            if (mismatchReads >= 3) throw errorWithCode("EACCES");
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const staleDeletePath = join(root, "stale-delete.json");
      writeFileSync(`${staleDeletePath}.lock`, JSON.stringify({ version: 1, nonce: "1".repeat(32), createdAtMs: 1 }), { mode: 0o600 });
      let deleteReads = 0;
      expect(recordDaemonRemediation({
        ...input(staleDeletePath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          writePrivateFileExclusive: () => false,
          readBoundedRegularFileWithStat: (path: string, options: BoundedFileOptions) => {
            deleteReads += 1;
            if (deleteReads >= 3) throw errorWithCode("EACCES");
            return readBoundedRegularFileWithStat(path, options);
          },
          deleteRegularFile: () => false,
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const staleMissingPath = join(root, "stale-missing.json");
      writeFileSync(`${staleMissingPath}.lock`, JSON.stringify({ version: 1, nonce: "2".repeat(32), createdAtMs: 1 }), { mode: 0o600 });
      let missingReads = 0;
      expect(recordDaemonRemediation({
        ...input(staleMissingPath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          writePrivateFileExclusive: () => false,
          readBoundedRegularFileWithStat: (path: string, options: BoundedFileOptions) => {
            missingReads += 1;
            if (missingReads === 2) throw errorWithCode("ENOENT");
            if (missingReads >= 3) throw errorWithCode("EACCES");
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const staleErrorPath = join(root, "stale-error.json");
      writeFileSync(`${staleErrorPath}.lock`, JSON.stringify({ version: 1, nonce: "5".repeat(32), createdAtMs: 1 }), { mode: 0o600 });
      let staleErrorReads = 0;
      expect(recordDaemonRemediation({
        ...input(staleErrorPath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          writePrivateFileExclusive: () => false,
          readBoundedRegularFileWithStat: (path: string, options: BoundedFileOptions) => {
            staleErrorReads += 1;
            if (staleErrorReads === 2) throw errorWithCode("EACCES");
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not delete a replaced or unreadable lock during release", () => {
    const root = makeRoot();
    try {
      const replacedPath = join(root, "replaced.json");
      let replacedReads = 0;
      expect(recordDaemonRemediation({
        ...input(replacedPath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          readBoundedRegularFileWithStat: (path: string, options: BoundedFileOptions) => {
            replacedReads += 1;
            const result = readBoundedRegularFileWithStat(path, options);
            if (replacedReads === 2) {
              return {
                ...result,
                content: `${JSON.stringify({ version: 1, nonce: "3".repeat(32), createdAtMs: 20_000 })}\n`,
              };
            }
            return result;
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
      expect(existsSync(`${replacedPath}.lock`)).toBe(true);

      const unreadablePath = join(root, "unreadable.json");
      let unreadableReads = 0;
      expect(recordDaemonRemediation({
        ...input(unreadablePath, "scope-a", "ambiguous", () => 20_000),
        _lockOperationsForTesting: {
          readBoundedRegularFileWithStat: (path: string, options: BoundedFileOptions) => {
            unreadableReads += 1;
            if (unreadableReads === 2) throw new Error("release read failed");
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
      expect(existsSync(`${unreadablePath}.lock`)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically creates a private marker and suppresses unchanged notices", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "state", "marker.json");
      let now = 10_000;
      const first = recordDaemonRemediation(input(markerPath, "scope-a", "live-no-response", () => now));
      expect(first).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
      expect(existsSync(markerPath)).toBe(true);
      expect(statSync(markerPath).mode & 0o777).toBe(0o600);
      const markerText = readFileSync(markerPath, "utf8");
      expect(markerText).not.toContain("scope-a");
      expect(markerText).not.toContain("/canonical");
      expect(markerText).toContain("live-no-response");

      now += DAEMON_NOTICE_REPEAT_INTERVAL_MS - 1;
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "live-no-response", () => now)))
        .toMatchObject({ emit: false, markerStatus: "suppressed" });

      now += 1;
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "live-no-response", () => now)))
        .toMatchObject({ emit: true, markerStatus: "re-emitted" });
      const read = readDaemonRemediationMarker({ markerPath });
      const key = `${daemonScopeDigest("scope-a")}:live-no-response`;
      expect(read.entries[key]).toMatchObject({ reason: "live-no-response", lastNotifiedAtMs: now });
      expect(read.markerIoError).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-emits on reason changes and keeps independent scopes keyed separately", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      let now = 20_000;
      recordDaemonRemediation(input(markerPath, "scope-a", "stale-config", () => now));
      const changed = recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => now));
      expect(changed).toMatchObject({ emit: true, markerStatus: "reason-changed" });
      recordDaemonRemediation(input(markerPath, "scope-b", "not-running", () => now));
      const read = readDaemonRemediationMarker({ markerPath });
      expect(Object.keys(read.entries)).toEqual([
        `${daemonScopeDigest("scope-a")}:ambiguous`,
        `${daemonScopeDigest("scope-b")}:not-running`,
      ].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes an invalid direct-call reason before persisting the marker", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      const rawReason = "ATTACK:/secret/pid=4";
      const result = recordDaemonRemediation({
        markerPath,
        scope: "scope-a",
        reason: rawReason as never,
        clock: () => 1,
      });

      expect(result.remediation.message).toBe(
        "lcm daemon unavailable (ambiguous); run 'lcm daemon restart' or 'lcm doctor'.",
      );
      const markerText = readFileSync(markerPath, "utf8");
      expect(markerText).not.toContain(rawReason);
      expect(markerText).not.toContain("secret");
      expect(markerText).not.toContain("pid=4");
      expect(readDaemonRemediationMarker({ markerPath }).entries).toEqual({
        [`${daemonScopeDigest("scope-a")}:ambiguous`]: {
          reason: "ambiguous",
          lastNotifiedAtMs: 1,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a clock rollback as an immediate transition", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      let now = 30_000;
      recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => now));
      now = 29_999;
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => now)))
        .toMatchObject({ emit: true, markerStatus: "re-emitted" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits when marker reads, writes, or the clock fail", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      const readFailureFs = {
        readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      };
      expect(recordDaemonRemediation({
        ...input(markerPath, "scope-a", "ambiguous", () => 1),
        fs: readFailureFs,
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const writeFailureFs = {
        writeFileSync: () => { throw new Error("read-only"); },
      };
      expect(recordDaemonRemediation({
        ...input(markerPath, "scope-a", "ambiguous", () => 2),
        fs: writeFailureFs,
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      expect(recordDaemonRemediation({
        ...input(markerPath, "scope-a", "ambiguous", () => Number.NaN),
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const cleanupPath = join(root, "cleanup-marker.json");
      const writeThenFailFs = {
        writeFileSync: (path: string, data: string, options: { encoding: BufferEncoding; mode: number; flag: string }) => {
          writeFileSync(path, data, options);
        },
        chmodSync: () => { throw new Error("chmod denied"); },
      };
      expect(recordDaemonRemediation({
        ...input(cleanupPath, "scope-a", "ambiguous", () => 3),
        fs: writeThenFailFs,
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows explicit scope digests and derives the marker from stateRoot", () => {
    const root = makeRoot();
    try {
      let now = 1;
      const explicit = "a".repeat(64);
      const result = recordDaemonRemediation({
        scope: "scope-a",
        scopeDigest: explicit,
        stateRoot: join(root, "state-root"),
        reason: "absent",
        clock: () => now,
      });
      expect(result.scopeDigest).toBe(explicit);
      expect(existsSync(daemonRemediationMarkerPath(join(root, "state-root")))).toBe(true);
      now = 2;
      expect(recordDaemonRemediation({
        scope: "scope-a",
        scopeDigest: "not-a-digest",
        markerPath: join(root, "other-marker"),
        reason: "absent",
        clock: () => now,
      }).scopeDigest).toBe(daemonScopeDigest("scope-a"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bounded remediation marker persistence", () => {
  it("accepts the exact byte boundary and emits on one byte over", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "boundary.json");
      const digest = daemonScopeDigest("scope-a");
      const base = JSON.stringify({
        version: 1,
        entries: {
          [`${digest}:ambiguous`]: { reason: "ambiguous", lastNotifiedAtMs: 1 },
        },
      });
      const exact = `${base}${" ".repeat(DAEMON_REMEDIATION_MARKER_MAX_BYTES - Buffer.byteLength(base))}`;
      expect(Buffer.byteLength(exact)).toBe(DAEMON_REMEDIATION_MARKER_MAX_BYTES);
      writeFileSync(markerPath, exact, { encoding: "utf8", mode: 0o600 });
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => 2)))
        .toMatchObject({ emit: false, markerStatus: "suppressed", markerIoError: false });

      writeFileSync(markerPath, `${exact} `, { encoding: "utf8", mode: 0o600 });
      expect(recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => 2)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const clockPath = join(root, "clock.json");
      expect(recordDaemonRemediation(input(
        clockPath,
        "scope-a",
        "ambiguous",
        () => DAEMON_REMEDIATION_MARKER_MAX_TIME_MS,
      ))).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
      expect(recordDaemonRemediation(input(
        clockPath,
        "scope-a",
        "ambiguous",
        () => DAEMON_REMEDIATION_MARKER_MAX_TIME_MS + 1,
      ))).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the maximum entry count, prunes the oldest deterministically, and rejects a flood", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "entries.json");
      const entries = markerEntries(DAEMON_REMEDIATION_MARKER_MAX_ENTRIES);
      writeMarkerDocument(markerPath, entries);
      const first = recordDaemonRemediation(input(markerPath, "new-scope", "ambiguous", () => 10_000));
      expect(first).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
      const retained = readDaemonRemediationMarker({ markerPath }).entries;
      expect(Object.keys(retained)).toHaveLength(DAEMON_REMEDIATION_MARKER_MAX_ENTRIES);
      expect(retained[`${daemonScopeDigest("generated-scope-0")}:live-no-response`]).toBeUndefined();
      expect(retained[`${daemonScopeDigest("new-scope")}:ambiguous`]).toEqual({
        reason: "ambiguous",
        lastNotifiedAtMs: 10_000,
      });

      const floodPath = join(root, "flood.json");
      writeMarkerDocument(floodPath, markerEntries(DAEMON_REMEDIATION_MARKER_MAX_ENTRIES + 1));
      expect(recordDaemonRemediation(input(floodPath, "scope-a", "ambiguous", () => 1)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      expect(readDaemonRemediationMarker({ markerPath: floodPath })).toMatchObject({
        exists: true,
        markerIoError: true,
        entries: {},
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes retained entries in stable order regardless of source insertion order", () => {
    const root = makeRoot();
    try {
      const firstPath = join(root, "first.json");
      const secondPath = join(root, "second.json");
      const entries = markerEntries(DAEMON_REMEDIATION_MARKER_MAX_ENTRIES - 1, () => 1);
      const reversed = Object.fromEntries(Object.entries(entries).reverse());
      writeMarkerDocument(firstPath, entries);
      writeMarkerDocument(secondPath, reversed);
      recordDaemonRemediation(input(firstPath, "new-scope", "ambiguous", () => 2));
      recordDaemonRemediation(input(secondPath, "new-scope", "ambiguous", () => 2));
      expect(readFileSync(firstPath, "utf8")).toBe(readFileSync(secondPath, "utf8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate, extra, mismatched, and out-of-range marker fields", () => {
    const root = makeRoot();
    try {
      const digest = daemonScopeDigest("scope-a");
      const cases: Array<[string, string]> = [
        ["duplicate.json", `{"version":1,"entries":{"${digest}:ambiguous":{"reason":"ambiguous","lastNotifiedAtMs":1},"${digest}:ambiguous":{"reason":"ambiguous","lastNotifiedAtMs":2}}}`],
        ["top-extra.json", JSON.stringify({ version: 1, entries: {}, extra: "secret=/tmp/path" })],
        ["entry-extra.json", JSON.stringify({ version: 1, entries: { [`${digest}:ambiguous`]: { reason: "ambiguous", lastNotifiedAtMs: 1, extra: "secret" } } })],
        ["mismatch.json", JSON.stringify({ version: 1, entries: { [`${digest}:ambiguous`]: { reason: "not-running", lastNotifiedAtMs: 1 } } })],
        ["invalid-entry.json", JSON.stringify({ version: 1, entries: { [`${digest}:ambiguous`]: { reason: "ambiguous", lastNotifiedAtMs: "1" } } })],
        ["time.json", JSON.stringify({ version: 1, entries: { [`${digest}:ambiguous`]: { reason: "ambiguous", lastNotifiedAtMs: DAEMON_REMEDIATION_MARKER_MAX_TIME_MS + 1 } } })],
        ["key.json", JSON.stringify({ version: 1, entries: { [`${digest}:${"a".repeat(DAEMON_REMEDIATION_MARKER_MAX_BYTES)}`]: { reason: "ambiguous", lastNotifiedAtMs: 1 } } })],
        ["array-entry.json", JSON.stringify({ version: 1, entries: { [`${digest}:ambiguous`]: [] } })],
        ["array-values.json", JSON.stringify({ version: 1, entries: { [`${digest}:ambiguous`]: [1, true, null, "value", {}] } })],
        ["array-unknown.json", `{"version":1,"entries":{"${digest}:ambiguous":[x]}}`],
        ["array-no-comma.json", `{"version":1,"entries":{"${digest}:ambiguous":[1 2]}}`],
        ["array-eof.json", `{"version":1,"entries":{"${digest}:ambiguous":[1,`],
        ["primitive-entry.json", JSON.stringify({ version: 1, entries: { [`${digest}:ambiguous`]: true } })],
        ["entries-array.json", '{"version":1,"entries":[]}'],
        ["top-number.json", "1"],
        ["top-negative-number.json", "-1"],
        ["top-negative.json", '{"version":-1,"entries":{}}'],
        ["top-string.json", "\"value\""],
        ["top-true.json", "true"],
        ["unknown-value.json", '{"version":1,"entries":{"x":x}}'],
        ["bad-colon.json", '{"version"=1}'],
        ["bad-comma.json", '{"version":1 "entries":{}}'],
        ["unterminated-object.json", '{"version":1'],
        ["object-eof.json", '{"version":1,'],
        ["value-eof.json", '{"version":'],
        ["unterminated-string.json", '{"unterminated:1}'],
        ["bad-escape.json", '{"bad\\x":1}'],
        ["trailing.json", '{"version":1,"entries":{}} trailing'],
      ];
      for (const [name, raw] of cases) {
        const markerPath = join(root, name);
        writeFileSync(markerPath, raw, { encoding: "utf8", mode: 0o600 });
        expect(recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => 2)))
          .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("rejects marker FIFO, symlink, hardlink, directory, and broad mode", () => {
    const root = makeRoot();
    try {
      const target = join(root, "target.json");
      writeMarkerDocument(target, {});
      const symlinkMarker = join(root, "symlink.json");
      symlinkSync(target, symlinkMarker);
      expect(recordDaemonRemediation(input(symlinkMarker, "scope-a", "ambiguous", () => 1)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      expect(readFileSync(target, "utf8")).not.toContain("scope-a");

      const hardlinkMarker = join(root, "hardlink.json");
      linkSync(target, hardlinkMarker);
      expect(recordDaemonRemediation(input(hardlinkMarker, "scope-a", "ambiguous", () => 1)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const directoryMarker = join(root, "directory.json");
      mkdirSync(directoryMarker);
      expect(recordDaemonRemediation(input(directoryMarker, "scope-a", "ambiguous", () => 1)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const modeMarker = join(root, "mode.json");
      writeMarkerDocument(modeMarker, {});
      chmodSync(modeMarker, 0o640);
      expect(recordDaemonRemediation(input(modeMarker, "scope-a", "ambiguous", () => 1)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const fifoMarker = join(root, "fifo.json");
      execFileSync("mkfifo", [fifoMarker]);
      expect(recordDaemonRemediation(input(fifoMarker, "scope-a", "ambiguous", () => 1)))
        .toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a marker owned by another uid without exposing its contents", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "owner.json");
      writeMarkerDocument(markerPath, {});
      let markerStats = 0;
      expect(typeof process.getuid).toBe("function");
      expect(recordDaemonRemediation({
        ...input(markerPath, "scope-a", "ambiguous", () => 1),
        fs: {
          lstatSync: path => {
            markerStats += 1;
            const stat = lstatSync(path);
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
              uid: (process.getuid?.() ?? 0) + 1,
            });
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      expect(markerStats).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps bounded-reader and legacy read seams bounded and fail-safe", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "seams.json");
      const raw = writeMarkerDocument(markerPath, {});
      expect(recordDaemonRemediation({
        ...input(markerPath, "scope-a", "ambiguous", () => 1),
        fs: {
          readBoundedRegularFileWithStat: (path, options) => ({
            ...readBoundedRegularFileWithStat(path, options),
            content: raw,
          }),
        },
      })).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
      expect(recordDaemonRemediation({
        ...input(markerPath, "scope-a", "ambiguous", () => 1),
        fs: { readFileSync: path => readFileSync(path, "utf8") },
      })).toMatchObject({ emit: false, markerStatus: "suppressed", markerIoError: false });
      const originalGetUid = process.getuid;
      Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
      try {
        expect(recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => 1)))
          .toMatchObject({ emit: false, markerStatus: "suppressed", markerIoError: false });
      } finally {
        Object.defineProperty(process, "getuid", { configurable: true, value: originalGetUid });
      }
      expect(recordDaemonRemediation({
        ...input(markerPath, "scope-a", "ambiguous", () => 1),
        fs: { readFileSync: () => "x".repeat(DAEMON_REMEDIATION_MARKER_MAX_BYTES + 1) },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const missingPath = join(root, "missing.json");
      expect(recordDaemonRemediation({
        ...input(missingPath, "scope-a", "ambiguous", () => 1),
        fs: { readFileSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } },
      })).toMatchObject({ emit: true, markerStatus: "created", markerIoError: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when marker growth or replacement races the bounded read", () => {
    const root = makeRoot();
    try {
      const growthPath = join(root, "growth.json");
      writeMarkerDocument(growthPath, {});
      let growthReads = 0;
      expect(recordDaemonRemediation({
        ...input(growthPath, "scope-a", "ambiguous", () => 1),
        fs: {
          lstatSync: path => {
            growthReads += 1;
            if (growthReads === 2) appendFileSync(path, " ");
            return lstatSync(path);
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });

      const replacementPath = join(root, "replacement.json");
      writeMarkerDocument(replacementPath, {});
      let replacementReads = 0;
      expect(recordDaemonRemediation({
        ...input(replacementPath, "scope-a", "ambiguous", () => 1),
        fs: {
          lstatSync: path => {
            replacementReads += 1;
            if (replacementReads === 2) {
              rmSync(path);
              writeMarkerDocument(path, {});
            }
            return lstatSync(path);
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      expect(existsSync(replacementPath)).toBe(true);
      expect(readFileSync(replacementPath, "utf8")).not.toContain("scope-a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a recycled inode identity has changed timestamps", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "timestamp-race.json");
      const raw = writeMarkerDocument(markerPath, {});
      let markerReads = 0;
      expect(recordDaemonRemediation({
        ...input(markerPath, "scope-a", "ambiguous", () => 1),
        fs: {
          lstatSync: path => {
            markerReads += 1;
            const stat = lstatSync(path);
            if (markerReads !== 2) return stat;
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
              ctimeMs: stat.ctimeMs + 1,
            });
          },
        },
      })).toMatchObject({ emit: true, markerStatus: "unavailable", markerIoError: true });
      expect(markerReads).toBe(2);
      expect(readFileSync(markerPath, "utf8")).toBe(raw);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("daemon remediation clearing", () => {
  it("fails closed when a live lock blocks marker clearing", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "blocked-marker.json");
      writeFileSync(`${markerPath}.lock`, JSON.stringify({
        version: 1,
        nonce: "6".repeat(32),
        createdAtMs: Date.now(),
      }), { mode: 0o600 });
      expect(clearDaemonRemediation({ markerPath, scope: "scope-a" })).toEqual({
        cleared: false,
        markerIoError: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears one scope after healthy/safe recovery and removes the empty marker", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      const clock = () => 1;
      recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", clock));
      recordDaemonRemediation(input(markerPath, "scope-b", "not-running", clock));
      expect(clearDaemonRemediation({ markerPath, scope: "scope-a" })).toEqual({
        cleared: true,
        markerIoError: false,
      });
      expect(readDaemonRemediationMarker({ markerPath }).entries).toEqual({
        [`${daemonScopeDigest("scope-b")}:not-running`]: {
          reason: "not-running",
          lastNotifiedAtMs: 1,
        },
      });
      expect(clearDaemonRemediation({ markerPath, scope: "scope-missing" })).toEqual({
        cleared: false,
        markerIoError: false,
      });
      expect(clearDaemonRemediation({ markerPath, scope: "scope-b" })).toEqual({
        cleared: true,
        markerIoError: false,
      });
      expect(existsSync(markerPath)).toBe(false);
      expect(clearDaemonRemediation({ markerPath, scope: "scope-b" })).toEqual({
        cleared: false,
        markerIoError: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains malformed markers and reports clear I/O failures", () => {
    const root = makeRoot();
    try {
      const malformed = join(root, "malformed.json");
      writeFileSync(malformed, "{broken", { mode: 0o600 });
      expect(clearDaemonRemediation({ markerPath: malformed, scope: "scope-a" })).toEqual({
        cleared: false,
        markerIoError: true,
      });
      expect(existsSync(malformed)).toBe(true);
      writeFileSync(malformed, "{broken", { mode: 0o600 });
      expect(clearDaemonRemediation({
        markerPath: malformed,
        scope: "scope-a",
        fs: { unlinkSync: () => { throw new Error("busy"); } },
      })).toEqual({ cleared: false, markerIoError: true });
      expect(existsSync(malformed)).toBe(true);

      const markerPath = join(root, "marker.json");
      recordDaemonRemediation(input(markerPath, "scope-a", "ambiguous", () => 1));
      const unlinkFailureFs = { unlinkSync: () => { throw new Error("busy"); } };
      expect(clearDaemonRemediation({ markerPath, scope: "scope-a", fs: unlinkFailureFs })).toEqual({
        cleared: false,
        markerIoError: true,
      });

      expect(clearDaemonRemediation({ scope: "scope-a" })).toEqual({
        cleared: false,
        markerIoError: true,
      });
      expect(readDaemonRemediationMarker({}).markerIoError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports malformed marker reads without exposing their contents", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      mkdirSync(root, { recursive: true });
      writeFileSync(markerPath, JSON.stringify({ version: 99, entries: {} }));
      const read = readDaemonRemediationMarker({ markerPath });
      expect(read).toMatchObject({ exists: true, markerIoError: true, entries: {} });
      const validDigest = daemonScopeDigest("scope-a");
      writeFileSync(markerPath, JSON.stringify({
        version: 1,
        entries: {
          [`${validDigest}:ambiguous`]: { reason: "not-running", lastNotifiedAtMs: 1 },
          [`${validDigest}:response-invalid`]: null,
        },
      }));
      expect(readDaemonRemediationMarker({ markerPath }).entries).toEqual({});
      writeFileSync(markerPath, "null");
      expect(readDaemonRemediationMarker({ markerPath })).toMatchObject({
        exists: true,
        markerIoError: true,
        entries: {},
      });
      chmodSync(markerPath, 0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
