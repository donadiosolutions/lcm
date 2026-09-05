import { writeFile, mkdir } from "node:fs/promises";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import { NATIVE_PATTERNS, ScrubEngine, readGitleaksSyncDate } from "./scrub.js";
import { GITLEAKS_PATTERNS } from "./generated-patterns.js";
import { projectDir } from "./daemon/project.js";
import { loadStoredConfigProjection } from "./config-projection.js";
import { selectStorageBackend } from "./storage/backend.js";
import { validateRegex } from "./store/regex-safety.js";
import { configPath as runtimeConfigPath, projectsDir as runtimeProjectsDir } from "./runtime-paths.js";
import { atomicWritePrivateFile, OWNER_ONLY_FILE_MODES, readBoundedRegularFile } from "./security-files.js";
import {
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigMutation,
  backendPublicationHomeForConfigPath,
  BackendPublicationJournalError,
  withBackendPublicationConfigLock,
  withBackendPublicationConsumerLockAsync,
} from "./storage/backend-publication.js";
import { PrivateMutationLockContentionError } from "./private-mutation-lock.js";

function defaultConfigPath(): string {
  return runtimeConfigPath();
}

const MAX_SENSITIVE_PATTERN_BYTES = 1024 * 1024;

function loadProjectPatternsBounded(patternsFile: string): string[] {
  let content: string;
  try {
    content = readBoundedRegularFile(patternsFile, {
      allowedRoot: dirname(patternsFile),
      maxBytes: MAX_SENSITIVE_PATTERN_BYTES,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function loadGlobalUserPatterns(configPath: string): string[] {
  try {
    return loadStoredConfigProjection(configPath).security.sensitivePatterns;
  } catch (error) {
    if (error instanceof BackendPublicationJournalError
      || error instanceof PrivateMutationLockContentionError) throw error;
    // Pattern inspection remains available when persisted configuration is invalid.
    return [];
  }
}

export async function handleSensitive(
  argv: string[],
  cwd: string,
  configPath?: string,
): Promise<{ exitCode: number; stdout: string }> {
  const resolvedConfigPath = configPath ?? defaultConfigPath();
  const sub = argv[0];

  switch (sub) {
    case "list": {
      return sensitiveList(cwd, resolvedConfigPath);
    }
    case "add": {
      return sensitiveAdd(argv.slice(1), cwd, resolvedConfigPath);
    }
    case "remove": {
      return sensitiveRemove(argv.slice(1), cwd, resolvedConfigPath);
    }
    case "test": {
      return sensitiveTest(argv.slice(1), cwd, resolvedConfigPath);
    }
    case "purge": {
      return sensitivePurge(argv.slice(1), cwd, resolvedConfigPath);
    }
    default: {
      return {
        exitCode: 1,
        stdout:
          "Usage: lcm sensitive <list|add|remove|test|purge> [options]\n",
      };
    }
  }
}

async function sensitiveList(
  cwd: string,
  configPath: string,
): Promise<{ exitCode: number; stdout: string }> {
  const globalUserPatterns = loadGlobalUserPatterns(configPath);

  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const projectPatterns = await withBackendPublicationConsumerLockAsync(
    backendPublicationHomeForConfigPath(configPath),
    () => loadProjectPatternsBounded(patternsFile),
  );

  const lines: string[] = [];
  const syncDate = readGitleaksSyncDate();
  const syncNote = syncDate ? ` (synced ${syncDate})` : "";

  lines.push("Built-in patterns:");
  lines.push(`  [gitleaks]  ${GITLEAKS_PATTERNS.length} patterns${syncNote}`);
  for (const p of NATIVE_PATTERNS) {
    lines.push(`  [native]    ${p}`);
  }

  lines.push("");
  lines.push("Global patterns (config.json):");
  if (globalUserPatterns.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of globalUserPatterns) {
      lines.push(`  [user]      ${p}`);
    }
  }

  lines.push("");
  lines.push(
    `Project patterns (${patternsFile}):`,
  );
  if (projectPatterns.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of projectPatterns) {
      lines.push(`  [user]      ${p}`);
    }
  }

  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

async function sensitiveAdd(
  args: string[],
  cwd: string,
  configPath: string,
): Promise<{ exitCode: number; stdout: string }> {
  const isGlobal = args.includes("--global");
  const pattern = args.find((a) => !a.startsWith("--"));

  if (!pattern) {
    return {
      exitCode: 1,
      stdout: 'Usage: lcm sensitive add [--global] "<pattern>"\n',
    };
  }

  if (isGlobal) {
    return withBackendPublicationConfigLock(configPath, (lockToken) => {
      let raw: Record<string, unknown> = {};
      let content: string | null = null;
      try {
        content = readBoundedRegularFile(configPath, {
          allowedRoot: dirname(configPath),
          maxBytes: 4 * 1024 * 1024,
          allowedModes: OWNER_ONLY_FILE_MODES,
        });
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          return {
            exitCode: 1,
            stdout: `Error: ${configPath} contains invalid JSON. Fix the file manually before adding patterns.\n`,
          };
        }
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          raw = parsed as Record<string, unknown>;
        } else {
          return {
            exitCode: 1,
            stdout: `Error: ${configPath} is not a JSON object. Fix the file manually before adding patterns.\n`,
          };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const currentSecurity = raw.security;
      const security: Record<string, unknown> = currentSecurity !== null
        && typeof currentSecurity === "object"
        && !Array.isArray(currentSecurity)
        ? currentSecurity as Record<string, unknown>
        : {};
      raw.security = security;
      const patterns = Array.isArray(security.sensitivePatterns)
        ? security.sensitivePatterns.filter((value): value is string => typeof value === "string")
        : [];
      security.sensitivePatterns = patterns;
      const currentBackend = (
        raw.storage !== null
        && typeof raw.storage === "object"
        && !Array.isArray(raw.storage)
        && (raw.storage as Record<string, unknown>).backend === "postgresql"
      ) ? "postgresql" : "sqlite";
      assertBackendPublicationConfigAccess(configPath, currentBackend, content, undefined, lockToken);
      if (patterns.includes(pattern)) {
        return { exitCode: 0, stdout: `Pattern already present (global): ${pattern}\n` };
      }
      patterns.push(pattern);
      const candidateContent = `${JSON.stringify(raw, null, 2)}\n`;
      assertBackendPublicationConfigMutation(
        configPath,
        currentBackend,
        currentBackend,
        candidateContent,
        content,
        undefined,
        lockToken,
      );
      mkdirSync(dirname(configPath), { recursive: true });
      atomicWritePrivateFile(configPath, candidateContent);
      return { exitCode: 0, stdout: `Added global pattern: ${pattern}\n` };
    });
  }

  // Project-local
  const pDir = projectDir(cwd);
  const patternsFile = join(pDir, "sensitive-patterns.txt");
  return withBackendPublicationConsumerLockAsync(
    backendPublicationHomeForConfigPath(configPath),
    async () => {
      await mkdir(pDir, { recursive: true });
      const existing = loadProjectPatternsBounded(patternsFile);
      if (existing.includes(pattern)) {
        return { exitCode: 0, stdout: `Pattern already present (project): ${pattern}\n` };
      }
      const line = pattern + "\n";
      try {
        const current = readBoundedRegularFile(patternsFile, {
          allowedRoot: dirname(patternsFile),
          maxBytes: MAX_SENSITIVE_PATTERN_BYTES,
        });
        const normalized = current.length > 0 && !current.endsWith("\n") ? current + "\n" : current;
        await writeFile(patternsFile, normalized + line, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // File doesn't exist yet
        await writeFile(patternsFile, line, "utf-8");
      }
      return { exitCode: 0, stdout: `Added project pattern: ${pattern}\n` };
    },
  );
}

async function sensitiveRemove(
  args: string[],
  cwd: string,
  configPath: string,
): Promise<{ exitCode: number; stdout: string }> {
  const pattern = args.find((a) => !a.startsWith("--"));
  if (!pattern) {
    return {
      exitCode: 1,
      stdout: 'Usage: lcm sensitive remove "<pattern>"\n',
    };
  }

  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const existing = await withBackendPublicationConsumerLockAsync(
    backendPublicationHomeForConfigPath(configPath),
    () => loadProjectPatternsBounded(patternsFile),
  );

  if (!existing.includes(pattern)) {
    return {
      exitCode: 1,
      stdout: `Pattern not found in project patterns: ${pattern}\n`,
    };
  }

  // Read the raw file and remove only lines matching the pattern, preserving comments and blanks
  await withBackendPublicationConsumerLockAsync(
    backendPublicationHomeForConfigPath(configPath),
    async () => {
      let raw = "";
      try {
        raw = readBoundedRegularFile(patternsFile, {
          allowedRoot: dirname(patternsFile),
          maxBytes: MAX_SENSITIVE_PATTERN_BYTES,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // file disappeared between load and remove — treat as already removed
      }
      const updatedLines = raw
        .split("\n")
        .filter((line) => line.trim() !== pattern);
      const updatedContent = updatedLines.join("\n").replace(/\n+$/, "") + "\n";
      await writeFile(patternsFile, updatedContent, "utf-8");
    },
  );

  return { exitCode: 0, stdout: `Removed project pattern: ${pattern}\n` };
}

async function sensitiveTest(
  args: string[],
  cwd: string,
  configPath: string,
): Promise<{ exitCode: number; stdout: string }> {
  const input = args.find((a) => !a.startsWith("--"));
  if (input === undefined) {
    return {
      exitCode: 1,
      stdout: 'Usage: lcm sensitive test "<string>"\n',
    };
  }

  const globalUserPatterns = loadGlobalUserPatterns(configPath);
  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const engine = await ScrubEngine.forProject(globalUserPatterns, projectDir(cwd));

  const redacted = engine.scrub(input);

  const lines: string[] = [];

  // Find which patterns matched
  const projectPatterns = await withBackendPublicationConsumerLockAsync(
    backendPublicationHomeForConfigPath(configPath),
    () => loadProjectPatternsBounded(patternsFile),
  );

  const matched: string[] = [];

  // Check gitleaks patterns first
  for (const p of GITLEAKS_PATTERNS) {
    try {
      if (new RegExp(p.regex, p.flags).test(input)) {
        matched.push(`  [gitleaks:${p.id}]  ${p.regex}`);
      }
    } catch {
      // invalid pattern — skip
    }
  }

  // Check native patterns
  for (const source of NATIVE_PATTERNS) {
    try {
      if (new RegExp(source).test(input)) {
        matched.push(`  [native]  ${source}`);
      }
    } catch {
      // invalid pattern — skip
    }
  }

  // Check global/project patterns
  const userPatterns = [
    ...globalUserPatterns.map((p) => ({ source: p, kind: "global" as const })),
    ...projectPatterns.map((p) => ({ source: p, kind: "project" as const })),
  ];
  for (const { source, kind } of userPatterns) {
    try {
      if (validateRegex(source).test(input)) {
        matched.push(`  [${kind}]  ${source}`);
      }
    } catch {
      // invalid pattern — skip
    }
  }

  if (matched.length === 0) {
    lines.push("No patterns matched.");
    lines.push(`Input:    ${input}`);
  } else {
    lines.push("Matched patterns:");
    lines.push(...matched);
    lines.push(`Input:    ${input}`);
    lines.push(`Redacted: ${redacted}`);
  }

  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

async function sensitivePurge(
  args: string[],
  cwd: string,
  configPath: string,
): Promise<{ exitCode: number; stdout: string }> {
  const hasYes = args.includes("--yes");
  const purgeAll = args.includes("--all");

  if (!hasYes) {
    return {
      exitCode: 1,
      stdout:
        "Error: lcm sensitive purge requires --yes to confirm.\n" +
        "  lcm sensitive purge --yes           (current project)\n" +
        "  lcm sensitive purge --all --yes      (all projects)\n",
    };
  }

  const publicationHome = backendPublicationHomeForConfigPath(configPath);
  const storage = loadStoredConfigProjection(configPath).storage;
  selectStorageBackend({ ...storage, homeDir: publicationHome });

  if (purgeAll) {
    const allProjectsDir = runtimeProjectsDir();
    return withBackendPublicationConsumerLockAsync(
      publicationHome,
      () => {
        if (existsSync(allProjectsDir)) {
          rmSync(allProjectsDir, { recursive: true, force: true });
          return {
            exitCode: 0,
            stdout: `Purged all project data: ${allProjectsDir}\n`,
          };
        }
        return { exitCode: 0, stdout: "No project data to purge.\n" };
      },
    );
  }

  // Current project only
  const pDir = projectDir(cwd);
  return withBackendPublicationConsumerLockAsync(
    publicationHome,
    () => {
      if (existsSync(pDir)) {
        rmSync(pDir, { recursive: true, force: true });
        return { exitCode: 0, stdout: `Purged project data: ${pDir}\n` };
      }
      return { exitCode: 0, stdout: "No project data to purge.\n" };
    },
  );
}
