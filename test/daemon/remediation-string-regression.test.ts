import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DAEMON_REFUSAL_REASONS,
  mapDaemonRefusalToRemediation,
} from "../../src/daemon/remediation.js";

const repositoryRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const productionFiles = [
  "bin/lcm.ts", "src/doctor/doctor.ts", "src/cli-help.ts", "src/hooks/user-prompt.ts",
  "src/hooks/compact.ts", "src/hooks/restore.ts", "src/hooks/session-end.ts",
  "src/mcp/server.ts"
];

// Keep this list explicit: these are the tracked Markdown/help surfaces that
// can copy recovery instructions to an operator or an installed connector.
// Implementation and test files are intentionally excluded so compatibility
// aliases and lifecycle seams remain testable without becoming recovery advice.
const guidanceSurfaceFiles = [
  "README.md", ".codex/skills/lcm-memory/SKILL.md", ".claude/commands/lcm-dogfood.md",
  ".agents/skills/lcm-context/SKILL.md", ".agents/skills/lcm-dogfood/SKILL.md",
  ".agents/skills/lcm-dogfood/references/checks.md",
  ".agents/skills/lcm-dogfood/references/known-issues.md",
  ".agents/skills/lcm-e2e/SKILL.md", ".agents/skills/lcm-e2e/checklist.md",
  ".agents/skills/lcm-release/SKILL.md", "docs/README.md", "docs/agent-tools.md",
  "docs/architecture.md", "docs/cli.md", "docs/configuration.md",
  "docs/daemon-restart-recovery.md",
  "docs/external-admission.md", "docs/fts5.md", "docs/hook-protocol.md",
  "docs/issue-triage.md", "docs/passive-learning.md", "docs/privacy.md",
  "docs/project-identity.md", "docs/releasing.md", "docs/tag-schema.md",
  "docs/vscode-codex.md", "src/cli-help.ts", "src/connectors/templates/base.md",
  "src/connectors/templates/mcp-base.md",
  "src/connectors/templates/sections/command-reference.md",
  "src/connectors/templates/sections/mcp-workflow.md",
  "src/connectors/templates/sections/workflow.md",
  "src/connectors/templates/skill/SKILL.md",
  "src/connectors/templates/claude/skills/lcm-context/SKILL.md",
  "src/connectors/templates/claude/commands/lcm-compact.md",
  "src/connectors/templates/claude/commands/lcm-curate.md",
  "src/connectors/templates/claude/commands/lcm-diagnose.md",
  "src/connectors/templates/claude/commands/lcm-doctor.md",
  "src/connectors/templates/claude/commands/lcm-import.md",
  "src/connectors/templates/claude/commands/lcm-promote.md",
  "src/connectors/templates/claude/commands/lcm-sensitive.md",
  "src/connectors/templates/claude/commands/lcm-stats.md",
  "src/connectors/templates/claude/commands/lcm-status.md",
  "src/storage/postgresql/reference/postgresql-coordination.md",
  "src/storage/postgresql/reference/postgresql-development.md",
  "src/storage/postgresql/reference/postgresql-memory-administration.md",
  "src/storage/postgresql/reference/postgresql-native-transcripts.md",
  "src/storage/postgresql/reference/postgresql-schema.md",
  "src/storage/postgresql/reference/postgresql-search.md",
  "src/storage/postgresql/reference/postgresql-summary-context.md"
] as const;

const compatibilityFiles = [
  "bin/lcm.ts", "src/bootstrap.ts", "src/daemon/lifecycle.ts", "test/cli-help.test.ts",
  "test/bin/lcm-run-cli.test.ts"
] as const;

const staleRecoveryPatterns: readonly [RegExp, string][] = [
  [/^[ \t]*(?:[$>#][ \t]*)?(?:sudo[ \t]+)?(?:pkill|killall)\b[^\n]*$/imu, "broad process-kill command"],
  [/^[ \t]*(?:[$>#][ \t]*)?(?:sudo[ \t]+)?kill(?:[ \t]+-[A-Z0-9]+)?[ \t]+(?:["']?\$?\{?[A-Za-z_]*PID[A-Za-z0-9_]*\}?["']?|\d+)\b[^\n]*$/imu, "manual PID kill command"],
  [/\blcm\s+start(?:\s+--(?:detach|foreground))?\b/iu, "bare daemon-start alias used as recovery"],
  [/\blcm daemon start --(?:detach|foreground)\b/iu, "compatibility launch used as recovery"],
  [/(?:run|use|try|execute|start)\s+`?(?:pkill|killall|kill)\b[^\n]*/iu, "imperative process kill guidance"],
  [/(?:run|use|try|execute)\s+[^\n]*(?:--detach|--foreground)\b/iu, "compatibility launch used as recovery"],
  [/(?:stop|kill)\s+(?:the\s+)?(?:daemon|process)\s+by\s+(?:PID|path(?:name)?)/iu, "manual PID/path stop guidance"],
];

function readRepositoryFile(file: string): string {
  return readFileSync(join(repositoryRoot, file), "utf8");
}

describe("centralized remediation guidance", () => {
  it("enumerates tracked recovery surfaces and rejects stale unsafe prose", () => {
    expect(new Set(guidanceSurfaceFiles).size).toBe(guidanceSurfaceFiles.length);

    for (const file of guidanceSurfaceFiles) {
      const source = readRepositoryFile(file);
      for (const [pattern, description] of staleRecoveryPatterns) {
        expect(source, `${file}: ${description}`).not.toMatch(pattern);
      }
    }
  });

  it("allows detached/foreground mentions in implementation and explicit compatibility tests", () => {
    const compatibilitySource = compatibilityFiles.map(readRepositoryFile).join("\n");
    expect(compatibilitySource).toContain("--foreground");
    expect(compatibilitySource).toContain("--detach");
    expect(compatibilitySource).toContain("compatibility");
  });

  it("keeps production guidance free of stale manual kill/start loops", () => {
    const source = productionFiles
      .map(file => readFileSync(join(repositoryRoot, file), "utf8"))
      .join("\n");
    expect(source).not.toContain("stop the stale daemon process");
    expect(source).not.toContain("lcm daemon start --detach");
    expect(source).not.toContain("lcm daemon start --foreground");
    expect(source).not.toMatch(/(?:Fix|Try|Start it with|run:)\s*[^\n]*(?:kill|pkill)/u);
    expect(source).not.toMatch(/(?:Fix|Try|Start it with|run:)\s*[^\n]*(?:--foreground|--detach)/u);
  });

  it("documents configuration behavior for stale daemon recovery", () => {
    const source = readRepositoryFile("docs/daemon-restart-recovery.md");
    const staleConfigSection = source.match(
      /### Doctor recovery for stale daemon configuration\n([\s\S]*?)(?=\n## |$)/u,
    )?.[1];
    const normalizedStaleConfigSection = staleConfigSection?.replace(/\s+/gu, " ");

    expect(normalizedStaleConfigSection).toBeDefined();
    expect(normalizedStaleConfigSection).toContain("adds no new configuration options");
    expect(normalizedStaleConfigSection).toContain("existing daemon port");
    expect(normalizedStaleConfigSection).toContain("storage backend");
    expect(normalizedStaleConfigSection).toContain("runtime/entrypoint");
    expect(normalizedStaleConfigSection).toContain("state paths");
    expect(normalizedStaleConfigSection).toContain("user manager configuration");
    expect(normalizedStaleConfigSection).toContain("invoked with `lcm doctor`");
  });

  it("keeps every lifecycle refusal reason on the bounded remediation map", () => {
    for (const reason of DAEMON_REFUSAL_REASONS) {
      const guidance = mapDaemonRefusalToRemediation(reason);
      expect(guidance.message).toContain(`(${reason})`);
      expect(guidance.message).not.toMatch(/kill|pkill|foreground|pid|\/|[A-Za-z]:\\/iu);
    }
  });
});
