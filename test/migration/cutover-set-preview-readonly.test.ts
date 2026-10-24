import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCutoverSet, resolveCutoverSetCandidate } from "../../src/migration/cutover-set-prepare.js";
import { makeEnv, prepareInput, targetConfig, type Env } from "../fixtures/cutover-set-prepare.js";

/** Every file under the LCM home (but not lock files) with its bytes: the map, its backups and everything else. */
function snapshotHome(homeDir: string): Record<string, string> {
  const root = join(homeDir, ".lcm");
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (name.endsWith(".lock")) continue;
      files[relative(root, path)] = readFileSync(path).toString("base64");
    }
  };
  walk(root);
  return files;
}

const MAP_STATES = ["absent", "stale"] as const;
type MapState = (typeof MAP_STATES)[number];

/**
 * The fixture home has project metadata but no map: every project reaches the map through metadata backfill.
 * The stale state starts a map that lacks the second project, so a backfill would also take a backup.
 */
function backfillPending(env: Env, state: MapState): string {
  const [first, second] = env.projects;
  const mapPath = join(env.homeDir, ".lcm", "map.json");
  if (state === "stale") {
    writeFileSync(mapPath, JSON.stringify({ [first!.id]: { canonical: first!.cwd, aliases: [] } }) + "\n", { mode: 0o600 });
    expect(Object.keys(JSON.parse(readFileSync(mapPath, "utf8")) as object)).toEqual([first!.id]);
  } else {
    expect(existsSync(mapPath)).toBe(false);
  }
  expect(existsSync(join(second!.projectDir, "meta.json"))).toBe(true);
  return second!.id;
}

describe.each(MAP_STATES)("#1670: a cutover-set preview or confirmation fence writes nothing (%s map)", (state) => {
  it("resolves the candidate without publishing the project-map metadata backfill", async () => {
    const env = await makeEnv();
    backfillPending(env, state);
    const before = snapshotHome(env.homeDir);

    const candidate = await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() });

    expect(candidate).toMatchObject({ status: "candidate", disposition: "fresh" });
    expect(snapshotHome(env.homeDir)).toEqual(before);
    expect(existsSync(join(env.homeDir, ".lcm", "oldmaps"))).toBe(false);
  }, 60000);

  it("refuses a moved confirmation before any pre-confirmation write", async () => {
    const env = await makeEnv();
    backfillPending(env, state);
    const before = snapshotHome(env.homeDir);

    const result = await prepareCutoverSet(prepareInput(env, "moved-set-id"));

    expect(result).toMatchObject({ status: "refuse", reason: "confirmation-generation-moved" });
    expect(env.calls).toEqual([]);
    expect(snapshotHome(env.homeDir)).toEqual(before);
  }, 60000);

  it("still publishes the backfill once the confirmed set is prepared after the preview", async () => {
    const env = await makeEnv();
    const missing = backfillPending(env, state);
    const candidate = await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() });
    if (candidate.status !== "candidate") throw new Error("expected a candidate");

    const result = await prepareCutoverSet(prepareInput(env, candidate.setId));

    expect(result.status).toBe("prepared");
    expect(Object.keys(JSON.parse(readFileSync(join(env.homeDir, ".lcm", "map.json"), "utf8")) as object)).toContain(missing);
  }, 60000);
});
