import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDaemonNotice,
  emitDaemonNotice,
  formatDaemonNotice,
  maybeEmitDaemonNotice,
  sanitizeDaemonRefusalReason,
} from "../../src/hooks/daemon-notice.js";
import { daemonRemediationMarkerPath } from "../../src/daemon/remediation.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "lcm-daemon-notice-test-"));
}

describe("hook daemon notices", () => {
  it("sanitizes malformed reasons and emits only fixed guidance", () => {
    expect(sanitizeDaemonRefusalReason("/secret/path pid=12")).toBe("ambiguous");
    expect(sanitizeDaemonRefusalReason("manager-unavailable")).toBe("manager-unavailable");
    const message = formatDaemonNotice("/secret/path pid=12 token=secret");
    expect(message).toBe("lcm daemon unavailable (ambiguous); run 'lcm daemon restart' or 'lcm doctor'.");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("/secret");
  });

  it("writes a first notice, suppresses repeats, and clears on safe recovery", () => {
    const root = makeRoot();
    try {
      const markerPath = join(root, "marker.json");
      let now = 100;
      const output: string[] = [];
      const first = emitDaemonNotice({
        scope: "/canonical/state-root",
        markerPath,
        reason: "not-running",
        clock: () => now,
        write: message => output.push(message),
      });
      expect(first.emit).toBe(true);
      expect(output).toEqual(["lcm daemon unavailable (not-running); run 'lcm daemon start'.\n"]);
      expect(emitDaemonNotice({
        scope: "/canonical/state-root",
        markerPath,
        reason: "not-running",
        clock: () => now,
        write: message => output.push(message),
      }).emit).toBe(false);
      expect(output).toHaveLength(1);
      expect(clearDaemonNotice({ scope: "/canonical/state-root", markerPath })).toEqual({
        cleared: true,
        markerIoError: false,
      });
      expect(existsSync(markerPath)).toBe(false);

      now += 1;
      expect(maybeEmitDaemonNotice({
        scope: "/canonical/state-root",
        stateRoot: root,
        reason: "absent",
        clock: () => now,
        write: message => output.push(message),
      }).emit).toBe(true);
      expect(existsSync(daemonRemediationMarkerPath(root))).toBe(true);

      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(emitDaemonNotice({
          scope: "/canonical/second-state-root",
          markerPath: join(root, "stderr-marker.json"),
          reason: "ambiguous",
          clock: () => now,
        }).emit).toBe(true);
        expect(stderrWrite).toHaveBeenCalledWith(
          "lcm daemon unavailable (ambiguous); run 'lcm daemon restart' or 'lcm doctor'.\n",
        );
      } finally {
        stderrWrite.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits despite marker or writer failures and never throws from hooks", () => {
    const root = makeRoot();
    try {
      const output: string[] = [];
      const readFailureFs = {
        readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      };
      const decision = emitDaemonNotice({
        scope: "/canonical/state-root",
        markerPath: join(root, "read-failure.json"),
        reason: "live-no-response",
        fs: readFailureFs,
        write: message => output.push(message),
      });
      expect(decision).toMatchObject({ emit: true, markerIoError: true, markerStatus: "unavailable" });
      expect(output[0]).toContain("live-no-response");

      expect(() => emitDaemonNotice({
        scope: "/canonical/state-root",
        markerPath: join(root, "write-failure.json"),
        reason: "startup-failure",
        fs: { writeFileSync: () => { throw new Error("read-only"); } },
        write: () => { throw new Error("closed stderr"); },
      })).not.toThrow();

      expect(() => emitDaemonNotice({
        scope: "/canonical/state-root",
        reason: "ambiguous",
        write: () => { throw new Error("closed stderr"); },
      })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports clear failures without crashing the hook", () => {
    expect(clearDaemonNotice({ scope: "/canonical/state-root" })).toEqual({
      cleared: false,
      markerIoError: true,
    });
    expect(clearDaemonNotice({
      scope: 42 as never,
      markerPath: "/tmp/daemon-notice-invalid-scope.json",
    })).toEqual({ cleared: false, markerIoError: true });
  });
});
