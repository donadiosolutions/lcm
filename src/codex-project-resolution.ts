import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  extractCodexSessionMeta,
  findAllCodexTranscripts,
  type CodexSessionFile,
  type CodexSessionMetadata,
} from "./codex-transcript.js";
import { resolveGitProjectAnchor } from "./git-project.js";
import {
  hashProjectPath,
  listProjectMapEntries,
  normalizeProjectPath,
  type ProjectMap,
  type ProjectMapEntry,
} from "./project-map.js";
import { readBoundedRegularFile } from "./security-files.js";

const MAX_CODEX_THREAD_METADATA_BYTES = 16 * 1024;

type VerifiedProject = {
  readonly hash: string;
  readonly canonical: string;
  readonly commonDir: string;
  readonly repositoryUrl?: string;
};

export type CodexProjectResolution =
  | {
    readonly status: "resolved";
    readonly canonical: string;
    readonly projectHash: string;
    readonly evidence: "live-git" | "mapped-path" | "thread-owner" | "repository-tombstone";
  }
  | {
    readonly status: "unresolved" | "ambiguous";
    readonly reason: string;
  };

export type CodexResolvedSession = CodexSessionFile & {
  readonly metadata?: CodexSessionMetadata;
  readonly resolution: CodexProjectResolution;
};

type CodexProjectIndex = {
  readonly map: ProjectMap;
  readonly projects: VerifiedProject[];
  readonly threadOwners: Map<string, VerifiedProject[]>;
  readonly codexDir: string;
};

function isDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return false;
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function isResolvableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function entryPaths(entry: ProjectMapEntry): string[] {
  return [entry.canonical, ...entry.aliases].map((path) => resolve(path));
}

function repositoryUrl(canonical: string): string | undefined {
  try {
    const output = execFileSync(
      "git",
      ["-C", canonical, "config", "--get", "remote.origin.url"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 2_000,
        windowsHide: true,
      },
    ).trim();
    return output;
  } catch {
    return undefined;
  }
}

function addThreadOwner(
  owners: Map<string, VerifiedProject[]>,
  threadId: string,
  project: VerifiedProject,
): void {
  const current = owners.get(threadId) ?? [];
  if (!current.some((candidate) => candidate.commonDir === project.commonDir)) {
    current.push(project);
  }
  owners.set(threadId, current);
}

function readThreadOwners(project: VerifiedProject, owners: Map<string, VerifiedProject[]>): void {
  const root = join(project.commonDir, "worktrees");
  if (!isDirectory(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const metadataPath = join(root, entry.name, "codex-thread.json");
    if (!existsSync(metadataPath)) continue;
    try {
      const metadata = JSON.parse(readBoundedRegularFile(metadataPath, {
        allowedRoot: join(root, entry.name),
        maxBytes: MAX_CODEX_THREAD_METADATA_BYTES,
      })) as { version?: unknown; ownerThreadId?: unknown };
      if (
        metadata.version === 1
        && typeof metadata.ownerThreadId === "string"
        && metadata.ownerThreadId
      ) {
        addThreadOwner(owners, metadata.ownerThreadId, project);
      }
    } catch {
      // Malformed ownership metadata is never evidence.
    }
  }
}

function buildProjectIndex(codexDir?: string): CodexProjectIndex {
  const map = listProjectMapEntries();
  const byCommonDir = new Map<string, VerifiedProject>();
  for (const [hash, entry] of Object.entries(map)) {
    for (const path of entryPaths(entry)) {
      if (!isDirectory(path)) continue;
      const anchor = resolveGitProjectAnchor(path);
      if (!anchor) continue;
      const current = byCommonDir.get(anchor.commonDir);
      const remoteUrl = repositoryUrl(anchor.canonical);
      const candidate: VerifiedProject = {
        hash,
        canonical: anchor.canonical,
        commonDir: anchor.commonDir,
        ...(remoteUrl ? { repositoryUrl: remoteUrl } : {}),
      };
      if (!current || hash === hashProjectPath(anchor.canonical)) {
        byCommonDir.set(anchor.commonDir, candidate);
      }
      break;
    }
  }
  const projects = [...byCommonDir.values()];
  const threadOwners = new Map<string, VerifiedProject[]>();
  for (const project of projects) readThreadOwners(project, threadOwners);
  return {
    map,
    projects,
    threadOwners,
    codexDir: codexDir ?? join(homedir(), ".codex"),
  };
}

function uniqueProject(
  candidates: readonly VerifiedProject[],
  evidence: "live-git" | "mapped-path" | "thread-owner" | "repository-tombstone",
): CodexProjectResolution {
  const unique = [...new Map(candidates.map((project) => [project.commonDir, project])).values()];
  if (unique.length === 1) {
    return {
      status: "resolved",
      canonical: unique[0].canonical,
      projectHash: unique[0].hash,
      evidence,
    };
  }
  return unique.length > 1
    ? { status: "ambiguous", reason: `${evidence} matches multiple local projects` }
    : { status: "unresolved", reason: `${evidence} did not match a verified local project` };
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function tombstoneForCwd(cwd: string, codexDir: string): string | null {
  const root = join(codexDir, "worktrees");
  const normalized = resolve(cwd);
  if (!isWithin(normalized, root)) return null;
  const child = relative(root, normalized).split(/[\\/]/u)[0];
  if (!child) return null;
  const tombstone = join(root, child);
  return isDirectory(tombstone) ? tombstone : null;
}

function mappedPathResolution(
  cwd: string,
  index: CodexProjectIndex,
): CodexProjectResolution | null {
  const normalized = normalizeProjectPath(cwd);
  const matches = Object.entries(index.map)
    .filter(([, entry]) =>
      entryPaths(entry).some((path) => normalizeProjectPath(path) === normalized));
  if (matches.length !== 1) return null;
  const [hash, entry] = matches[0];
  return {
    status: "resolved",
    canonical: resolve(entry.canonical),
    projectHash: hash,
    evidence: "mapped-path",
  };
}

function resolveSession(
  session: CodexSessionFile,
  metadata: CodexSessionMetadata | undefined,
  index: CodexProjectIndex,
): CodexProjectResolution {
  if (metadata?.cwd && isResolvableDirectory(metadata.cwd)) {
    const anchor = resolveGitProjectAnchor(metadata.cwd);
    if (anchor) {
      return uniqueProject(
        index.projects.filter((project) => project.commonDir === anchor.commonDir),
        "live-git",
      );
    }
    const mapped = mappedPathResolution(metadata.cwd, index);
    if (mapped) return mapped;
  }

  const threadId = metadata?.threadId ?? session.sessionId;
  const owned = index.threadOwners.get(threadId) ?? [];
  if (owned.length > 0) return uniqueProject(owned, "thread-owner");

  if (
    metadata?.cwd
    && metadata.repositoryUrl
    && tombstoneForCwd(metadata.cwd, index.codexDir)
  ) {
    return uniqueProject(
      index.projects.filter(
        (project) => project.repositoryUrl === metadata.repositoryUrl,
      ),
      "repository-tombstone",
    );
  }
  return {
    status: "unresolved",
    reason: metadata?.cwd
      ? "session cwd has no live Git, thread-owner, or verified tombstone repository evidence"
      : "session_meta has no cwd and no exact thread owner",
  };
}

export function resolveCodexSessions(codexDir?: string): CodexResolvedSession[] {
  const index = buildProjectIndex(codexDir);
  return findAllCodexTranscripts(codexDir).map((session) => {
    const metadata = extractCodexSessionMeta(session.path);
    return {
      ...session,
      ...(metadata ? { metadata } : {}),
      resolution: resolveSession(session, metadata, index),
    };
  });
}

export function historicalWorktreeEntriesForProject(
  canonical: string,
  commonDir: string,
  codexDir?: string,
): { hashes: string[]; aliases: string[] } {
  const index = buildProjectIndex(codexDir);
  const project = index.projects.find(
    (candidate) => candidate.canonical === canonical && candidate.commonDir === commonDir,
  );
  if (!project?.repositoryUrl) return { hashes: [], aliases: [] };
  const sessions = findAllCodexTranscripts(codexDir);
  const historicalPaths = new Set<string>();
  for (const session of sessions) {
    const metadata = extractCodexSessionMeta(session.path);
    if (
      metadata?.cwd
      && metadata.repositoryUrl === project.repositoryUrl
      && tombstoneForCwd(metadata.cwd, index.codexDir)
      && index.projects.filter(
        (candidate) => candidate.repositoryUrl === metadata.repositoryUrl,
      ).length === 1
    ) {
      historicalPaths.add(resolve(metadata.cwd));
    }
  }
  const hashes = new Set<string>();
  const targetHash = hashProjectPath(canonical);
  for (const [hash, entry] of Object.entries(index.map)) {
    if (hash === targetHash) continue;
    if (entryPaths(entry).some((path) => historicalPaths.has(path))) {
      hashes.add(hash);
    }
  }
  return { hashes: [...hashes], aliases: [...historicalPaths] };
}
