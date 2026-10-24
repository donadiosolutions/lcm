import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateEvidence } from "./check-evidence.ts";
import { captureProvenance } from "./provenance.ts";
import { completenessProblems, scenarioProblems, type ManifestShape, type RehearsalShape } from "./semantics.ts";

/**
 * Assembles the outer cleanup receipt and the gate record after the PostgreSQL harness has exited. It reads the
 * repository and the evidence directory only. The container runtime must be named explicitly through
 * LCM_TEST_CONTAINER_CLI and must be the runtime the run recorded; there is no default. A missing or failed query,
 * receipt or witness makes the gate incomplete, never clean.
 */
const RUN_LABEL = "com.donadiosolutions.lcm.postgresql-test-run";
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function argumentsOf(argv: readonly string[]): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) throw new Error("expected --name value pairs");
    parsed.set(name, [...(parsed.get(name) ?? []), value]);
  }
  return parsed;
}

function query(cli: string, kind: "container" | "network" | "volume", runId: string): { readonly exitCode: number; readonly remaining: string[] } {
  const args = kind === "container"
    ? ["ps", "-a", "--format", "{{.Names}}", "--filter", "label=" + RUN_LABEL + "=" + runId]
    : [kind, "ls", "--format", "{{.Name}}", "--filter", "label=" + RUN_LABEL + "=" + runId];
  try {
    return { exitCode: 0, remaining: execFileSync(cli, args, { encoding: "utf8" }).split("\n").filter((line) => line !== "") };
  } catch {
    return { exitCode: 1, remaining: [] };
  }
}

/** True when the recorded pid:start witness no longer names a live process (Linux /proc). */
function exited(witness: string): boolean {
  const [pid, start] = witness.split(":") as [string, string];
  if (start === "exited") return true;
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== start;
  } catch {
    return true;
  }
}

export function main(argv: readonly string[]): number {
  const args = argumentsOf(argv);
  const one = (name: string): string => {
    const value = args.get(name)?.[0];
    if (value === undefined) throw new Error("missing " + name);
    return value;
  };
  const root = process.cwd();
  const evidence = one("--evidence");
  const cli = process.env.LCM_TEST_CONTAINER_CLI;
  if (cli === undefined || cli === "") throw new Error("name the container runtime explicitly with LCM_TEST_CONTAINER_CLI");
  const rehearsal = JSON.parse(readFileSync(join(evidence, "rehearsal.json"), "utf8")) as RehearsalShape & {
    scenarios: (RehearsalShape["scenarios"][number] & { knownLimits: unknown[] })[]; database?: { serverVersion: string; serverVersionNum: string };
    provenance: Record<string, unknown> & { testedCommit: string; testedInputsSha256: string; cliSha256: string; lockfileSha256: string; testedInputsCount: number; node: string; dirty: boolean; unchangedAfterRun: boolean } | null;
    ownedProcesses: string[]; homeRoots: string[]; profile: "default" | "full";
  };
  const manifestBytes = readFileSync(join(root, "test/postgresql/cutover-rehearsal/scenarios.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ManifestShape & { workload: { bounds: unknown; thresholds: unknown } };

  const problems: string[] = [];
  const failures: string[] = [];
  for (const record of rehearsal.scenarios) failures.push(...scenarioProblems(record, manifest.scenarios.find((spec) => spec.id === record.id)));
  problems.push(...completenessProblems(rehearsal, manifest, sha256(manifestBytes)));

  // Bind the evidence to the allocation: the one harness run id and the runtime that created it.
  const runIds = args.get("--run-id") ?? [];
  if (runIds.length !== 1 || runIds[0] !== rehearsal.runId) problems.push("the allocated run id does not match the run recorded in the evidence");
  if (rehearsal.runtime !== cli) problems.push("the container runtime differs from the one that executed the run");
  const queries = runIds.flatMap((runId) => (["container", "network", "volume"] as const).map((resource) => ({ runId, resource, ...query(cli, resource, runId) })));
  const queriesOk = queries.length > 0 && queries.every((entry) => entry.exitCode === 0);
  const residue = queries.flatMap((entry) => entry.remaining);
  const harnessExited = one("--harness-exit") === "0";
  const tempRootsAbsent = rehearsal.homeRoots.length > 0 && rehearsal.homeRoots.every((path) => !existsSync(path));
  const ownedProcessesExited = rehearsal.ownedProcesses.length > 0 && rehearsal.ownedProcesses.every(exited);
  const cleanup = {
    runtime: cli, runIds,
    containers: queries.filter((entry) => entry.resource === "container").flatMap((entry) => entry.remaining),
    networks: queries.filter((entry) => entry.resource === "network").flatMap((entry) => entry.remaining),
    volumes: queries.filter((entry) => entry.resource === "volume").flatMap((entry) => entry.remaining),
    queries, harnessExited, tempRootsAbsent, ownedProcessesExited,
    verdict: !queriesOk || !harnessExited || !tempRootsAbsent || !ownedProcessesExited ? "unverified" : residue.length > 0 ? "residue" : "clean",
  };
  if (cleanup.verdict !== "clean") problems.push("outer cleanup is " + cleanup.verdict);

  // The recorded execution witnesses must still describe the checked-out inputs and the built CLI.
  let source = rehearsal.provenance;
  if (source !== null) {
    const now = captureProvenance(root);
    if (now.testedCommit !== source.testedCommit || now.testedInputsSha256 !== source.testedInputsSha256 || now.cliSha256 !== source.cliSha256 || now.lockfileSha256 !== source.lockfileSha256) {
      problems.push("the checkout or the built CLI no longer matches what the run executed");
    }
    if (now.dirty) problems.push("the checkout is dirty");
    source = { ...source };
  }

  const image = execFileSync("node", ["-e", "import('./scripts/postgresql-images.mjs').then((m)=>process.stdout.write(m.POSTGRES_IMAGE))"], { encoding: "utf8" });
  const observed = (() => {
    try { return execFileSync(cli, ["image", "inspect", "--format", "{{.Digest}}", image], { encoding: "utf8" }).trim(); } catch { return "unavailable"; }
  })();
  if (observed === "unavailable" || !image.endsWith("@" + observed)) problems.push("the observed database image digest is unavailable or differs from the pinned reference");
  const limited = rehearsal.scenarios.some((scenario) => scenario.verdict === "pass-with-documented-limits");
  const verdict = failures.length > 0 ? "fail" : problems.length > 0 ? "incomplete" : limited ? "pass-with-documented-limits" : "pass";
  const gate = {
    schemaVersion: 1,
    source: source === null ? null : {
      testedCommit: source.testedCommit, dirty: source.dirty, testedInputsSha256: source.testedInputsSha256, testedInputsCount: source.testedInputsCount,
      lockfileSha256: source.lockfileSha256, cliSha256: source.cliSha256, node: source.node,
      pnpm: (() => { try { return execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(); } catch { return "unavailable"; } })(),
    },
    database: { imageReference: image, observedImageDigest: observed, serverVersion: rehearsal.database?.serverVersion ?? "unavailable", serverVersionNum: rehearsal.database?.serverVersionNum ?? "unavailable" },
    workload: { profile: rehearsal.profile, workers: 1, bounds: manifest.workload.bounds, thresholds: manifest.workload.thresholds },
    commands: (args.get("--command") ?? []).map((entry) => {
      const [command, exitCode, elapsedSeconds, runId] = entry.split("::");
      return { command: command ?? "", exitCode: Number(exitCode), elapsedSeconds: Number(elapsedSeconds), runId: runId ?? "" };
    }),
    problems: [...failures, ...problems].slice(0, 64).map((problem) => problem.slice(0, 300)),
    rehearsal, cleanup, verdict,
  };
  const schema = JSON.parse(readFileSync(join(root, "test/postgresql/cutover-rehearsal/evidence-schema.json"), "utf8")) as Record<string, unknown>;
  const errors = validateEvidence(schema, JSON.parse(JSON.stringify(gate)) as unknown, "#/$defs/gate");
  writeFileSync(one("--out"), JSON.stringify(gate, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write("verdict " + verdict + "; cleanup " + cleanup.verdict + "; problems " + String(gate.problems.length) + "; schema errors " + String(errors.length) + "\n"
    + [...gate.problems, ...errors].slice(0, 30).join("\n") + "\n");
  return errors.length === 0 && (verdict === "pass" || verdict === "pass-with-documented-limits") ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));

