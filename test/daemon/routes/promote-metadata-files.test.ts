import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { makeMockStorageFactory } from "./mock-storage-factory.js";

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

import { createPromoteHandler } from "../../../src/daemon/routes/promote.js";

const config = loadDaemonConfig("/tmp/promote-metadata-files");
const response = {} as never;
const tempDirs: string[] = [];

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
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-promote-metadata-"));
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
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
});
