import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { localProjectIdentity } from "../daemon/project.js";
import {
  UnauthenticatedProjectIdentityError,
  hashProjectPath,
  isAuthenticatedRetiredProjectIdentitySuccessor,
  isRetiredProjectIdentitySuccessor,
  normalizeProjectIdentityPath,
  normalizeProjectPath,
  resolveExistingProjectIdentity,
} from "../project-map.js";
import { lcmHomeDir } from "../runtime-paths.js";
import {
  assertPrivateDirectory,
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  openPrivateDirectory,
  OWNER_ONLY_FILE_MODES,
  readBoundedRegularFile,
} from "../security-files.js";
import type { BackendPublicationLockToken } from "../storage/backend-publication.js";

const IDENTITY_EVIDENCE_VERSION = 1;
const MAX_IDENTITY_EVIDENCE_BYTES = 4 * 1024;
const PROJECT_ID_PATTERN = /^[a-f0-9]{64}$/u;

type SidecarIdentityEvidence = Readonly<{
  version: typeof IDENTITY_EVIDENCE_VERSION;
  cwd: string;
  canonical: string;
  id: string;
}>;

type ExistingEventsDbPathOptions = Readonly<{
  publicationLockToken?: BackendPublicationLockToken;
  /** @internal Test-only effective-user seam for deterministic ownership coverage. */
  _effectiveUidForTesting?: () => number | undefined;
  /** @internal Test-only directory-open seam for isolating evidence ownership. */
  _openEventsDirectoryForTesting?: typeof openPrivateDirectory;
}>;

function effectiveUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Authenticate an identity-evidence id against its own canonical path. A
 * plain path-hash id always matches, exactly as before. A renewed successor
 * id (see `retiredProjectIdentitySuccessor`) is authenticated only when the
 * retained predecessor fence for that same retirement is genuinely present,
 * mirroring the identical `isAuthenticatedRetiredProjectIdentityFence` proof
 * that `parseLocalProjectMapCompatibility` already requires before it will
 * ever hand a hook that successor id. Any other id is rejected.
 */
function isAuthenticatedIdentityEvidenceId(canonical: string, id: string): boolean {
  const plainId = hashProjectPath(canonical);
  if (id === plainId) return true;
  return isAuthenticatedRetiredProjectIdentitySuccessor(id, plainId, canonical);
}

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

function existingSidecarFromIdentityEvidence(
  cwd: string,
  expectedUid: number | undefined,
): string | undefined {
  const normalizedCwd = normalizeProjectPath(cwd);
  const path = identityEvidencePath(normalizedCwd);

  let content: string;
  try {
    content = readBoundedRegularFile(path, {
      allowedRoot: eventsDir(),
      allowedModes: OWNER_ONLY_FILE_MODES,
      expectedUid,
      maxBytes: MAX_IDENTITY_EVIDENCE_BYTES,
      requireSingleLink: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(content);
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
      || !isAuthenticatedIdentityEvidenceId(record.canonical, record.id)
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
 * Resolve only an identity this probe is allowed to act on.
 *
 * The probe must stay usable while recovering an unavailable working
 * directory, so a map key that no local evidence binds to the path is treated
 * as no identity rather than as an error. The caller then falls back to the
 * sidecar the canonical path derives, instead of opening whichever sidecar an
 * unauthenticated key names.
 */
function authenticatedExistingProjectIdentity(
  cwd: string,
  publicationLockToken?: BackendPublicationLockToken,
): ReturnType<typeof resolveExistingProjectIdentity> {
  try {
    return resolveExistingProjectIdentity(cwd, publicationLockToken);
  } catch (error) {
    if (error instanceof UnauthenticatedProjectIdentityError) return null;
    throw error;
  }
}

/**
 * Derive a sidecar path only from identity or sidecar state that already
 * exists. This must remain read-only because callers use it while recovering
 * unavailable working directories.
 */
export function existingEventsDbPath(
  cwd: string,
  options: ExistingEventsDbPathOptions = {},
): string | undefined {
  const identity = authenticatedExistingProjectIdentity(cwd, options.publicationLockToken);
  const directory = eventsDir();
  const expectedUid = options._effectiveUidForTesting?.() ?? effectiveUid();
  let handle: ReturnType<typeof openPrivateDirectory>;
  try {
    handle = (options._openEventsDirectoryForTesting ?? openPrivateDirectory)(
      directory,
      { expectedUid },
    );
  } catch {
    return undefined;
  }

  const witness = handle.witness;
  let failed = false;
  let result: string | undefined;
  try {
    try {
      assertPrivateDirectory(handle, directory, witness);
      if (identity) {
        const retiredId = hashProjectPath(identity.canonical);
        const successorUnauthenticated = isRetiredProjectIdentitySuccessor(
          identity.id,
          retiredId,
          identity.canonical,
        ) && !isAuthenticatedRetiredProjectIdentitySuccessor(
          identity.id,
          retiredId,
          identity.canonical,
        );
        result = successorUnauthenticated
          ? undefined
          : join(directory, `${identity.id}.db`);
      } else {
        const evidenced = existingSidecarFromIdentityEvidence(cwd, expectedUid);
        if (evidenced) {
          result = evidenced;
        } else {
          // Legacy mapless sidecars use the exact normalized cwd hash. Return
          // one only when it is already present; no identity is created.
          const candidate = join(directory, `${hashProjectPath(normalizeProjectPath(cwd))}.db`);
          result = existsSync(candidate) ? candidate : undefined;
        }
      }
    } catch {
      failed = true;
    }

    try {
      assertPrivateDirectory(handle, directory, witness);
    } catch {
      failed = true;
    }
    return failed ? undefined : result;
  } finally {
    handle.close();
  }
}
