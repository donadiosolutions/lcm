/**
 * CLI help text for lcm.
 *
 * Consumed by bin/lcm.ts:
 *   printHelp()           — full command reference (lcm --help)
 *   printHelp(command)    — per-command detail   (lcm compact --help)
 */

type FlagHelp = readonly [flag: string, description: string];
type ExampleHelp = readonly [command: string, description: string];

interface CommandHelp {
  summary: string;
  usage: string;
  options?: FlagHelp[];
  examples: ExampleHelp[];
  notes?: string;
}

const HELP: Record<string, CommandHelp> = {
  install: {
    summary: "Set up lcm: register Claude Code hooks, configure the daemon, and connect the MCP server.",
    usage: "lcm install [--dry-run]",
    options: [
      ["--dry-run", "Preview all changes without writing anything"],
    ],
    examples: [
      ["lcm install", "Run the full setup wizard"],
      ["lcm install --dry-run", "Preview what install would do"],
    ],
  },

  uninstall: {
    summary: "Remove lcm hooks and MCP registration.",
    usage: "lcm uninstall [--dry-run]",
    options: [
      ["--dry-run", "Preview removals without writing anything"],
    ],
    examples: [
      ["lcm uninstall", "Remove all lcm integrations"],
      ["lcm uninstall --dry-run", "Preview what uninstall would do"],
    ],
  },

  daemon: {
    summary: "Start or restart the context daemon that stores and processes memory.",
    usage: "lcm daemon start [--detach] [--foreground]\n         lcm daemon restart",
    options: [
      ["--detach", "For daemon start: compatibility alias for the default managed background start"],
      ["--foreground", "For daemon start: run in the current terminal for debugging"],
    ],
    examples: [
      ["lcm daemon start", "Start managed daemon in background (recommended)"],
      ["lcm daemon start --detach", "Start managed daemon in background (compatibility alias)"],
      ["lcm daemon start --foreground", "Start daemon in foreground (for debugging)"],
      ["lcm daemon restart", "Reload configuration by restarting the managed daemon"],
    ],
    notes: "On Linux, background starts prefer the user's systemd manager. The daemon runs on port 3737 by default. Configure via ~/.lcm/config.json.",
  },

  config: {
    summary: "Inspect or update validated local configuration.",
    usage: "lcm config <get|set> <json.config.key.path> [value] [--effective] [--json]",
    options: [
      ["--effective", "For get, include defaults and environment-variable overrides"],
      ["--json", "For set, parse value as JSON instead of storing a string"],
    ],
    examples: [
      ["lcm config get llm.provider", "Show the normalized value stored in config.json"],
      ["lcm config get llm.model --effective", "Show the model after defaults and environment overrides"],
      ["lcm config set llm.provider codex-process", "Store a validated string value"],
      ["lcm config set hooks.disableAutoCompact true --json", "Store a typed boolean value"],
    ],
    notes: "Stored reads normalize compatibility aliases without rewriting the file. Secret-like values are always masked, including with --effective. Setting llm.provider removes controls unsupported by the destination: request timeouts are retained for auto, OpenAI, Claude process, and Codex process providers, while API mode and retries remain OpenAI-only; custom and openai-compatible normalize to OpenAI and retain those settings. Successful writes are atomic, preserve unrelated keys, and require `lcm daemon restart` before a running daemon uses the new configuration.",
  },

  status: {
    summary: "Show daemon status, version, uptime, and project memory statistics.",
    usage: "lcm status [--json]",
    options: [
      ["--json", "Output structured JSON (useful for scripting)"],
    ],
    examples: [
      ["lcm status", "Show human-readable status"],
      ["lcm status --json", "Show machine-readable status"],
    ],
  },

  doctor: {
    summary: "Run diagnostics — checks daemon health, hooks, MCP server, and summarizer.",
    usage: "lcm doctor [--verbose] [--events-max-dbs <n|all|unlimited>]",
    options: [
      ["--verbose", "Show detailed passive-learning sidecar diagnostics"],
      ["--events-max-dbs <n|all|unlimited>", "Limit passive-learning sidecar DB scans (default: 50; use all/unlimited for no count limit)"],
    ],
    examples: [
      ["lcm doctor", "Run all diagnostic checks"],
      ["lcm doctor --verbose", "Include per-sidecar passive-learning diagnostics"],
      ["lcm doctor --events-max-dbs all", "Remove the passive-learning sidecar scan count limit"],
    ],
    notes: "Exits with code 1 if any check fails. Integrate into CI or shell startup for early detection.",
  },

  machine: {
    summary: "Register, inspect, or recover this machine's PostgreSQL UUID identity.",
    usage: "lcm machine <register|show|recover> [options]",
    options: [
      ["register [--name <name>] [--json]", "Create or idempotently refresh ~/.lcm/machine.json"],
      ["show [--json]", "Show the local registration state without printing its opaque identity key"],
      ["recover <machine-id> [--force] [--json]", "Recover an explicit PostgreSQL machine UUID"],
    ],
    examples: [
      ["lcm machine register --name workstation", "Register this machine"],
      ["lcm machine show --json", "Inspect the local identity state"],
      ["lcm machine recover 018f... --force", "Replace and back up a stale or corrupt local file"],
    ],
    notes: "Registration requires the PostgreSQL backend configuration. machine.json and its backups use mode 0600. Recovery never guesses from hostnames, Git remotes, or repository content.",
  },

  project: {
    summary: "Manage local path aliases and explicit PostgreSQL project identities.",
    usage: "lcm project <create|link|unlink|list|show|reconcile-worktrees> [options]",
    options: [
      ["create [path] [--name <name>] [--json]", "Create and bind a PostgreSQL project"],
      ["link <project-id|local-target> [path] [--allow-existing-data] [--json]", "Link a path explicitly"],
      ["unlink [path] [--json]", "Remove a local alias or PostgreSQL binding"],
      ["list [--json]", "List local mappings and, when selected, PostgreSQL projects"],
      ["show [path|local-hash|remote-project-id] [--json]", "Show one uniquely mapped local project and its remote identity"],
      ["reconcile-worktrees [path] [--dry-run] [--json]", "Preview, retry, or report linked-worktree state consolidation"],
    ],
    examples: [
      ["lcm project create --name lcm", "Create a remote project for the current path"],
      ["lcm project link 018f... /work/lcm", "Bind a path to an explicit PostgreSQL project"],
      ["lcm project link <local-hash> /work/lcm-alias", "Add a same-machine path alias"],
      ["lcm project unlink /work/lcm-alias", "Remove an alias without deleting local data"],
      ["lcm project list --json", "Inspect local and remote identities"],
      ["lcm project show <remote-project-uuid>", "Show the unique local mapping for a remote project"],
      ["lcm project reconcile-worktrees --dry-run", "Preview local worktree state consolidation"],
    ],
    notes: "Linked Git worktrees share one local project through their verified Git common directory. Reconciliation preserves source databases and event sidecars under oldprojects and oldevents. A remote UUID show target must have exactly one local binding. Git identity never creates or changes a PostgreSQL UUID; conflicting remote bindings fail closed. Repository URLs are used only as conservative evidence for deleted Codex worktree transcripts. Rebinding a data-bearing local project requires --allow-existing-data.",
  },

  postgres: {
    summary: "Apply the packaged PostgreSQL schema as an administrator-controlled migration role.",
    usage: "lcm postgres migrate [--json]",
    options: [
      ["migrate [--json]", "Verify and apply packaged checksummed migrations"],
    ],
    examples: [
      ["lcm postgres migrate", "Apply pending migrations and report the current schema history"],
      ["lcm postgres migrate --json", "Return applied and current migration IDs as JSON"],
    ],
    notes: "Configure storage.backend=postgresql and supply the migration role through LCM_POSTGRES_URL plus the verified CA path through LCM_POSTGRES_CA_FILE. The command validates PostgreSQL 18, extensions, ownership, migration checksums, and schema fingerprints. It does not install extensions or grant runtime privileges.",
  },

  search: {
    summary: "Search memory across episodic and promoted layers for the current project.",
    usage: "lcm search <query> [--limit N] [--layer episodic|promoted] [--tag <tag>]",
    options: [
      ["--limit N", "Max results per layer (default: 5)"],
      ["--layer <name>", "Layer to search: episodic or promoted (repeatable)"],
      ["--tag <tag>", "Filter to entries that include all specified tags (repeatable)"],
    ],
    examples: [
      ["lcm search \"authentication decision\"", "Search both memory layers for auth-related context"],
      ["lcm search \"sqlite migration\" --layer episodic", "Search only episodic memory"],
      ["lcm search \"hook failure\" --tag type:solution", "Filter by tag"],
    ],
  },

  grep: {
    summary: "Search raw messages and summaries by keyword or regex.",
    usage: "lcm grep <query> [--mode full_text|regex] [--scope messages|summaries|both] [--since <iso>]",
    options: [
      ["--mode <mode>", "Search mode: full_text (default) or regex"],
      ["--scope <scope>", "Scope: messages, summaries, or both (default: both)"],
      ["--since <iso>", "Only include matches on or after this ISO timestamp"],
    ],
    examples: [
      ["lcm grep \"ECONNREFUSED\"", "Search for an exact error string"],
      ["lcm grep \"createDaemon|startMcpServer\" --mode regex", "Regex search across history"],
      ["lcm grep \"migration\" --scope summaries", "Search only summaries"],
    ],
  },

  describe: {
    summary: "Inspect metadata and lineage for a stored summary node.",
    usage: "lcm describe <nodeId>",
    examples: [
      ["lcm describe sum_abc123def456", "Show metadata for a summary node"],
    ],
    notes: "Use lcm search or lcm grep first to find a node ID worth inspecting.",
  },

  expand: {
    summary: "Expand a summary node back into lower-level source detail.",
    usage: "lcm expand <nodeId> [--depth N]",
    options: [
      ["--depth N", "Traversal depth (default: 1)"],
    ],
    examples: [
      ["lcm expand sum_abc123def456", "Expand a summary one level deep"],
      ["lcm expand sum_abc123def456 --depth 2", "Traverse deeper into the DAG"],
    ],
  },

  store: {
    summary: "Store a durable memory entry for the current project.",
    usage: "lcm store <text> [--tag <tag>]",
    options: [
      ["--tag <tag>", "Attach a tag to the stored memory (repeatable)"],
    ],
    examples: [
      ["lcm store \"Auth uses JWT with 24h expiry\"", "Store a plain-text memory"],
      ["lcm store \"Use ensureDaemon before background promote\" --tag type:solution --tag scope:lcm", "Store a tagged memory"],
    ],
  },

  compact: {
    summary: "Compact conversation context into DAG summary nodes.",
    usage: "lcm compact [--all] [--dry-run] [--replay] [--no-promote] [LLM overrides]",
    options: [
      ["--all", "Compact all tracked projects (default: current project only)"],
      ["--dry-run", "Show what would be compacted without writing anything"],
      ["--replay", "Compact sequentially, threading each summary through the prior context"],
      ["--no-promote", "Skip the automatic promote step that runs after compaction"],
      ["--reasoning-effort <level>", "Override provider reasoning effort for this invocation"],
      ["--fast-mode", "Enable process-provider fast mode for this invocation"],
      ["--no-fast-mode", "Disable process-provider fast mode for this invocation"],
      ["--timeout-ms <ms>", "Override llm.requestTimeoutMs for this invocation"],
      ["--retry-max-attempts <n>", "Override llm.retry.maxAttempts for this invocation"],
      ["--retry-initial-delay-ms <ms>", "Override llm.retry.initialDelayMs for this invocation"],
      ["--retry-max-delay-ms <ms>", "Override llm.retry.maxDelayMs for this invocation"],
      ["--retry-multiplier <n>", "Override llm.retry.multiplier for this invocation"],
    ],
    examples: [
      ["lcm compact", "Compact current project"],
      ["lcm compact --all", "Compact all tracked projects"],
      ["lcm compact --dry-run", "Preview compaction for current project"],
      ["lcm compact --all --replay", "Rebuild all projects with threaded context (slow)"],
      ["lcm compact --no-promote", "Compact without auto-promoting new insights"],
      ["lcm compact --reasoning-effort high", "Use high reasoning for this compaction only"],
      ["lcm compact --fast-mode", "Enable fast mode for this process-provider compaction only"],
      ["lcm compact --timeout-ms 300000", "Allow a longer OpenAI or process-provider request"],
      ["lcm compact --retry-max-attempts 4", "Temporarily retry an OpenAI-compatible request"],
    ],
    notes: "When invoked via the PreCompact hook (piped stdin), runs automatically during Claude Code context compaction. After a successful compact, promote runs automatically to surface new insights to long-term memory. --reasoning-effort overrides llm.reasoningEffort for this invocation without rewriting ~/.lcm/config.json. Supported values are OpenAI Responses: none, minimal, low, medium, high, xhigh; Claude process: low, medium, high, xhigh, max; Codex process: minimal, low, medium, high, xhigh. Stored llm.provider=auto configuration accepts the shared low, medium, high, and xhigh values; invocation overrides under auto validate against the actual resolved process provider. --fast-mode and --no-fast-mode override llm.fastMode for one auto or process-provider invocation without rewriting the file. --timeout-ms overrides JSON for OpenAI, auto, and process providers without rewriting it. Retry flags remain OpenAI-compatible-only.",
  },

  import: {
    summary: "Import Claude Code and Codex session transcripts into lossless memory.",
    usage: "lcm import [--provider claude|codex|all] [--codex] [--all] [--verbose] [--dry-run] [--replay]",
    options: [
      ["--provider <name>", "Transcript provider: claude, codex, or all (default: claude)"],
      ["--codex", "Shorthand for --provider codex"],
      ["--all", "Import all projects (default: current project only)"],
      ["--verbose", "Show per-session import detail"],
      ["--dry-run", "Preview without importing"],
      ["--replay", "Replay compaction for each imported session"],
    ],
    examples: [
      ["lcm import", "Import current Claude Code project sessions"],
      ["lcm import --codex", "Import Codex CLI sessions for the current canonical project"],
      ["lcm import --codex --all", "Import resolved Codex CLI sessions for all local projects"],
      ["lcm import --provider all", "Import Claude Code and Codex CLI sessions"],
      ["lcm import --all", "Import all tracked Claude Code projects"],
      ["lcm import --all --replay", "Import and compact with threaded context"],
      ["lcm import --dry-run", "Preview what would be imported"],
    ],
    notes: "Claude sessions are read from ~/.claude/projects/. Codex sessions are read from ~/.codex/sessions and ~/.codex/archived_sessions. Codex import uses live Git evidence, exact thread ownership, or a unique repository match under an existing ~/.codex/worktrees tombstone; ambiguous and unresolved sessions are reported and skipped. Already-imported completed sessions are skipped.",
  },

  promote: {
    summary: "Scan summaries and promote durable insights to long-term memory.",
    usage: "lcm promote [--all] [--verbose] [--dry-run]",
    options: [
      ["--all", "Promote across all tracked projects (default: current project)"],
      ["--verbose", "Show per-project counts"],
      ["--dry-run", "Preview promotions without writing"],
    ],
    examples: [
      ["lcm promote", "Promote insights for current project"],
      ["lcm promote --all", "Promote across all projects"],
      ["lcm promote --all --verbose", "Show detail for each project"],
      ["lcm promote --dry-run", "Preview what would be promoted"],
    ],
  },

  stats: {
    summary: "Show memory inventory: message counts, compression ratios, and summary statistics.",
    usage: "lcm stats [-v]",
    options: [
      ["-v, --verbose", "Show per-conversation breakdown"],
    ],
    examples: [
      ["lcm stats", "Summary view across all projects"],
      ["lcm stats -v", "Per-conversation detail"],
    ],
  },

  events: {
    summary: "Manually remediate passive-learning sidecar queues.",
    usage: "lcm events promote [--all] [--json]",
    options: [
      ["promote", "Manually drain queued passive-learning events for the current project"],
      ["promote --all", "Manually drain queued events from all metadata-backed project sidecars"],
      ["--json", "Output structured JSON"],
    ],
    examples: [
      ["lcm events promote", "Remediate queued passive events for the current project"],
      ["lcm events promote --all", "Remediate stale passive-event sidecars across all known projects"],
      ["lcm events promote --all --json", "Show per-sidecar promotion results"],
    ],
    notes: "Passive events are normally processed by the daemon automatically. Sidecars without project metadata are reported but cannot be mapped back to a cwd automatically.",
  },

  diagnose: {
    summary: "Scan recent sessions for hook failures, MCP disconnects, and stale state.",
    usage: "lcm diagnose [--all] [--days N] [--verbose] [--json]",
    options: [
      ["--all", "Scan all tracked projects (default: current project)"],
      ["--days N", "Scan the last N days (default: 7)"],
      ["--verbose", "Include full event details in output"],
      ["--json", "Output structured JSON"],
    ],
    examples: [
      ["lcm diagnose", "Scan last 7 days for current project"],
      ["lcm diagnose --days 30", "Scan last 30 days"],
      ["lcm diagnose --all --verbose", "Full detail across all projects"],
      ["lcm diagnose --json", "Machine-readable output"],
    ],
  },

  connectors: {
    summary: "Manage connectors for coding agents (Claude Code, Codex, Gemini, etc.).",
    usage: "lcm connectors <list|install|remove|doctor> [options]",
    options: [
      ["list [--format text|json] [--global]", "List connectors in the current project or your global agent config"],
      ["install <agent> [--type rules|hook|mcp|skill] [--global]", "Install a connector for an agent"],
      ["remove <agent> [--type rules|hook|mcp|skill] [--global]", "Remove a connector for an agent"],
      ["doctor [agent] [--global]", "Check connector health in the current project or global agent config"],
    ],
    examples: [
      ["lcm connectors list", "Show all agents and their connector status"],
      ["lcm connectors list --global", "Show connectors from your global agent config"],
      ["lcm connectors list --format json", "Machine-readable connector list"],
      ["lcm connectors install github-copilot", "Install the GitHub Copilot workspace skill for VS Code"],
      ["lcm connectors install codex", "Install Codex hooks, skill, and rules"],
      ["lcm connectors install codex --global", "Install Codex into ~/.codex instead of the current project"],
      ["lcm connectors install codex --type skill", "Install only the Codex skill"],
      ["lcm connectors install codex --type rules", "Install only the Codex rules"],
      ["lcm connectors remove codex", "Remove the Codex connector"],
      ["lcm connectors remove codex --global", "Remove Codex from your global config"],
      ["lcm connectors doctor", "Check health of all connectors"],
      ["lcm connectors doctor --global", "Check the global agent config"],
      ["lcm connectors doctor github-copilot", "Check GitHub Copilot connector health"],
      ["lcm connectors doctor codex", "Check Codex connector health"],
    ],
    notes: "Connector types: 'rules' (agent instruction file), 'hook' (native lifecycle hooks), 'mcp' (MCP server), 'skill' (skill file). GitHub Copilot uses a repo-local skill under .github/skills/. Codex defaults to hooks in ~/.codex/hooks.json, a skill in .codex/skills/, and rules in ~/.codex/AGENTS.md.",
  },

  sensitive: {
    summary: "Manage sensitive patterns for automatic redaction before memory storage.",
    usage: "lcm sensitive <list|add|remove|test|purge> [options]",
    options: [
      ["list", "List active redaction patterns (built-in and custom)"],
      [`add "<pattern>" [--global]`, "Add a regex pattern (project-local by default; --global applies to all projects)"],
      [`remove "<pattern>"`, "Remove a custom redaction pattern"],
      [`test "<text>"`, "Test text against active patterns, showing what would be redacted"],
      ["purge [--all] [--yes]", "IRREVERSIBLY delete the project data directory, including stored memory and custom patterns (--all: all projects; --yes: skip confirm)"],
    ],
    examples: [
      ["lcm sensitive list", "Show all active patterns"],
      ['lcm sensitive add "sk-[a-zA-Z0-9]+"', "Add a project-local pattern to redact API keys starting with 'sk-'"],
      ['lcm sensitive add --global "sk-[a-zA-Z0-9]+"', "Add a global pattern that applies across all projects"],
      ['lcm sensitive remove "sk-[a-zA-Z0-9]+"', "Remove that pattern"],
      ['lcm sensitive test "my key is sk-abc123"', "See what gets redacted"],
      ["lcm sensitive purge --yes", "IRREVERSIBLY delete all stored memory and patterns for current project"],
      ["lcm sensitive purge --all --yes", "IRREVERSIBLY delete all stored memory and patterns for ALL projects"],
    ],
    notes: "Built-in patterns cover common secrets (API keys, tokens, passwords). Project patterns are stored in ~/.lcm/projects/<id>/sensitive-patterns.txt; global patterns are stored in config.json. The 'purge' subcommand deletes the entire project data directory (including stored memory) and cannot be undone.",
  },

  export: {
    summary: "Export promoted knowledge to a portable JSON file (secrets scrubbed).",
    usage: "lcm export [--all] [--tags <tags>] [--since <date>] [--output <file>]",
    options: [
      ["--all", "Export all projects (one file per project, auto-named)"],
      ["--tags <tags>", "Only export entries that have all these comma-separated tags"],
      ["--since <date>", "Only export entries created on or after this ISO date (e.g. 2026-01-01)"],
      ["--output <file>", "Write output to file instead of stdout"],
      ["--format <format>", "Output format: json (default)"],
    ],
    examples: [
      ["lcm export", "Print current project knowledge to stdout"],
      ["lcm export --output knowledge.json", "Write to a file"],
      ["lcm export --since 2026-01-01", "Only export entries from 2026 onward"],
      ["lcm export --tags decision,architecture", "Only export entries tagged with both tags"],
      ["lcm export --all", "Export all projects to auto-named JSON files"],
    ],
    notes: "Secrets are automatically scrubbed using the project's sensitive patterns before export. The JSON format is: { version, exportedAt, projectCwd, entries: [{content, tags, confidence, createdAt, sessionId}] }.",
  },

  "import-knowledge": {
    summary: "Import a portable JSON export back into lossless memory.",
    usage: "lcm import-knowledge <file> [--dry-run] [--confidence <n>]",
    options: [
      ["<file>", "Path to the JSON export file produced by lcm export"],
      ["--merge", "Merge with existing entries, deduplicating (default)"],
      ["--dry-run", "Preview what would be imported without writing anything"],
      ["--confidence <n>", "Override the confidence score for all imported entries (0.0–1.0)"],
    ],
    examples: [
      ["lcm import-knowledge knowledge.json", "Import entries into current project"],
      ["lcm import-knowledge knowledge.json --dry-run", "Preview without writing"],
      ["lcm import-knowledge knowledge.json --confidence 0.7", "Import with reduced confidence"],
    ],
    notes: "Deduplication is performed automatically: near-duplicate entries are merged rather than inserted twice. Run from the target project directory.",
  },

  mcp: {
    summary: "Start the lcm MCP server (used by Claude Code to expose memory tools).",
    usage: "lcm mcp",
    examples: [
      ["lcm mcp", "Start the MCP server (stdio transport)"],
    ],
    notes: "Normally launched automatically by Claude Code via the mcpServers config. No need to run manually.",
  },

  restore: {
    summary: "Dispatch the restore hook — restores prior context at session start.",
    usage: "lcm restore",
    examples: [
      ["lcm restore", "Restore context for the current session (called by SessionStart hook)"],
    ],
    notes: "Invoked automatically by the Claude Code SessionStart hook. Not intended for direct use.",
  },

  "session-end": {
    summary: "Dispatch the session-end hook — finalizes and stores session memory.",
    usage: "lcm session-end",
    examples: [
      ["lcm session-end", "Finalize session memory (called by Stop hook)"],
    ],
    notes: "Invoked automatically by the Claude Code Stop hook. Not intended for direct use.",
  },

  "user-prompt": {
    summary: "Dispatch the user-prompt hook — records context on each user message.",
    usage: "lcm user-prompt",
    examples: [
      ["lcm user-prompt", "Record user prompt context (called by UserPromptSubmit hook)"],
    ],
    notes: "Invoked automatically by Claude Code and Codex UserPromptSubmit hooks. Not intended for direct use.",
  },

  "post-tool": {
    summary: "Dispatch the post-tool hook — records tool invocation events.",
    usage: "lcm post-tool",
    examples: [
      ["lcm post-tool", "Record post-tool events (called by PostToolUse hook)"],
    ],
    notes: "Invoked automatically by Claude Code and Codex PostToolUse hooks. Not intended for direct use.",
  },

  "session-snapshot": {
    summary: "Dispatch the rolling session snapshot hook.",
    usage: "lcm session-snapshot",
    examples: [
      ["lcm session-snapshot", "Ingest transcript deltas (called by Stop and PreCompact hooks)"],
    ],
    notes: "Used by Codex Stop hooks for rolling writeback and Codex PreCompact hooks for forced pre-compaction snapshots. Also used by Claude Code Stop hooks for best-effort snapshots. Not intended for direct use.",
  },
};

const GROUPS = [
  {
    label: "Setup",
    commands: [
      { name: "install [--dry-run]", summary: "Register hooks, configure daemon, connect MCP" },
      { name: "uninstall [--dry-run]", summary: "Remove hooks and MCP registration" },
    ],
  },
  {
    label: "Runtime",
    commands: [
      { name: "daemon start [--detach] [--foreground]", summary: "Start the context daemon" },
      { name: "daemon restart", summary: "Restart the daemon and reload configuration" },
      { name: "config <get|set> <path>", summary: "Inspect or update validated local configuration" },
      { name: "status [--json]", summary: "Daemon status and project memory stats" },
      { name: "doctor", summary: "Diagnostics: daemon, hooks, MCP, summarizer" },
      { name: "machine <register|show|recover>", summary: "Manage this machine's PostgreSQL identity" },
      { name: "project <create|link|unlink|list|show|reconcile-worktrees>", summary: "Manage local and PostgreSQL project identities" },
      { name: "postgres migrate [--json]", summary: "Apply packaged PostgreSQL schema migrations" },
      { name: "mcp", summary: "Start the MCP server (stdio transport)" },
    ],
  },
  {
    label: "Memory",
    commands: [
      { name: "search <query> [--limit N]", summary: "Search episodic and promoted memory" },
      { name: "grep <query> [--mode ...]", summary: "Search raw messages and summaries" },
      { name: "describe <nodeId>", summary: "Inspect metadata for a memory node" },
      { name: "expand <nodeId> [--depth N]", summary: "Expand a summary node into source detail" },
      { name: "store <text> [--tag ...]", summary: "Store a durable memory entry" },
      { name: "compact [--all] [--dry-run] [--replay] [--no-promote] [LLM overrides]", summary: "Compact conversations into DAG summaries (auto-promotes after)" },
      { name: "import [--provider ...] [--all] [--verbose] [--dry-run] [--replay]", summary: "Import Claude Code and Codex session transcripts" },
      { name: "promote [--all] [--verbose] [--dry-run]", summary: "Promote insights to long-term memory" },
      { name: "stats [-v]", summary: "Memory inventory and compression ratios" },
      { name: "events promote [--all] [--json]", summary: "Manually remediate passive-learning sidecar queues" },
      { name: "diagnose [--all] [--days N] [--verbose] [--json]", summary: "Scan sessions for hook failures and issues" },
    ],
  },
  {
    label: "Connectors",
    commands: [
      { name: "connectors list [--format text|json]", summary: "List available agents and installed connectors" },
      { name: "connectors install <agent> [--type ...] [--global]", summary: "Install connector for a coding agent" },
      { name: "connectors remove <agent> [--type ...] [--global]", summary: "Remove connector for a coding agent" },
      { name: "connectors doctor [agent] [--global]", summary: "Check connector health" },
    ],
  },
  {
    label: "Portable Knowledge",
    commands: [
      { name: "export [--all] [--output <file>]", summary: "Export promoted knowledge to JSON (secrets scrubbed)" },
      { name: "import-knowledge <file>", summary: "Import exported knowledge JSON, deduplicating on merge" },
    ],
  },
  {
    label: "Sensitive",
    commands: [
      { name: "sensitive list", summary: "List active redaction patterns" },
      { name: "sensitive add <pattern>", summary: "Add a redaction pattern" },
      { name: "sensitive remove <pattern>", summary: "Remove a redaction pattern" },
      { name: "sensitive test <text>", summary: "Test text against active patterns" },
      { name: "sensitive purge [--all] [--yes]", summary: "Purge all project data (stored memory and patterns)" },
    ],
  },
  {
    label: "Hooks (internal)",
    commands: [
      { name: "restore", summary: "SessionStart hook — restore prior context" },
      { name: "session-end", summary: "Stop hook — finalize and store session memory" },
      { name: "session-snapshot", summary: "Stop hook — ingest rolling transcript snapshots" },
      { name: "user-prompt", summary: "UserPromptSubmit hook — record user prompt context" },
      { name: "post-tool", summary: "PostToolUse hook — record tool invocation events" },
    ],
  },
];

function pad(str: string, width: number): string {
  return str + " ".repeat(width - str.length);
}

export function printHelp(command?: string): void {
  if (command) {
    printCommandHelp(command);
    return;
  }

  const lines: string[] = [
    "",
    "  lcm — Long Context Manager for coding agents",
    "",
    "  Usage: lcm <command> [options]",
    "",
  ];

  for (const group of GROUPS) {
    lines.push(`  ${group.label}`);
    const maxNameLen = Math.max(...group.commands.map(c => c.name.length));
    for (const cmd of group.commands) {
      lines.push(`    ${pad(cmd.name, maxNameLen + 2)}${cmd.summary}`);
    }
    lines.push("");
  }

  lines.push("  Flags");
  lines.push("    -V, --version            Show version");
  lines.push("    -h, --help               Show this help");
  lines.push("");
  lines.push("  Run 'lcm <command> --help' for options and examples.");
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

function printCommandHelp(command: string): void {
  const h = HELP[command];
  if (!h) {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return;
  }

  const lines: string[] = [
    "",
    `  lcm ${command} — ${h.summary}`,
    "",
    `  Usage: ${h.usage}`,
    "",
  ];

  if (h.options && h.options.length > 0) {
    lines.push("  Options:");
    const maxLen = Math.max(...h.options.map(([f]) => f.length));
    for (const [flag, desc] of h.options) {
      lines.push(`    ${pad(flag, maxLen + 2)}${desc}`);
    }
    lines.push("");
  }

  lines.push("  Examples:");
  const maxLen = Math.max(...h.examples.map(([cmd]) => cmd.length));
  for (const [cmd, desc] of h.examples) {
    lines.push(`    ${pad(cmd, maxLen + 2)}${desc}`);
  }
  lines.push("");

  if (h.notes) {
    lines.push(`  Note: ${h.notes}`);
    lines.push("");
  }

  process.stdout.write(lines.join("\n") + "\n");
}
