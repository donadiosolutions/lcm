/**
 * Semantic checks on rehearsal evidence that a schema cannot express. The integration test applies the scenario checks to
 * every run, and the gate assembler applies the same checks plus the completeness checks to the final run.
 */
export interface ManifestSpec {
  readonly id: string;
  readonly gate?: { readonly status?: string };
  readonly profiles: readonly string[];
  readonly knownLimits: readonly unknown[];
  readonly invariants: Readonly<Record<string, string>>;
  readonly authority: readonly { readonly checkpoint: string; readonly lastCommittedBackend: string }[];
}
export interface ManifestShape { readonly scenarios: readonly ManifestSpec[] }

interface ScenarioRecord {
  readonly id: string;
  readonly verdict: string;
  readonly invariants: Readonly<Record<string, { readonly status: string; readonly reason?: string }>>;
  readonly authority: readonly { readonly checkpoint: string; readonly lastCommittedBackend: string }[];
}
export interface RehearsalShape {
  readonly manifestSha256: string;
  readonly profile: string;
  readonly focused: boolean;
  readonly runtime: string | null;
  readonly runId: string | null;
  readonly pending: readonly { readonly id: string }[];
  readonly missing: readonly string[];
  readonly scenarios: readonly ScenarioRecord[];
  readonly provenance: { readonly dirty: boolean; readonly unchangedAfterRun: boolean } | null;
  readonly cleanup: { readonly scenarioHomes: string };
}

/** Per-scenario conditions: required invariants passed, authority pins agree, and the verdict follows from them. */
export function scenarioProblems(record: ScenarioRecord, spec: ManifestSpec | undefined): string[] {
  if (spec === undefined) return [record.id + ": not in the manifest"];
  const problems: string[] = [];
  for (const key of ["I1", "I2", "I3", "I4", "I5", "I6"]) {
    const declared = spec.invariants[key] ?? "required";
    const actual = record.invariants[key];
    if (actual === undefined) { problems.push(record.id + " " + key + ": missing"); continue; }
    if (actual.status === "fail") problems.push(record.id + " " + key + ": failed");
    else if (declared === "required" && actual.status !== "pass") problems.push(record.id + " " + key + ": required but " + actual.status);
    else if (declared.startsWith("na:") && (actual.status !== "not-applicable" || actual.reason !== declared.slice(3))) problems.push(record.id + " " + key + ": differs from the manifest's not-applicable declaration");
  }
  for (const entry of record.authority) {
    const pinned = spec.authority.find((candidate) => candidate.checkpoint === entry.checkpoint);
    if (pinned === undefined) problems.push(record.id + ": unknown authority checkpoint " + entry.checkpoint);
    else if (pinned.lastCommittedBackend !== entry.lastCommittedBackend) problems.push(record.id + ": committed backend at " + entry.checkpoint);
  }
  if (record.verdict === "fail" || record.verdict === "incomplete") problems.push(record.id + ": verdict " + record.verdict);
  const expected = spec.knownLimits.length > 0 ? "pass-with-documented-limits" : "pass";
  if (problems.length === 0 && record.verdict !== expected) problems.push(record.id + ": verdict " + record.verdict + " != " + expected);
  return problems;
}

/** Whole-run conditions for a complete gate: full profile, nothing filtered, nothing pending, exact manifest membership. */
export function completenessProblems(rehearsal: RehearsalShape, manifest: ManifestShape, manifestSha256: string): string[] {
  const problems: string[] = [];
  if (rehearsal.profile !== "full") problems.push("profile " + rehearsal.profile + " is not the full profile");
  if (rehearsal.focused) problems.push("the run was restricted to selected rows");
  // Pending rows come from the checked-in manifest, never from the run's own record of them.
  const manifestPending = manifest.scenarios.filter((spec) => spec.gate?.status === "pending").map((spec) => spec.id).sort();
  if (manifestPending.length > 0) problems.push("the checked-in manifest still lists pending rows: " + manifestPending.join(","));
  if (JSON.stringify(rehearsal.pending.map((entry) => entry.id).sort()) !== JSON.stringify(manifestPending)) problems.push("the recorded pending rows differ from the checked-in manifest");
  if (rehearsal.missing.length > 0) problems.push("selected rows produced no result: " + rehearsal.missing.join(","));
  if (rehearsal.manifestSha256 !== manifestSha256) problems.push("the run used a different manifest than the checked-in one");
  const expected = manifest.scenarios.filter((spec) => spec.gate === undefined && spec.profiles.includes("full")).map((spec) => spec.id).sort();
  const ids = rehearsal.scenarios.map((record) => record.id);
  if (new Set(ids).size !== ids.length) problems.push("duplicate scenario results");
  if (JSON.stringify([...ids].sort()) !== JSON.stringify(expected)) problems.push("scenario membership differs from the checked-in manifest");
  if (rehearsal.provenance === null) problems.push("no execution provenance");
  else {
    if (rehearsal.provenance.dirty) problems.push("the tested tree was dirty");
    if (!rehearsal.provenance.unchangedAfterRun) problems.push("tested inputs or the CLI changed during the run");
  }
  if (rehearsal.cleanup.scenarioHomes !== "verified-absent") problems.push("scenario cleanup is incomplete");
  if (rehearsal.runtime === null) problems.push("no container runtime recorded");
  if (rehearsal.runId === null) problems.push("no harness run id recorded");
  return problems;
}

