import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { makeMockStorageFactory } from "./mock-storage-factory.js";
import type { BoundedFileOptions } from "../../../src/security-files.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  projectIdentity: vi.fn((cwd: string) => ({
    id: "metadata-project",
    localProjectId: "metadata-project",
    canonical: cwd,
  })),
  projectPathsForIdentity: vi.fn(),
  ensureProjectDir: vi.fn(),
  projectExists: vi.fn(async () => true),
  openProject: vi.fn(),
  closeProject: vi.fn(async () => undefined),
  closeFactory: vi.fn(async () => undefined),
  conversations: vi.fn(async () => [] as unknown[]),
  summaries: vi.fn(async () => [] as unknown[]),
  prefixes: vi.fn(async () => [] as string[]),
  scrubForProject: vi.fn(async () => ({ scrub: (content: string) => content })),
  beforeMetadataRead: vi.fn(),
  afterMetadataRead: vi.fn(),
  beforeBoundedReader: vi.fn(),
  afterBoundedReader: vi.fn(),
  afterMetadataWrite: vi.fn(),
}));

vi.mock("../../../src/daemon/project.js", () => ({
  MAX_PROJECT_METADATA_BYTES: 1024 * 1024,
  projectIdentity: mocks.projectIdentity,
  projectPathsForIdentity: mocks.projectPathsForIdentity,
  ensureProjectDirForIdentity: mocks.ensureProjectDir,
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: (cwd: string) => cwd }));
vi.mock("../../../src/scrub.js", () => ({ ScrubEngine: { forProject: mocks.scrubForProject } }));
vi.mock("../../../src/storage/index.js", () => ({ createStorageBackendFactory: vi.fn() }));
vi.mock("../../../src/promotion/detector.js", () => ({
  shouldPromote: () => ({ promote: false, tags: [], confidence: 0 }),
}));
vi.mock("../../../src/promotion/dedup.js", () => ({ deduplicateAndInsert: vi.fn() }));
vi.mock("../../../src/security-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/security-files.js")>();
  return {
    ...actual,
    readBoundedRegularFile: (path: string, options: BoundedFileOptions): string => {
      const content = actual.readBoundedRegularFile(path, {
        ...options,
        _beforeReadForTesting: mocks.beforeMetadataRead,
      });
      mocks.afterMetadataRead();
      return content;
    },
    readBoundedRegularFileWithStat: (path: string, options: BoundedFileOptions) => {
      mocks.beforeBoundedReader();
      const result = actual.readBoundedRegularFileWithStat(path, {
        ...options,
        _beforeReadForTesting: mocks.beforeMetadataRead,
      });
      mocks.afterMetadataRead();
      mocks.afterBoundedReader();
      return result;
    },
    atomicWritePrivateFile: (...args: Parameters<typeof actual.atomicWritePrivateFile>) => {
      actual.atomicWritePrivateFile(...args);
      mocks.afterMetadataWrite();
    },
  };
});

import { createPromoteHandler } from "../../../src/daemon/routes/promote.js";

const config = loadDaemonConfig("/tmp/promote-metadata-files");
const response = {} as never;
const tempDirs: string[] = [];
const fixtureRoots: string[] = [];

function resetProject(tempDir: string): void {
  const paths = {
    id: "metadata-project",
    localProjectId: "metadata-project",
    canonical: "/integration/project",
    dir: tempDir,
    dbPath: join(tempDir, "db.sqlite"),
    metaPath: join(tempDir, "meta.json"),
  };
  mocks.projectPathsForIdentity.mockReturnValue(paths);
  mocks.ensureProjectDir.mockReturnValue(tempDir);
  mocks.openProject.mockResolvedValue({
    conversations: { listConversations: mocks.conversations },
    summaries: { getSummariesByConversation: mocks.summaries },
    promotedMemory: { listContentPrefixes: mocks.prefixes },
    lexicalSearch: {},
    transaction: vi.fn(),
    close: mocks.closeProject,
  });
}

describe("promote metadata files", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    const fixtureRoot = mkdtempSync(join(tmpdir(), "lcm-promote-metadata-"));
    fixtureRoots.push(fixtureRoot);
    const tempDir = join(fixtureRoot, ".lcm", "projects", "metadata-project");
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    tempDirs.push(tempDir);
    resetProject(tempDir);
    mocks.projectIdentity.mockImplementation((cwd: string) => ({
      id: "metadata-project",
      localProjectId: "metadata-project",
      canonical: cwd,
    }));
    mocks.projectExists.mockResolvedValue(true);
    mocks.conversations.mockResolvedValue([]);
    mocks.summaries.mockResolvedValue([]);
    mocks.prefixes.mockResolvedValue([]);
    mocks.scrubForProject.mockResolvedValue({ scrub: (content: string) => content });
    mocks.beforeMetadataRead.mockReset();
    mocks.afterMetadataRead.mockReset();
    mocks.beforeBoundedReader.mockReset();
    mocks.afterBoundedReader.mockReset();
    mocks.afterMetadataWrite.mockReset();
  });

  afterEach(() => {
    tempDirs.splice(0);
    for (const dir of fixtureRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates private metadata with canonical identity and no temporary residue", async () => {
    const tempDir = tempDirs[0]!;
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.closeFactory,
    }))({} as never, response, JSON.stringify({ cwd: "/integration/project" }));

    const metadataPath = join(tempDir, "meta.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({ cwd: "/integration/project" });
    expect(metadata.lastPromote).toEqual(expect.any(String));
    expect(lstatSync(metadataPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(tempDir).filter(name => /^\.meta\.json\..+\.tmp$/u.test(name))).toEqual([]);
  });

  it.each(["root", "projects"] as const)(
    "refuses a preexisting %s symlink instead of publishing through it",
    async (component) => {
      const projectDir = tempDirs[0]!;
      const projectsDir = join(projectDir, "..");
      const rootDir = join(projectsDir, "..");
      const fixtureRoot = fixtureRoots[0]!;
      const alternateRoot = join(fixtureRoot, "alternate-root");
      const alternateProjects = join(alternateRoot, "projects");
      const alternateProject = join(alternateProjects, "metadata-project");
      mkdirSync(alternateProject, { recursive: true, mode: 0o700 });
      const originalMetadata = join(projectDir, "meta.json");
      const alternateMetadata = join(alternateProject, "meta.json");
      const ancestor = component === "root" ? rootDir : projectsDir;
      const displacedAncestor = `${ancestor}-original`;
      const displacedMetadata = component === "root"
        ? join(displacedAncestor, "projects", "metadata-project", "meta.json")
        : join(displacedAncestor, "metadata-project", "meta.json");
      const original = JSON.stringify({ retained: "original" });
      writeFileSync(originalMetadata, original, {
        encoding: "utf8",
        mode: 0o600,
      });
      writeFileSync(alternateMetadata, JSON.stringify({ retained: "alternate" }), {
        encoding: "utf8",
        mode: 0o600,
      });

      renameSync(ancestor, displacedAncestor);
      symlinkSync(component === "root" ? alternateRoot : alternateProjects, ancestor);

      await createPromoteHandler(config, makeMockStorageFactory({
        projectExists: mocks.projectExists,
        openProject: mocks.openProject,
        close: mocks.closeFactory,
      }))({} as never, response, JSON.stringify({ cwd: "/integration/project" }));

      expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
        error: "project directory topology changed before metadata publication",
      });
      expect(readFileSync(displacedMetadata, "utf8")).toBe(original);
      expect(readFileSync(alternateMetadata, "utf8")).toBe(JSON.stringify({ retained: "alternate" }));
      expect(readdirSync(alternateProject).filter(
        name => /^\.meta\.json\..+\.tmp$/u.test(name),
      )).toEqual([]);
    },
  );

  it("tightens a benign legacy metadata mode while retaining unrelated keys", async () => {
    const tempDir = tempDirs[0]!;
    const metadataPath = join(tempDir, "meta.json");
    writeFileSync(metadataPath, JSON.stringify({
      retained: "value",
      cwd: "/old",
      lastPromote: "1970-01-01T00:00:00.000Z",
    }), "utf8");
    chmodSync(metadataPath, 0o664);
    const before = JSON.parse(readFileSync(metadataPath, "utf8")) as { lastPromote?: string };

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.closeFactory,
    }))({} as never, response, JSON.stringify({ cwd: "/integration/project" }));

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({ retained: "value", cwd: "/integration/project" });
    expect(metadata.lastPromote).toEqual(expect.any(String));
    expect(Date.parse(String(metadata.lastPromote))).toBeGreaterThan(Date.parse(String(before.lastPromote)));
    expect(lstatSync(metadataPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(tempDir).filter(name => /^\.meta\.json\..+\.tmp$/u.test(name))).toEqual([]);
  });

  it.each([
    ["during", mocks.beforeMetadataRead, "project directory topology changed before metadata publication"],
    ["after", mocks.afterMetadataRead, "project directory topology changed before metadata publication"],
  ])("fails closed when the metadata parent is replaced %s a bounded read", async (
    _when,
    replaceParent,
    expectedError,
  ) => {
    const tempDir = tempDirs[0]!;
    const displacedDir = `${tempDir}-displaced`;
    tempDirs.push(displacedDir);
    const metadataPath = join(tempDir, "meta.json");
    const displacedMetadataPath = join(displacedDir, "meta.json");
    const original = JSON.stringify({ retained: "original" });
    const replacement = JSON.stringify({ retained: "replacement" });
    writeFileSync(metadataPath, original, { encoding: "utf8", mode: 0o600 });
    replaceParent.mockImplementationOnce(() => {
      renameSync(tempDir, displacedDir);
      mkdirSync(tempDir, { mode: 0o700 });
      writeFileSync(metadataPath, replacement, { encoding: "utf8", mode: 0o600 });
    });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.closeFactory,
    }))({} as never, response, JSON.stringify({ cwd: "/integration/project" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: expectedError,
    });
    expect(readFileSync(metadataPath, "utf8")).toBe(replacement);
    expect(readFileSync(displacedMetadataPath, "utf8")).toBe(original);
    expect(readdirSync(tempDir).filter(name => /^\.meta\.json\..+\.tmp$/u.test(name))).toEqual([]);
    expect(readdirSync(displacedDir).filter(name => /^\.meta\.json\..+\.tmp$/u.test(name))).toEqual([]);
  });

  it("rejects metadata read from a sampled replacement after the admitted parent is restored", async () => {
    const admittedDir = tempDirs[0]!;
    const displacedDir = `${admittedDir}-displaced`;
    const replacementDir = `${admittedDir}-replacement`;
    tempDirs.push(displacedDir, replacementDir);
    const admittedMetadataPath = join(admittedDir, "meta.json");
    const replacementMetadataPath = join(replacementDir, "meta.json");
    const original = JSON.stringify({ retained: "original" });
    const replacement = JSON.stringify({ retained: "replacement" });
    writeFileSync(admittedMetadataPath, original, { encoding: "utf8", mode: 0o600 });
    mocks.beforeBoundedReader.mockImplementationOnce(() => {
      renameSync(admittedDir, displacedDir);
      mkdirSync(admittedDir, { mode: 0o700 });
      writeFileSync(admittedMetadataPath, replacement, { encoding: "utf8", mode: 0o600 });
    });
    mocks.afterBoundedReader.mockImplementationOnce(() => {
      renameSync(admittedDir, replacementDir);
      renameSync(displacedDir, admittedDir);
    });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.closeFactory,
    }))({} as never, response, JSON.stringify({ cwd: "/integration/project" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
    expect(readFileSync(admittedMetadataPath, "utf8")).toBe(original);
    expect(readFileSync(replacementMetadataPath, "utf8")).toBe(replacement);
    expect(readdirSync(admittedDir).filter(name => /^\.meta\.json\..+\.tmp$/u.test(name))).toEqual([]);
    expect(readdirSync(replacementDir).filter(name => /^\.meta\.json\..+\.tmp$/u.test(name))).toEqual([]);
  });

  it.each([
    ["root", "during", mocks.beforeMetadataRead],
    ["root", "before publication", mocks.afterMetadataRead],
    ["projects", "during", mocks.beforeMetadataRead],
    ["projects", "before publication", mocks.afterMetadataRead],
  ] as const)(
    "fails closed when the %s entry is renamed and replaced %s metadata processing",
    async (component, _when, replaceAncestor) => {
      const projectDir = tempDirs[0]!;
      const projectsDir = join(projectDir, "..");
      const rootDir = join(projectsDir, "..");
      const ancestor = component === "root" ? rootDir : projectsDir;
      const displacedAncestor = `${ancestor}-displaced`;
      const displacedProject = component === "root"
        ? join(displacedAncestor, "projects", "metadata-project")
        : join(displacedAncestor, "metadata-project");
      const metadataPath = join(projectDir, "meta.json");
      const original = JSON.stringify({ retained: "original" });
      writeFileSync(metadataPath, original, { encoding: "utf8", mode: 0o600 });
      replaceAncestor.mockImplementationOnce(() => {
        renameSync(ancestor, displacedAncestor);
        symlinkSync(displacedAncestor, ancestor);
      });

      await createPromoteHandler(config, makeMockStorageFactory({
        projectExists: mocks.projectExists,
        openProject: mocks.openProject,
        close: mocks.closeFactory,
      }))({} as never, response, JSON.stringify({ cwd: "/integration/project" }));

      expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
        error: "project directory topology changed before metadata publication",
      });
      expect(readFileSync(join(displacedProject, "meta.json"), "utf8")).toBe(original);
      expect(readdirSync(displacedProject).filter(
        name => /^\.meta\.json\..+\.tmp$/u.test(name),
      )).toEqual([]);
    },
  );

  it("reports post-publication projects drift after the authenticated leaf was updated", async () => {
    const projectDir = tempDirs[0]!;
    const projectsDir = join(projectDir, "..");
    const displacedProjects = `${projectsDir}-postwrite`;
    const metadataPath = join(projectDir, "meta.json");
    writeFileSync(metadataPath, JSON.stringify({ retained: "original" }), {
      encoding: "utf8",
      mode: 0o600,
    });
    mocks.afterMetadataWrite.mockImplementationOnce(() => {
      renameSync(projectsDir, displacedProjects);
      symlinkSync(displacedProjects, projectsDir);
    });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.closeFactory,
    }))({} as never, response, JSON.stringify({ cwd: "/integration/project" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "project directory topology changed before metadata publication",
    });
    const updated = JSON.parse(readFileSync(
      join(displacedProjects, "metadata-project", "meta.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(updated).toMatchObject({
      retained: "original",
      cwd: "/integration/project",
      lastPromote: expect.any(String),
    });
  });
});
