import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashProjectPath,
  normalizeProjectPath,
  projectMapPath,
  readProjectMapIdentity,
  readProjectMapSnapshot,
  resolveProjectIdentity,
  UnauthenticatedProjectIdentityError,
} from "../src/project-map.js";
import { BackendPublicationCoordinator, type BackendPublicationDriver } from "../src/storage/backend-publication.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-read-identity-"));
  roots.push(homeDir);
  mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
  const cwd = join(homeDir, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const canonical = normalizeProjectPath(cwd);
  return { homeDir, cwd, canonical, hash: hashProjectPath(canonical) };
}

function writeMap(homeDir: string, map: Record<string, unknown>): void {
  writeFileSync(projectMapPath(homeDir), JSON.stringify(map), { mode: 0o600 });
}

function snapshotOfHome(homeDir: string): string {
  const entries = readdirSync(join(homeDir, ".lcm"), { recursive: true }).map(String).sort();
  return JSON.stringify(entries.map((name) => [name, name === "map.json" ? readFileSync(projectMapPath(homeDir), "utf8") : null]));
}

async function holdMaintenance(homeDir: string): Promise<void> {
  const refuse = async (): Promise<never> => { throw new Error("v2 driver must not run"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: refuse, publishProjectMap: refuse, publishConfig: refuse, restoreConfig: refuse, restoreProjectMap: refuse,
  };
  await new BackendPublicationCoordinator({ homeDir, driver }).enterMaintenance({
    publicationId: "maintenance-publication", generationId: "generation-1",
    sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
    roster: [{ machineId: "018f0b5d-1234-4abc-8def-1234567890ab", queueCutoff: null, evidenceSha256: "a".repeat(64) }],
  });
}

describe("readProjectMapIdentity (plan-v5 Part B (3): the held-safe local identity read)", () => {
  it("returns null for an absent map and creates nothing", () => {
    const f = fixture();
    const before = snapshotOfHome(f.homeDir);
    expect(readProjectMapIdentity({ homeDir: f.homeDir, cwd: f.cwd })).toBeNull();
    expect(snapshotOfHome(f.homeDir)).toBe(before);
  });

  it("returns null when the map has no entry for the project, leaving the map bytes unchanged", () => {
    const f = fixture();
    writeMap(f.homeDir, { [hashProjectPath("/somewhere/else")]: { canonical: "/somewhere/else", aliases: [] } });
    const before = snapshotOfHome(f.homeDir);
    expect(readProjectMapIdentity({ homeDir: f.homeDir, cwd: f.cwd })).toBeNull();
    expect(snapshotOfHome(f.homeDir)).toBe(before);
  });

  it("returns a persisted entry, including its remote binding, without taking any lock or writing anything", () => {
    const f = fixture();
    writeMap(f.homeDir, { [f.hash]: { canonical: f.canonical, aliases: [], remoteProjectId: "01990000-0000-7000-8000-000000000001" } });
    const before = snapshotOfHome(f.homeDir);
    expect(readProjectMapIdentity({ homeDir: f.homeDir, cwd: f.cwd })).toEqual({
      id: f.hash, canonical: f.canonical, remoteProjectId: "01990000-0000-7000-8000-000000000001",
    });
    expect(snapshotOfHome(f.homeDir)).toBe(before);
  });

  it("works while a maintenance hold fences every consumer read, where the locked snapshot reader refuses (red: this is why resolveProjectIdentity is unfit under a held journal)", async () => {
    const f = fixture();
    writeMap(f.homeDir, { [f.hash]: { canonical: f.canonical, aliases: [] } });
    await holdMaintenance(f.homeDir);
    expect(() => readProjectMapSnapshot(f.homeDir)).toThrow();
    expect(readProjectMapIdentity({ homeDir: f.homeDir, cwd: f.cwd })).toEqual({ id: f.hash, canonical: f.canonical });
  });

  it("threads homeDir into the metadata corroboration of a legacy key, not the ambient home", () => {
    const f = fixture();
    const legacy = "c".repeat(64);
    writeMap(f.homeDir, { [legacy]: { canonical: f.canonical, aliases: [] } });
    // Unauthenticated until the project's own metadata, under THIS home, binds the canonical path.
    expect(() => readProjectMapIdentity({ homeDir: f.homeDir, cwd: f.cwd })).toThrow(UnauthenticatedProjectIdentityError);
    const projectDir = join(f.homeDir, ".lcm", "projects", legacy);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd: f.cwd }), { mode: 0o600 });
    expect(readProjectMapIdentity({ homeDir: f.homeDir, cwd: f.cwd })).toEqual({ id: legacy, canonical: f.canonical });
  });

  it("throws on an invalid map instead of treating it as no entry", () => {
    const f = fixture();
    writeFileSync(projectMapPath(f.homeDir), "{ not json", { mode: 0o600 });
    expect(() => readProjectMapIdentity({ homeDir: f.homeDir, cwd: f.cwd })).toThrow();
  });
});

describe("resolveProjectIdentity with an explicit homeDir (the fresh-mint step of plan-v5 Part B (3))", () => {
  it("mints the entry into that home's map, and the held-safe reader then returns exactly what it minted", () => {
    const f = fixture();
    const minted = resolveProjectIdentity(f.cwd, { homeDir: f.homeDir });
    expect(minted).toEqual({ id: f.hash, canonical: f.canonical });
    expect(JSON.parse(readFileSync(projectMapPath(f.homeDir), "utf8"))[f.hash]).toMatchObject({ canonical: f.canonical });
    expect(readProjectMapIdentity({ homeDir: f.homeDir, cwd: f.cwd })).toEqual(minted);
  });

  it("returns an existing entry from that home without rewriting the map", () => {
    const f = fixture();
    writeMap(f.homeDir, { [f.hash]: { canonical: f.canonical, aliases: [] } });
    const before = snapshotOfHome(f.homeDir);
    expect(resolveProjectIdentity(f.cwd, { homeDir: f.homeDir })).toEqual({ id: f.hash, canonical: f.canonical });
    expect(snapshotOfHome(f.homeDir)).toBe(before);
  });
});
