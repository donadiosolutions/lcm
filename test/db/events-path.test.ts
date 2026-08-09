import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  eventSequenceDbPath,
  eventsDbPath,
  eventsDir,
  existingEventsDbPath,
} from "../../src/db/events-path.js";
import { hashProjectPath, normalizeProjectIdentityPath, normalizeProjectPath, projectMapPath } from "../../src/project-map.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { openPrivateDirectory } from "../../src/security-files.js";

describe("backend-independent local project identity", () => {
  let previousHome: string | undefined;
  let home: string;
  let project: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "lcm-events-path-home-"));
    project = mkdtempSync(join(tmpdir(), "lcm-events-path-project-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const prepareDeletedLinkedWorktree = (): {
    primary: string;
    linked: string;
    anchorId: string;
    anchorSidecar: string;
    evidencePath: string;
  } => {
    const primary = mkdtempSync(join(tmpdir(), "lcm-events-path-primary-"));
    const linked = mkdtempSync(join(tmpdir(), "lcm-events-path-linked-"));
    const admin = join(primary, ".git", "worktrees", "linked");
    mkdirSync(join(primary, ".git", "objects"), { recursive: true });
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(primary, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(primary, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
    writeFileSync(join(admin, "HEAD"), "ref: refs/heads/linked\n");
    writeFileSync(join(admin, "commondir"), "../..\n");
    writeFileSync(join(linked, ".git"), `gitdir: ${admin}\n`);
    writeFileSync(join(admin, "gitdir"), `${join(linked, ".git")}\n`);

    const anchorId = hashProjectPath(normalizeProjectIdentityPath(primary));
    const anchorSidecar = eventsDbPath(linked);
    const evidenceFiles = readdirSync(eventsDir()).filter((entry) => entry.endsWith(".identity.json"));
    expect(evidenceFiles).toHaveLength(1);
    const evidencePath = join(eventsDir(), evidenceFiles[0]!);
    rmSync(linked, { recursive: true, force: true });
    return { primary, linked, anchorId, anchorSidecar, evidencePath };
  };

  it("keeps the sidecar ID stable while an existing map switches keys", () => {
    const canonical = normalizeProjectIdentityPath(project);
    const stableId = hashProjectPath(canonical);
    const legacyId = "a".repeat(64);
    const mapPath = projectMapPath();
    const publish = (id: string): void => {
      const temporaryPath = `${mapPath}.${id}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({
        [id]: { canonical, aliases: [] },
      }), { mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, mapPath);
    };

    publish(legacyId);
    const expected = eventsDbPath(project);
    expect(expected).toBe(join(home, ".lcm", "events", `${stableId}.db`));
    for (let index = 0; index < 8; index += 1) {
      publish(index % 2 === 0 ? stableId : legacyId);
      expect(eventsDbPath(project)).toBe(expected);
    }
  });

  it("keeps the existing-only probe read-only while recovering an orphaned sidecar", () => {
    const unavailable = join(project, "gone");
    expect(existingEventsDbPath(unavailable)).toBeUndefined();
    expect(existingEventsDbPath("/lcm-events-path-missing-cwd")).toBeUndefined();
    expect(existsSync(eventsDir())).toBe(false);
    expect(existsSync(projectMapPath())).toBe(false);

    const sidecarDir = join(home, ".lcm", "events");
    mkdirSync(sidecarDir, { recursive: true, mode: 0o700 });
    const existingSidecar = join(sidecarDir, `${hashProjectPath(normalizeProjectIdentityPath(project))}.db`);
    writeFileSync(existingSidecar, "");
    expect(existingEventsDbPath(project)).toBe(existingSidecar);

    const mappedId = "b".repeat(64);
    writeFileSync(projectMapPath(), JSON.stringify({
      [mappedId]: { canonical: project, aliases: [] },
    }), { mode: 0o600 });
    chmodSync(projectMapPath(), 0o600);
    expect(existingEventsDbPath(project)).toBe(join(sidecarDir, `${mappedId}.db`));
    rmSync(projectMapPath(), { force: true });

    const sidecar = join(sidecarDir, `${hashProjectPath(normalizeProjectPath(unavailable))}.db`);
    writeFileSync(sidecar, "");
    expect(existingEventsDbPath(unavailable)).toBe(sidecar);

    const malformedGitMarker = join(project, ".git");
    writeFileSync(malformedGitMarker, "not-a-gitdir\n");
    const malformedUnavailable = join(project, "malformed-gone");
    const malformedSidecar = join(
      sidecarDir,
      `${hashProjectPath(normalizeProjectPath(malformedUnavailable))}.db`,
    );
    writeFileSync(malformedSidecar, "");
    expect(existingEventsDbPath(malformedUnavailable)).toBe(malformedSidecar);
    rmSync(malformedGitMarker, { force: true });

    expect(existsSync(projectMapPath())).toBe(false);
  });

  it("recovers the anchor sidecar after the entire linked-worktree root disappears", () => {
    const { primary, linked, anchorId, anchorSidecar, evidencePath } = prepareDeletedLinkedWorktree();
    try {
      const unavailable = linked;
      expect(anchorSidecar).toBe(join(
        eventsDir(),
        `${anchorId}.db`,
      ));
      expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
      expect(existsSync(projectMapPath())).toBe(false);
      expect(existsSync(join(home, ".lcm", "projects"))).toBe(false);

      expect(existsSync(linked)).toBe(false);
      expect(existingEventsDbPath(unavailable)).toBeUndefined();
      writeFileSync(anchorSidecar, "");
      expect(existingEventsDbPath(unavailable)).toBe(anchorSidecar);

      for (const invalidEvidence of [
        "[]",
        JSON.stringify({
          version: 1,
          cwd: unavailable,
          canonical: primary,
          id: anchorId,
          unexpected: true,
        }),
        JSON.stringify({
          version: 2,
          cwd: unavailable,
          canonical: primary,
          id: anchorId,
        }),
        "{",
      ]) {
        writeFileSync(evidencePath, invalidEvidence);
        expect(existingEventsDbPath(unavailable)).toBeUndefined();
      }

      const legacySidecar = join(
        eventsDir(),
        `${hashProjectPath(normalizeProjectPath(unavailable))}.db`,
      );
      writeFileSync(legacySidecar, "");
      expect(existingEventsDbPath(unavailable)).toBe(legacySidecar);
      expect(existsSync(projectMapPath())).toBe(false);
      expect(existsSync(join(home, ".lcm", "projects"))).toBe(false);
    } finally {
      rmSync(primary, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it("rejects wrong-owner identity evidence without mutating recovery state", () => {
    const { primary, linked, anchorSidecar, evidencePath } = prepareDeletedLinkedWorktree();
    try {
      writeFileSync(anchorSidecar, "");
      const evidenceBefore = statSync(evidencePath);
      const directoryBefore = statSync(eventsDir());
      const effectiveUid = typeof process.getuid === "function" ? process.getuid() : 0;

      expect(existingEventsDbPath(linked, {
        _effectiveUidForTesting: () => effectiveUid + 1,
        _openEventsDirectoryForTesting: (path: string) => openPrivateDirectory(path),
      })).toBeUndefined();
      expect(statSync(evidencePath)).toMatchObject({
        uid: evidenceBefore.uid,
        mode: evidenceBefore.mode,
        size: evidenceBefore.size,
        mtimeMs: evidenceBefore.mtimeMs,
      });
      expect(statSync(eventsDir())).toMatchObject({
        uid: directoryBefore.uid,
        mode: directoryBefore.mode,
        mtimeMs: directoryBefore.mtimeMs,
      });
      expect(existingEventsDbPath(linked)).toBe(anchorSidecar);
    } finally {
      rmSync(primary, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it("rejects wrong-owner and unsafe-mode events directories without repair", () => {
    const { primary, linked, anchorSidecar } = prepareDeletedLinkedWorktree();
    try {
      writeFileSync(anchorSidecar, "");
      const effectiveUid = typeof process.getuid === "function" ? process.getuid() : 0;
      const entries = readdirSync(eventsDir()).sort();

      expect(existingEventsDbPath(linked, {
        _effectiveUidForTesting: () => effectiveUid + 1,
      })).toBeUndefined();
      expect(statSync(eventsDir()).mode & 0o777).toBe(0o700);
      expect(readdirSync(eventsDir()).sort()).toEqual(entries);

      expect(existingEventsDbPath(linked, {
        _openEventsDirectoryForTesting: (
          path: string,
          options: { readonly expectedUid?: number },
        ) => {
          const handle = openPrivateDirectory(path, options);
          chmodSync(path, 0o755);
          return handle;
        },
      })).toBeUndefined();
      expect(statSync(eventsDir()).mode & 0o777).toBe(0o755);
      expect(readdirSync(eventsDir()).sort()).toEqual(entries);

      chmodSync(eventsDir(), 0o700);
      chmodSync(eventsDir(), 0o755);
      expect(existingEventsDbPath(linked)).toBeUndefined();
      expect(statSync(eventsDir()).mode & 0o777).toBe(0o755);
      expect(readdirSync(eventsDir()).sort()).toEqual(entries);

      chmodSync(eventsDir(), 0o700);
      expect(existingEventsDbPath(linked)).toBe(anchorSidecar);

      const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
      Object.defineProperty(process, "getuid", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: undefined,
      });
      try {
        expect(existingEventsDbPath(linked)).toBe(anchorSidecar);
      } finally {
        if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
        else Reflect.deleteProperty(process, "getuid");
      }
      expect(existsSync(projectMapPath())).toBe(false);
      expect(existsSync(join(home, ".lcm", "projects"))).toBe(false);
    } finally {
      chmodSync(eventsDir(), 0o700);
      rmSync(primary, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });
});

describe("eventsDbPath", () => {
  it("returns a path under ~/.lcm/events/", () => {
    const result = eventsDbPath("/some/project");
    expect(result).toMatch(/\.lcm\/events\/.+\.db$/);
  });

  it("produces consistent paths for the same cwd", () => {
    const a = eventsDbPath("/some/project");
    const b = eventsDbPath("/some/project");
    expect(a).toBe(b);
  });

  it("produces different paths for different cwds", () => {
    const a = eventsDbPath("/project/a");
    const b = eventsDbPath("/project/b");
    expect(a).not.toBe(b);
  });
});

describe("eventsDir", () => {
  it("returns ~/.lcm/events", () => {
    expect(eventsDir()).toBe(join(homedir(), ".lcm", "events"));
  });

  it("accepts an explicit home directory", () => {
    expect(eventsDir("/srv/lcm-user")).toBe("/srv/lcm-user/.lcm/events");
  });
});

describe("eventSequenceDbPath", () => {
  it("keeps the machine-global allocator beside the project sidecars", () => {
    expect(eventSequenceDbPath("/srv/lcm-user"))
      .toBe("/srv/lcm-user/.lcm/events/.machine-sequence.sqlite");
  });
});
