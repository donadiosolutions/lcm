import { describe, expect, it } from "vitest";
import {
  DATABASE_IDENTITY_SQL,
  buildMachineContainerArgs,
  phaseDeadlineMs,
  recoveryWindowSearch,
} from "../../scripts/certification-harness.mjs";
import {
  normalizeFirewallRules,
} from "../../scripts/certification-digitalocean.mjs";
import {
  classifyTlsRejection,
  machineStoredConfig,
} from "./machine-agent.mjs";
import {
  cleanupVerdict,
  clockVerdict,
  reconcileAttemptIdentity,
  reconcileOracleBijection,
  recoveryVerdicts,
} from "../../scripts/certification-gate.mjs";
import contract from "./contract-v1.json";
import { cleanupHarnessResources, createRunNames } from "../../scripts/postgresql-harness.mjs";

describe("round 2 certification acceptance helpers", () => {
  it("uses CURRENT_USER as a SQL value expression", () => {
    expect(DATABASE_IDENTITY_SQL).toContain("CURRENT_USER::text");
    expect(DATABASE_IDENTITY_SQL).not.toContain("pg_catalog.current_user");
  });

  it("maps private rootless mounts to uid and gid 1000", () => {
    const args = buildMachineContainerArgs({
      machine: "a", name: "machine-a", hostname: "machine-a", network: "network",
      image: "node@sha256:" + "a".repeat(64), ownerLabels: { kind: "machine-a" },
      stagedPackage: "/stage", homeParent: "/home-parent", caFile: "/ca", wrongCaFile: "/wrong-ca",
      evidenceDirectory: "/evidence", environmentFile: "/env",
    });
    expect(args).toContain("--userns=keep-id:uid=1000,gid=1000");
  });

  it("requires the lane migration role without persisting the protected value", () => {
    expect(JSON.stringify(machineStoredConfig({ LCM_CERT_MIGRATION_ROLE: "lcm_test_migrator" }))).not.toContain("migrationRole");
    expect(() => machineStoredConfig({})).toThrow("migration role");
  });

  it("derives phase deadlines from the contract instead of a 360 second default", () => {
    expect(phaseDeadlineMs(contract, "full", "fault-ready")).toBeGreaterThan(6_000_000);
    expect(phaseDeadlineMs(contract, "smoke", "drain")).toBeGreaterThanOrEqual(660_000);
  });

  it("finds the first separate-kind sliding recovery window", () => {
    const clearedAt = Date.parse("2026-10-26T10:00:00.000Z");
    const samples = [
      ...Array.from({ length: 12 }, (_, index) => ({ machine: "a", op: "search", scheduledWallMs: clearedAt + 1000 + index * 5000, wallEndedAt: new Date(clearedAt + 2000 + index * 5000).toISOString(), outcome: index === 0 ? "failed" : "success" })),
      ...Array.from({ length: 6 }, (_, index) => ({ machine: "a", op: "store", scheduledWallMs: clearedAt + 3000 + index * 10000, wallEndedAt: new Date(clearedAt + 4000 + index * 10000).toISOString(), outcome: "success" })),
    ];
    expect(recoveryWindowSearch(samples, { machine: "a", clearedAtMs: clearedAt, deadlineMs: clearedAt + 180_000 })).toMatchObject({ pass: true });
  });

  it("applies fail over incomplete for clock and cleanup verdicts", () => {
    expect(clockVerdict([{ radiusMs: 300, verdict: "fail" }, { verdict: "incomplete" }], 250)).toBe("fail");
    expect(cleanupVerdict({ verdict: "incomplete", residualResources: 0 })).toBe("incomplete");
    expect(cleanupVerdict({ verdict: "pass", residualResources: 1 })).toBe("fail");
  });

  it("requires exact scheduled attempt identities and an oracle bijection", () => {
    expect(reconcileAttemptIdentity([{ id: "a", machine: "a", op: "search" }], [{ id: "a", machine: "a", op: "search" }])).toEqual({ missing: [], duplicate: [], unexpected: [], mismatched: [] });
    expect(reconcileAttemptIdentity([{ id: "a", machine: "a", op: "search" }], [{ id: "a", machine: "a", op: "search" }, { id: "a", machine: "a", op: "search" }]).duplicate).toEqual(["a"]);
    expect(reconcileOracleBijection([
      { invocationId: "i1", outcome: "success" }, { invocationId: "i2", outcome: "failed" },
    ], [{ invocationId: "i1", eventUuid: "e1" }, { invocationId: "i2", eventUuid: "e2" }], { e1: { inboxIds: ["r1"] }, e2: { inboxIds: ["r2"] } })).toMatchObject({ verdict: "pass" });
    expect(reconcileOracleBijection([{ invocationId: "i1", outcome: "success" }], [{ invocationId: "i1", eventUuid: "e1" }, { invocationId: "i1", eventUuid: "e2" }], {})).toMatchObject({ verdict: "incomplete" });
  });

  it("normalizes enriched firewall metadata but rejects extra access", () => {
    expect(normalizeFirewallRules([{ type: "ip_addr", value: "203.0.113.8", uuid: "u", cluster_uuid: "c", created_at: "now" }])).toEqual([{ type: "ip_addr", value: "203.0.113.8" }]);
    expect(normalizeFirewallRules([{ type: "ip_addr", value: "203.0.113.8" }, { type: "ip_addr", value: "203.0.113.9" }])).toHaveLength(2);
  });

  it("classifies TLS failures emitted on stdout", () => {
    expect(classifyTlsRejection({ stdout: "hostname does not match certificate", stderr: "" })).toBe("certificate-name");
  });

  it("requires all recovery predicates rather than timestamp-only RTO", () => {
    expect(recoveryVerdicts({ firstSuccessSeconds: 31, outageSeconds: 60, rtoSeconds: 120, catchUpSeconds: 10 }, { firstSuccess: 30, outage: 120, rto: 180, catchUp: 900 })).toMatchObject({ verdict: "fail" });
  });

  it("preserves the exact five-resource cleanup when includeMachines is false", async () => {
    const names = createRunNames("a".repeat(32));
    const removed: string[] = [];
    await cleanupHarnessResources({ names, runId: "a".repeat(32), directory: "/private/run", sentinelReady: false, includeMachines: false }, {
      removeResource: (type: string, name: string) => { removed.push(`${type}:${name}`); },
      removeDirectory: () => undefined,
    });
    expect(removed).toEqual([
      `container:${names.restore}`, `container:${names.runner}`, `container:${names.container}`,
      `volume:${names.volume}`, `network:${names.network}`,
    ]);
  });
});
