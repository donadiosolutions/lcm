import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Names that may be projected into a managed one-launch credential directory. */
export const MANAGED_CREDENTIAL_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LCM_SUMMARY_API_KEY",
  "LCM_POSTGRES_URL",
] as const);

type ManagedCredentialName = typeof MANAGED_CREDENTIAL_NAMES[number];

const MANAGED_CREDENTIAL_NAME_SET = new Set<string>(MANAGED_CREDENTIAL_NAMES);
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function isWithin(candidate: string, parent: string): boolean {
  const child = resolve(candidate);
  const root = resolve(parent);
  const distance = relative(root, child);
  return distance === "" || (
    !distance.startsWith("..")
    && !isAbsolute(distance)
    && !distance.split(sep).includes("..")
  );
}

function safeCanonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`${label} is not a private directory`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (canonical !== resolve(path) || stats.uid !== currentUid()) {
    throw new Error(`${label} is not owned by the current user`);
  }
  return canonical;
}

function validateName(name: string): asserts name is ManagedCredentialName {
  if (!MANAGED_CREDENTIAL_NAME_SET.has(name)) {
    throw new Error("unsupported managed credential name");
  }
}

/**
 * Create a private, canonical directory for one launch's credentials.
 *
 * The directory is deliberately created with a nonce supplied by the caller;
 * it is never reused for another manager launch.
 */
export function createManagedCredentialDirectory(
  stateRoot: string,
  nonce: string,
  uid = currentUid(),
): string {
  const canonicalRoot = safeCanonicalDirectory(stateRoot, "managed credential state root");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(nonce)) {
    throw new Error("managed credential nonce is invalid");
  }
  const base = resolve(canonicalRoot, "credentials");
  try {
    mkdirSync(base, { mode: DIRECTORY_MODE });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw new Error("managed credential directory cannot be created");
  }
  // The base directory may have pre-existed; validate it before using it.
  const canonicalBase = safeCanonicalDirectory(base, "managed credential base directory");
  if (!isWithin(canonicalBase, canonicalRoot)) throw new Error("managed credential path escapes state root");
  if (uid !== -1 && typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error("managed credential uid is invalid");
  }
  const directory = resolve(canonicalBase, nonce);
  try {
    mkdirSync(directory, { mode: DIRECTORY_MODE });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw new Error("managed credential directory cannot be created");
  }
  const canonicalDirectory = safeCanonicalDirectory(directory, "managed credential directory");
  if (!isWithin(canonicalDirectory, canonicalRoot) || canonicalDirectory !== directory) {
    throw new Error("managed credential directory escapes state root");
  }
  return canonicalDirectory;
}

/** Write the allow-listed credential values without following a pre-existing leaf. */
export function writeManagedCredentialFiles(
  directory: string,
  values: Readonly<Record<string, string>>,
): readonly string[] {
  const canonicalDirectory = validateManagedCredentialDirectory(directory);
  const paths: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    validateName(name);
    if (typeof value !== "string") throw new Error("managed credential value is invalid");
    const path = resolve(canonicalDirectory, name);
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      );
      fchmodSync(fd, FILE_MODE);
      const bytes = Buffer.from(value, "utf8");
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      const stats = fstatSync(fd);
      if (!stats.isFile() || stats.uid !== currentUid() || (stats.mode & 0o777) !== FILE_MODE) {
        throw new Error("managed credential file failed validation");
      }
      paths.push(path);
    } catch (error) {
      // Never surface a filesystem error containing a secret or an arbitrary path.
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        // Cleanup is best effort; the caller's explicit cleanup remains idempotent.
      }
      throw error instanceof Error && error.message === "managed credential file failed validation"
        ? error
        : new Error("managed credential file cannot be created");
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The descriptor may already have been closed on an exceptional path.
        }
      }
    }
  }
  return Object.freeze(paths);
}

/**
 * Validate a credential directory and every leaf that it contains.
 *
 * `stateRoot` is optional because callers that already hold a canonical parent
 * only need the local directory checks. The supervisor always supplies it when
 * validating a launch-owned directory.
 */
export function validateManagedCredentialDirectory(
  directory: string,
  stateRoot?: string,
  uid = currentUid(),
): string {
  const canonicalDirectory = safeCanonicalDirectory(directory, "managed credential directory");
  if (stateRoot !== undefined) {
    const canonicalRoot = safeCanonicalDirectory(stateRoot, "managed credential state root");
    if (!isWithin(canonicalDirectory, canonicalRoot) || canonicalDirectory === canonicalRoot) {
      throw new Error("managed credential directory escapes state root");
    }
  }
  for (const name of readdirSync(canonicalDirectory)) {
    validateName(name);
    const path = resolve(canonicalDirectory, name);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch {
      throw new Error("managed credential file is unavailable");
    }
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.nlink !== 1
      || (stats.mode & 0o777) !== FILE_MODE
      || (uid !== -1 && stats.uid !== uid)
    ) {
      throw new Error("managed credential file failed validation");
    }
    let canonicalLeaf: string;
    try {
      canonicalLeaf = realpathSync(path);
    } catch {
      throw new Error("managed credential file is unavailable");
    }
    if (canonicalLeaf !== path || !isWithin(canonicalLeaf, canonicalDirectory)) {
      throw new Error("managed credential file escapes directory");
    }
  }
  return canonicalDirectory;
}

/** Remove one launch's credential directory; missing paths are already clean. */
export function cleanupManagedCredentialDirectory(
  directory: string,
  stateRoot?: string,
  uid = currentUid(),
): void {
  let canonicalDirectory: string;
  try {
    canonicalDirectory = validateManagedCredentialDirectory(directory, stateRoot, uid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A removed launch directory is the successful idempotent outcome.
    if (code === "ENOENT") return;
    try {
      lstatSync(directory);
    } catch (missingError) {
      if ((missingError as NodeJS.ErrnoException).code === "ENOENT") return;
    }
    throw error;
  }
  for (const name of readdirSync(canonicalDirectory)) {
    validateName(name);
    const path = resolve(canonicalDirectory, name);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("managed credential cleanup failed");
      }
    }
  }
  try {
    rmdirSync(canonicalDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("managed credential cleanup failed");
    }
  }
}

export function managedCredentialPath(
  directory: string,
  name: string,
): string {
  validateName(name);
  const canonicalDirectory = validateManagedCredentialDirectory(directory);
  const path = resolve(canonicalDirectory, name);
  if (!isWithin(path, canonicalDirectory)) throw new Error("managed credential path escapes directory");
  return path;
}
