import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { localProjectIdentity } from "../daemon/project.js";
import {
  hashProjectPath,
  normalizeProjectIdentityPath,
  normalizeProjectPath,
  resolveExistingProjectIdentity,
} from "../project-map.js";
import { lcmHomeDir } from "../runtime-paths.js";
import {
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  OWNER_ONLY_FILE_MODES,
  readBoundedRegularFile,
} from "../security-files.js";

const IDENTITY_EVIDENCE_VERSION = 1;
const MAX_IDENTITY_EVIDENCE_BYTES = 4 * 1024;
const PROJECT_ID_PATTERN = /^[a-f0-9]{64}$/u;

type SidecarIdentityEvidence = Readonly<{
  version: typeof IDENTITY_EVIDENCE_VERSION;
  cwd: string;
  canonical: string;
  id: string;
}>;

function identityEvidencePath(normalizedCwd: string): string {
  return join(eventsDir(), `${hashProjectPath(normalizedCwd)}.identity.json`);
}

function publishIdentityEvidence(cwd: string, identity: { id: string; canonical: string }): void {
  const normalizedCwd = normalizeProjectPath(cwd);
  if (hashProjectPath(normalizedCwd) === identity.id) return;

  const canonical = normalizeProjectIdentityPath(identity.canonical);
  const evidence: SidecarIdentityEvidence = {
    version: IDENTITY_EVIDENCE_VERSION,
    cwd: normalizedCwd,
    canonical,
    id: identity.id,
  };
  ensurePrivateDirectory(eventsDir());
  atomicWritePrivateFileDurable(
    identityEvidencePath(normalizedCwd),
    `${JSON.stringify(evidence)}\n`,
    { maxExistingBytes: MAX_IDENTITY_EVIDENCE_BYTES },
  );
}

function existingSidecarFromIdentityEvidence(cwd: string): string | undefined {
  const normalizedCwd = normalizeProjectPath(cwd);
  const path = identityEvidencePath(normalizedCwd);
  if (!existsSync(path)) return undefined;

  try {
    const parsed: unknown = JSON.parse(readBoundedRegularFile(path, {
      allowedRoot: eventsDir(),
      allowedModes: OWNER_ONLY_FILE_MODES,
      maxBytes: MAX_IDENTITY_EVIDENCE_BYTES,
      requireSingleLink: true,
    }));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(",") !== "canonical,cwd,id,version") return undefined;
    if (
      record.version !== IDENTITY_EVIDENCE_VERSION
      || record.cwd !== normalizedCwd
      || typeof record.canonical !== "string"
      || resolve(record.canonical) !== record.canonical
      || typeof record.id !== "string"
      || !PROJECT_ID_PATTERN.test(record.id)
      || hashProjectPath(record.canonical) !== record.id
    ) {
      return undefined;
    }
    const candidate = join(eventsDir(), `${record.id}.db`);
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function eventsDir(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "events");
}

export function eventSequenceDbPath(homeDir?: string): string {
  return join(eventsDir(homeDir), ".machine-sequence.sqlite");
}

export function eventsDbPath(cwd: string): string {
  const identity = localProjectIdentity(cwd);
  publishIdentityEvidence(cwd, identity);
  return join(eventsDir(), `${identity.id}.db`);
}

/**
 * Derive a sidecar path only from identity or sidecar state that already
 * exists. This must remain read-only because callers use it while recovering
 * unavailable working directories.
 */
export function existingEventsDbPath(cwd: string): string | undefined {
  const identity = resolveExistingProjectIdentity(cwd);
  if (identity) return join(eventsDir(), `${identity.id}.db`);

  const evidenced = existingSidecarFromIdentityEvidence(cwd);
  if (evidenced) return evidenced;

  // Legacy mapless sidecars use the exact normalized cwd hash. Return it only
  // when the sidecar is already present; no project identity is created by
  // this fallback.
  const candidate = join(eventsDir(), `${hashProjectPath(normalizeProjectPath(cwd))}.db`);
  return existsSync(candidate) ? candidate : undefined;
}
