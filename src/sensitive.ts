import { readFile, writeFile, mkdir } from "node:fs/promises";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import { NATIVE_PATTERNS, ScrubEngine, readGitleaksSyncDate } from "./scrub.js";
import { GITLEAKS_PATTERNS } from "./generated-patterns.js";
import { projectDir } from "./daemon/project.js";
import { loadStoredConfigProjection } from "./config-projection.js";
import { parseStoredConfig } from "./daemon/config.js";
import { selectStorageBackend } from "./storage/backend.js";
import { validateRegex } from "./store/regex-safety.js";
import { configPath as runtimeConfigPath, projectsDir as runtimeProjectsDir } from "./runtime-paths.js";
import { atomicWritePrivateFile } from "./security-files.js";
import {
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigMutation,
  assertBackendPublicationConsumerAccess,
  backendPublicationHomeForConfigPath,
  BackendPublicationJournalError,
  withBackendPublicationConfigLock,
} from "./storage/backend-publication.js";

function defaultConfigPath(): string {
  return runtimeConfigPath();
}

function loadGlobalUserPatterns(configPath: string): string[] {
  try {
    return loadStoredConfigProjection(configPath).security.sensitivePatterns;
  } catch (error) {
    if (error instanceof BackendPublicationJournalError) throw error;
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
      return sensitiveRemove(argv.slice(1), cwd);
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
  const projectPatterns = await ScrubEngine.loadProjectPatterns(patternsFile);

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
    return withBackendPublicationConfigLock(configPath, () => {
      const publicationHome = backendPublicationHomeForConfigPath(configPath);
      if (publicationHome !== undefined) {
        assertBackendPublicationConsumerAccess({ homeDir: publicationHome });
      }
      let content: string | null = null;
      let raw: Record<string, any> = {};
      try {
        content = readFileSync(configPath, "utf-8");
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
          raw = parsed as Record<string, any>;
        } else {
          return {
            exitCode: 1,
            stdout: `Error: ${configPath} is not a JSON object. Fix the file manually before adding patterns.\n`,
          };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const configuredBackend = (
        raw.storage as { backend?: unknown } | undefined
      )?.backend;
      const currentBackend = configuredBackend === "postgresql" ? "postgresql" : "sqlite";
      assertBackendPublicationConfigAccess(configPath, currentBackend, content);
      if (!raw.security) raw.security = {};
      if (!Array.isArray(raw.security.sensitivePatterns)) {
        raw.security.sensitivePatterns = [];
      }
      if (raw.security.sensitivePatterns.includes(pattern)) {
        return { exitCode: 0, stdout: `Pattern already present (global): ${pattern}\n` };
      }
      raw.security.sensitivePatterns.push(pattern);
      const candidateContent = `${JSON.stringify(raw, null, 2)}\n`;
      parseStoredConfig(candidateContent);
      assertBackendPublicationConfigMutation(
        configPath,
        currentBackend,
        currentBackend,
        candidateContent,
        content,
      );
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      atomicWritePrivateFile(configPath, candidateContent);
      const directoryFd = openSync(
        dirname(configPath),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
      return { exitCode: 0, stdout: `Added global pattern: ${pattern}\n` };
    });
  }

  // Project-local
  const pDir = projectDir(cwd);
  await mkdir(pDir, { recursive: true });
  const patternsFile = join(pDir, "sensitive-patterns.txt");

  const existing = await ScrubEngine.loadProjectPatterns(patternsFile);
  if (existing.includes(pattern)) {
    return { exitCode: 0, stdout: `Pattern already present (project): ${pattern}\n` };
  }

  // Append to file
  const line = pattern + "\n";
  try {
    const current = await readFile(patternsFile, "utf-8");
    const normalized = current.length > 0 && !current.endsWith("\n") ? current + "\n" : current;
    await writeFile(patternsFile, normalized + line, "utf-8");
  } catch {
    // File doesn't exist yet
    await writeFile(patternsFile, line, "utf-8");
  }

  return { exitCode: 0, stdout: `Added project pattern: ${pattern}\n` };
}

async function sensitiveRemove(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  const pattern = args.find((a) => !a.startsWith("--"));
  if (!pattern) {
    return {
      exitCode: 1,
      stdout: 'Usage: lcm sensitive remove "<pattern>"\n',
    };
  }

  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const existing = await ScrubEngine.loadProjectPatterns(patternsFile);

  if (!existing.includes(pattern)) {
    return {
      exitCode: 1,
      stdout: `Pattern not found in project patterns: ${pattern}\n`,
    };
  }

  // Read the raw file and remove only lines matching the pattern, preserving comments and blanks
  let raw = "";
  try {
    raw = await readFile(patternsFile, "utf-8");
  } catch {
    // file disappeared between load and remove — treat as already removed
  }
  const updatedLines = raw
    .split("\n")
    .filter((line) => line.trim() !== pattern);
  // Ensure single trailing newline
  const updatedContent = updatedLines.join("\n").replace(/\n+$/, "") + "\n";
  await writeFile(patternsFile, updatedContent, "utf-8");

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
  const projectPatterns = await ScrubEngine.loadProjectPatterns(patternsFile);

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

  selectStorageBackend(loadStoredConfigProjection(configPath).storage);

  if (purgeAll) {
    const allProjectsDir = runtimeProjectsDir();
    if (existsSync(allProjectsDir)) {
      rmSync(allProjectsDir, { recursive: true, force: true });
      return {
        exitCode: 0,
        stdout: `Purged all project data: ${allProjectsDir}\n`,
      };
    }
    return { exitCode: 0, stdout: "No project data to purge.\n" };
  }

  // Current project only
  const pDir = projectDir(cwd);
  if (existsSync(pDir)) {
    rmSync(pDir, { recursive: true, force: true });
    return { exitCode: 0, stdout: `Purged project data: ${pDir}\n` };
  }
  return { exitCode: 0, stdout: "No project data to purge.\n" };
}
