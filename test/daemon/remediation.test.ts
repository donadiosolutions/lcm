import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  DAEMON_NOTICE_REPEAT_INTERVAL_MS,
  DAEMON_REFUSAL_REASONS,
  DAEMON_REMEDIATION_MARKER_NAME,
  clearDaemonRemediation,
  daemonRemediationMarkerPath,
  daemonScopeDigest,
  isDaemonRefusalReason,
  mapDaemonRefusalToRemediation,
  readDaemonRemediationMarker,
  recordDaemonRemediation,
} from "../../src/daemon/remediation.js";

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

describe("daemon remediation clearing", () => {
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

  it("best-effort clears malformed markers and reports clear I/O failures", () => {
    const root = makeRoot();
    try {
      const malformed = join(root, "malformed.json");
      writeFileSync(malformed, "{broken", { mode: 0o600 });
      expect(clearDaemonRemediation({ markerPath: malformed, scope: "scope-a" })).toEqual({
        cleared: true,
        markerIoError: false,
      });
      writeFileSync(malformed, "{broken", { mode: 0o600 });
      expect(clearDaemonRemediation({
        markerPath: malformed,
        scope: "scope-a",
        fs: { unlinkSync: () => { throw new Error("busy"); } },
      })).toEqual({ cleared: false, markerIoError: true });

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
