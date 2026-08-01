import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from "node:path";
import { readBoundedRegularFile } from "./security-files.js";

const MAX_GIT_POINTER_BYTES = 64 * 1024;
const MAX_GIT_CONFIG_BYTES = 4 * 1024 * 1024;
const resolutionCache = new Map<string, GitProjectAnchor>();

type DirectoryIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly path: string;
};

type GitConfigValues = {
  readonly coreWorktree?: string;
  readonly hasCoreWorktree: boolean;
  readonly valid: boolean;
  readonly worktreeConfig: boolean;
};

type ExternalWorktreeEvidence = {
  readonly commonConfig: string;
  readonly resolvedWorktree: string;
  readonly worktreeConfig?: string;
};

export type GitProjectAnchor = {
  /** Stable local repository anchor shared by every linked worktree. */
  canonical: string;
  /** The checkout containing the requested working directory. */
  worktreeRoot: string;
  /** Git's shared repository directory (`git rev-parse --git-common-dir`). */
  commonDir: string;
};

function existingRealDirectory(path: string, label: string): string {
  const real = realpathSync(path);
  if (!statSync(real).isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
  return real;
}

function isContainedPath(root: string, candidate: string): boolean {
  const prefix = `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

function authenticateDirectory(path: string, label: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`invalid ${label} at ${path}`);
  }
  const real = realpathSync(path);
  const current = statSync(real);
  if (real !== path || current.dev !== stat.dev || current.ino !== stat.ino) {
    throw new Error(`${label} changed during validation: ${path}`);
  }
  return { dev: stat.dev, ino: stat.ino, path };
}

function revalidateDirectory(identity: DirectoryIdentity, label: string): void {
  const current = authenticateDirectory(identity.path, label);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`${label} changed during validation: ${identity.path}`);
  }
}

function readGitMetadata(
  path: string,
  allowedRoot: string,
  label: string,
  maxBytes: number,
): string {
  try {
    return readBoundedRegularFile(path, {
      allowedRoot,
      maxBytes,
    });
  } catch (error) {
    throw new Error(`invalid ${label} metadata at ${path}: ${String(error)}`);
  }
}

function readGitPointer(path: string, allowedRoot: string, label: string): string {
  return readGitMetadata(path, allowedRoot, label, MAX_GIT_POINTER_BYTES);
}

function readGitConfig(path: string, allowedRoot: string, label: string): string {
  return readGitMetadata(path, allowedRoot, label, MAX_GIT_CONFIG_BYTES);
}

function parseGitDir(
  pointerPath: string,
  worktreeRoot: string,
): { readonly gitDir: string; readonly isRelative: boolean } {
  const content = readGitPointer(pointerPath, worktreeRoot, "Git worktree");
  const trimmed = content.trim();
  const match = /^gitdir:\s*(.+)$/iu.exec(trimmed);
  if (!match) {
    throw new Error(`invalid Git worktree metadata at ${pointerPath}: expected one gitdir line`);
  }
  const target = match[1]!;
  const targetPath = resolve(worktreeRoot, target);
  const targetStat = lstatSync(targetPath);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`invalid Git directory at ${targetPath}`);
  }
  const gitDir = existingRealDirectory(targetPath, "Git directory");
  if (gitDir !== targetPath) {
    throw new Error(`invalid Git directory path alias at ${targetPath}`);
  }
  return {
    gitDir,
    isRelative: !isAbsolute(target),
  };
}

function resolveCommonDir(gitDir: string): string {
  const commonPointer = join(gitDir, "commondir");
  if (!existsSync(commonPointer)) return gitDir;
  const stat = lstatSync(commonPointer);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`invalid Git common-directory metadata at ${commonPointer}`);
  }
  const relative = readGitPointer(commonPointer, gitDir, "Git common-directory").trim();
  if (!relative || relative.includes("\0") || relative.includes("\n") || relative.includes("\r")) {
    throw new Error(`invalid Git common-directory metadata at ${commonPointer}: expected one path`);
  }
  const target = resolve(gitDir, relative);
  const targetStat = lstatSync(target);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`invalid Git common directory at ${target}`);
  }
  const commonDir = existingRealDirectory(target, "Git common directory");
  if (commonDir !== target) {
    throw new Error(`invalid Git common directory path alias at ${target}`);
  }
  return commonDir;
}

function parseOnePath(content: string, path: string, label: string): string {
  const value = content.trim();
  if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`invalid ${label} metadata at ${path}: expected one path`);
  }
  return value;
}

function validateWorktreeBackpointer(
  marker: string,
  worktreeRoot: string,
  gitDir: string,
): void {
  const backpointerPath = join(gitDir, "gitdir");
  const backpointer = parseOnePath(
    readGitPointer(backpointerPath, gitDir, "Git worktree backpointer"),
    backpointerPath,
    "Git worktree backpointer",
  );
  const backpointerTarget = resolve(gitDir, backpointer);
  let resolvedBackpointer: string;
  let resolvedMarker: string;
  try {
    const targetStat = lstatSync(backpointerTarget);
    const markerStat = lstatSync(marker);
    if (
      !targetStat.isFile()
      || !markerStat.isFile()
    ) {
      throw new Error("backpointer target or worktree marker is not a regular file");
    }
    resolvedBackpointer = realpathSync(backpointerTarget);
    resolvedMarker = realpathSync(marker);
  } catch (error) {
    throw new Error(
      `invalid Git worktree backpointer metadata at ${backpointerPath}: ${String(error)}`,
    );
  }
  if (
    resolvedBackpointer !== resolvedMarker
    || resolvedMarker !== join(worktreeRoot, ".git")
  ) {
    throw new Error(
      `invalid Git worktree backpointer metadata at ${backpointerPath}: topology does not point to ${marker}`,
    );
  }
}

function validateLinkedWorktreeTopology(
  marker: string,
  worktreeRoot: string,
  gitDir: string,
  commonDir: string,
): void {
  const worktreesPath = join(commonDir, "worktrees");
  const worktreesStat = (() => {
    try {
      return lstatSync(worktreesPath);
    } catch (error) {
      throw new Error(
        `invalid Git worktrees directory at ${worktreesPath}: ${String(error)}`,
      );
    }
  })();
  if (!worktreesStat.isDirectory() || worktreesStat.isSymbolicLink()) {
    throw new Error(`invalid Git worktrees directory at ${worktreesPath}`);
  }
  const worktreesDir = existingRealDirectory(
    worktreesPath,
    "Git worktrees directory",
  );
  if (worktreesDir !== worktreesPath) {
    throw new Error(`invalid Git worktrees directory at ${worktreesPath}`);
  }
  if (
    dirname(gitDir) !== worktreesDir
    || resolve(worktreesDir, basename(gitDir)) !== gitDir
  ) {
    throw new Error(
      `invalid Git linked-worktree topology: ${gitDir} is not a direct worktree entry under ${commonDir}`,
    );
  }

  validateWorktreeBackpointer(
    marker,
    worktreeRoot,
    gitDir,
  );

  // Re-read all three pointers after the topology check. Each individual read
  // is descriptor-bound; comparing the resolved relationship a second time
  // also fails closed when repository-controlled metadata is retargeted
  // between validation steps.
  if (parseGitDir(marker, worktreeRoot).gitDir !== gitDir) {
    throw new Error("Git worktree metadata changed during topology validation");
  }
  if (resolveCommonDir(gitDir) !== commonDir) {
    throw new Error("Git common-directory metadata changed during topology validation");
  }
  try {
    validateWorktreeBackpointer(
      marker,
      worktreeRoot,
      gitDir,
    );
  } catch (error) {
    throw new Error(
      `Git worktree backpointer changed during topology validation: ${String(error)}`,
    );
  }
}

function canonicalForCommonDir(commonDir: string): string {
  // Normal non-bare repositories keep the shared directory at <checkout>/.git.
  // Bare repositories and unusual layouts use the common directory itself as
  // the stable local anchor; this still distinguishes separate clones.
  return basename(commonDir) === ".git"
    ? existingRealDirectory(dirname(commonDir), "Git primary checkout")
    : commonDir;
}

function isConfigWhitespace(char: string): boolean {
  return char === " " || char === "\t";
}

function asciiLower(value: string): string {
  let lowered = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    lowered += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char;
  }
  return lowered;
}

function isConfigNameChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || char === "-";
}

function isAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function scanPhysicalConfigLine(
  line: string,
  initialQuoted: boolean,
): { readonly continues: boolean; readonly quoted: boolean } {
  let quoted = initialQuoted;
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "#" || char === ";")) {
      return { continues: false, quoted };
    }
  }
  return { continues: escaped, quoted };
}

function logicalConfigLines(config: string): { readonly lines: string[]; readonly valid: boolean } {
  const lines: string[] = [];
  const continued: string[] = [];
  let continuedQuote = false;
  let valid = true;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const scanned = scanPhysicalConfigLine(line, continuedQuote);
    if (scanned.continues) {
      continued.push(line.slice(0, -1));
      continuedQuote = scanned.quoted;
      continue;
    }
    continued.push(line);
    const logicalLine = continued.join("");
    if (continued.length > 1) {
      let cursor = 0;
      while (
        cursor < logicalLine.length
        && isConfigWhitespace(logicalLine[cursor]!)
      ) {
        cursor += 1;
      }
      if (logicalLine[cursor] === "[") valid = false;
    }
    lines.push(logicalLine);
    continued.length = 0;
    continuedQuote = false;
  }
  return { lines, valid: valid && continued.length === 0 };
}

function parseSectionName(line: string, start: number): {
  readonly baseName?: string;
  readonly name?: string;
  readonly valid: boolean;
} {
  let quoted = false;
  let escaped = false;
  let close = -1;
  for (let index = start + 1; index < line.length; index += 1) {
    const char = line[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "]" && !quoted) {
      close = index;
      break;
    }
  }
  if (close < 0 || quoted || escaped) return { valid: false };
  let tail = close + 1;
  while (tail < line.length && isConfigWhitespace(line[tail]!)) tail += 1;
  if (tail < line.length && line[tail] !== "#" && line[tail] !== ";") {
    return { valid: false };
  }

  const header = line.slice(start + 1, close);
  let nameEnd = 0;
  while (nameEnd < header.length && isConfigNameChar(header[nameEnd]!)) nameEnd += 1;
  if (nameEnd === 0) return { valid: false };
  const name = asciiLower(header.slice(0, nameEnd));
  let remainder = nameEnd;
  while (remainder < header.length && isConfigWhitespace(header[remainder]!)) remainder += 1;
  if (remainder === header.length) return { baseName: name, name, valid: true };
  if (header[remainder] === ".") {
    remainder += 1;
    const subsectionStart = remainder;
    while (
      remainder < header.length
      && (isConfigNameChar(header[remainder]!) || header[remainder] === ".")
    ) {
      remainder += 1;
    }
    return {
      baseName: name,
      name: undefined,
      valid: remainder > subsectionStart && remainder === header.length,
    };
  }
  if (header[remainder] !== '"') return { valid: false };
  quoted = true;
  escaped = false;
  remainder += 1;
  for (; remainder < header.length; remainder += 1) {
    const char = header[remainder]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = false;
      remainder += 1;
      break;
    }
  }
  while (remainder < header.length && isConfigWhitespace(header[remainder]!)) remainder += 1;
  return {
    baseName: name,
    name: undefined,
    valid: !quoted && !escaped && remainder === header.length,
  };
}

function parseConfigValue(raw: string): { readonly valid: boolean; readonly value?: string } {
  const value: string[] = [];
  let escaped = false;
  let quoted = false;
  let started = false;
  let trailingWhitespace = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (escaped) {
      const decoded = char === "n" ? "\n"
        : char === "t" ? "\t"
          : char === "b" ? "\b"
            : char === "\\" || char === '"' ? char
              : undefined;
      if (decoded === undefined) return { valid: false };
      value.push(decoded);
      started = true;
      trailingWhitespace = 0;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      started = true;
      trailingWhitespace = 0;
      continue;
    }
    if (!quoted && (char === "#" || char === ";")) break;
    if (!quoted && isConfigWhitespace(char)) {
      if (!started) continue;
      value.push(char);
      trailingWhitespace += 1;
      continue;
    }
    value.push(char);
    started = true;
    trailingWhitespace = 0;
  }
  if (escaped || quoted) return { valid: false };
  if (trailingWhitespace > 0) value.splice(value.length - trailingWhitespace);
  return { valid: true, value: value.join("") };
}

function parseGitConfig(config: string): GitConfigValues {
  const logical = logicalConfigLines(
    config.startsWith("\uFEFF") ? config.slice(1) : config,
  );
  let section: string | undefined;
  let sectionBase: string | undefined;
  let coreWorktree: string | undefined;
  let hasCoreWorktree = false;
  let valid = logical.valid;
  let worktreeConfig = false;
  let worktreeConfigInvalid = false;

  for (const line of logical.lines) {
    let cursor = 0;
    while (cursor < line.length && isConfigWhitespace(line[cursor]!)) cursor += 1;
    if (cursor === line.length || line[cursor] === "#" || line[cursor] === ";") continue;
    if (line[cursor] === "[") {
      const parsedSection = parseSectionName(line, cursor);
      if (!parsedSection.valid) valid = false;
      section = parsedSection.valid ? parsedSection.name : undefined;
      sectionBase = parsedSection.valid ? parsedSection.baseName : undefined;
      continue;
    }

    if (!isAsciiLetter(line[cursor]!)) {
      valid = false;
      continue;
    }
    const keyStart = cursor;
    while (cursor < line.length && isConfigNameChar(line[cursor]!)) cursor += 1;
    const key = asciiLower(line.slice(keyStart, cursor));
    const relevant = (section === "core" && key === "worktree")
      || (section === "extensions" && key === "worktreeconfig");
    if (
      key === "path"
      && (sectionBase === "include" || sectionBase === "includeif")
    ) {
      valid = false;
      continue;
    }
    while (cursor < line.length && isConfigWhitespace(line[cursor]!)) cursor += 1;
    const implicit = cursor === line.length;
    let parsedValue: { readonly valid: boolean; readonly value?: string } | undefined;
    if (!implicit && line[cursor] === "=") {
      parsedValue = parseConfigValue(line.slice(cursor + 1));
    } else if (!implicit) {
      valid = false;
      if (section === "extensions") worktreeConfigInvalid = true;
      continue;
    }
    if (parsedValue?.valid === false) {
      valid = false;
      if (section === "core" && key === "worktree") hasCoreWorktree = true;
      if (section === "extensions" && key === "worktreeconfig") {
        worktreeConfigInvalid = true;
      }
      continue;
    }
    if (!relevant) continue;

    if (section === "core") {
      hasCoreWorktree = true;
      if (implicit) {
        valid = false;
      } else {
        coreWorktree = parsedValue!.value;
      }
      continue;
    }

    if (implicit) {
      worktreeConfig = true;
      continue;
    }
    const bool = asciiLower(parsedValue!.value!);
    if (bool === "true" || bool === "yes" || bool === "on" || bool === "1") {
      worktreeConfig = true;
    } else if (bool === "false" || bool === "no" || bool === "off" || bool === "0") {
      worktreeConfig = false;
    } else {
      worktreeConfigInvalid = true;
      valid = false;
    }
  }

  return {
    coreWorktree,
    hasCoreWorktree,
    valid,
    worktreeConfig: !worktreeConfigInvalid && worktreeConfig,
  };
}

function readConfigValues(gitDir: string): {
  readonly commonConfig: string;
  readonly commonValues: GitConfigValues;
  readonly worktreeConfig?: string;
  readonly worktreeValues?: GitConfigValues;
} {
  const commonConfig = readGitConfig(join(gitDir, "config"), gitDir, "Git config");
  const commonValues = parseGitConfig(commonConfig);
  const worktreeConfigPath = join(gitDir, "config.worktree");
  if (!commonValues.worktreeConfig || !existsSync(worktreeConfigPath)) {
    return { commonConfig, commonValues };
  }
  const worktreeConfig = readGitConfig(
    worktreeConfigPath,
    gitDir,
    "Git worktree config",
  );
  return {
    commonConfig,
    commonValues,
    worktreeConfig,
    worktreeValues: parseGitConfig(worktreeConfig),
  };
}

function readExternalWorktreeEvidence(
  gitDir: string,
  worktreeRoot: string,
): ExternalWorktreeEvidence {
  const values = readConfigValues(gitDir);
  if (!values.commonValues.valid || values.worktreeValues?.valid === false) {
    throw new Error(`invalid Git config metadata at ${join(gitDir, "config")}: ambiguous worktree configuration`);
  }
  const configured = values.worktreeValues?.hasCoreWorktree === true
    ? values.worktreeValues.coreWorktree
    : values.commonValues.coreWorktree;
  if (
    configured === undefined
    || configured.length === 0
    || configured.includes("\0")
    || configured.includes("\n")
    || configured.includes("\r")
  ) {
    throw new Error(`invalid Git config metadata at ${join(gitDir, "config")}: expected one core.worktree path`);
  }
  const configuredPath = resolve(gitDir, configured);
  const configuredStat = lstatSync(configuredPath);
  if (!configuredStat.isDirectory() || configuredStat.isSymbolicLink()) {
    throw new Error(`invalid Git core.worktree directory at ${configuredPath}`);
  }
  const resolvedWorktree = existingRealDirectory(configuredPath, "Git core.worktree directory");
  if (configuredPath !== worktreeRoot || resolvedWorktree !== worktreeRoot) {
    throw new Error(`invalid Git core.worktree metadata at ${join(gitDir, "config")}: topology does not point to ${worktreeRoot}`);
  }
  return {
    commonConfig: values.commonConfig,
    resolvedWorktree,
    worktreeConfig: values.worktreeConfig,
  };
}

function validateGitDirectory(gitDir: string, commonDir: string): void {
  for (const [path, label, read] of [
    [join(gitDir, "HEAD"), "Git HEAD", readGitPointer],
    [join(commonDir, "config"), "Git config", readGitConfig],
  ] as const) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`invalid ${label} metadata at ${path}`);
    }
    read(path, dirname(path), label);
  }
  const objects = lstatSync(join(commonDir, "objects"));
  if (!objects.isDirectory() || objects.isSymbolicLink()) {
    throw new Error(`invalid Git objects directory at ${join(commonDir, "objects")}`);
  }
}

function inspectGitMarker(worktreeRoot: string): GitProjectAnchor | null {
  const marker = join(worktreeRoot, ".git");
  if (!existsSync(marker)) return null;
  const stat = lstatSync(marker);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symlink Git metadata: ${marker}`);
  }

  let gitDir: string;
  let relativeGitPointer = false;
  if (stat.isDirectory()) {
    gitDir = existingRealDirectory(marker, "Git directory");
  } else if (stat.isFile()) {
    const parsedPointer = parseGitDir(marker, worktreeRoot);
    gitDir = parsedPointer.gitDir;
    relativeGitPointer = parsedPointer.isRelative;
  } else {
    throw new Error(`invalid Git metadata type at ${marker}`);
  }

  const gitDirIdentity = authenticateDirectory(gitDir, "Git directory");
  const commonDir = resolveCommonDir(gitDir);
  const commonDirIdentity = commonDir === gitDir
    ? gitDirIdentity
    : authenticateDirectory(commonDir, "Git common directory");
  if (stat.isDirectory() && !isContainedPath(gitDir, commonDir)) {
    throw new Error(
      `invalid Git common-directory metadata: ${commonDir} escapes ${gitDir}`,
    );
  }
  if (stat.isFile() && commonDir !== gitDir) {
    validateLinkedWorktreeTopology(marker, worktreeRoot, gitDir, commonDir);
  }
  const externalEvidence = stat.isFile() && commonDir === gitDir
    ? readExternalWorktreeEvidence(gitDir, worktreeRoot)
    : undefined;
  validateGitDirectory(gitDir, commonDir);

  revalidateDirectory(gitDirIdentity, "Git directory");
  if (commonDir !== gitDir) {
    revalidateDirectory(commonDirIdentity, "Git common directory");
  }
  if (resolveCommonDir(gitDir) !== commonDir) {
    throw new Error("Git common-directory metadata changed during validation");
  }
  if (stat.isFile()) {
    const revalidatedPointer = parseGitDir(marker, worktreeRoot);
    if (
      revalidatedPointer.gitDir !== gitDir
      || revalidatedPointer.isRelative !== relativeGitPointer
    ) {
      throw new Error("Git worktree metadata changed during validation");
    }
  }
  if (externalEvidence !== undefined) {
    const revalidatedEvidence = readExternalWorktreeEvidence(gitDir, worktreeRoot);
    if (
      revalidatedEvidence.commonConfig !== externalEvidence.commonConfig
      || revalidatedEvidence.worktreeConfig !== externalEvidence.worktreeConfig
      || revalidatedEvidence.resolvedWorktree !== externalEvidence.resolvedWorktree
    ) {
      throw new Error("Git core.worktree metadata changed during validation");
    }
  }
  return {
    // A normal submodule has a `.git` pointer into the superproject's
    // `.git/modules/...` directory, no `commondir`, and an explicit core
    // worktree. A primary checkout created with `--separate-git-dir` also has
    // no `commondir`, but Git writes its pointer as an absolute path. Keep that
    // external directory as the anchor so linked worktrees resolve identically.
    canonical: stat.isFile() && relativeGitPointer && commonDir === gitDir
      ? worktreeRoot
      : canonicalForCommonDir(commonDir),
    worktreeRoot,
    commonDir,
  };
}

function anchorsEqual(left: GitProjectAnchor, right: GitProjectAnchor): boolean {
  return left.canonical === right.canonical
    && left.worktreeRoot === right.worktreeRoot
    && left.commonDir === right.commonDir;
}

function scanForGitProjectAnchor(start: string): GitProjectAnchor | null {
  let current = start;
  for (;;) {
    const anchor = inspectGitMarker(current);
    if (anchor) return anchor;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return null;
    current = parent;
  }
}

function revalidateCachedAnchor(
  start: string,
  cached: GitProjectAnchor,
): GitProjectAnchor | undefined {
  let current = start;
  for (;;) {
    const anchor = inspectGitMarker(current);
    if (anchor) return anchorsEqual(anchor, cached) ? cached : anchor;
    if (current === cached.worktreeRoot) return undefined;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return undefined;
    current = parent;
  }
}

/**
 * Resolve a working directory to its shared local Git repository identity.
 *
 * The nearest ancestor containing `.git` wins, so nested repositories remain
 * separate projects. Repository remotes are deliberately not inspected.
 */
export function resolveGitProjectAnchor(cwd: string): GitProjectAnchor | null {
  const requested = resolve(cwd);
  let real: string;
  try {
    real = existingRealDirectory(requested, "working directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const cached = resolutionCache.get(real);
  if (cached !== undefined) {
    const revalidated = revalidateCachedAnchor(real, cached);
    if (revalidated !== undefined) {
      resolutionCache.set(real, revalidated);
      return revalidated;
    }
  }

  const anchor = scanForGitProjectAnchor(real);
  if (anchor) resolutionCache.set(real, anchor);
  else resolutionCache.delete(real);
  return anchor;
}

export function clearGitProjectAnchorCache(): void {
  resolutionCache.clear();
}
