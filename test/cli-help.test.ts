import { describe, it, expect, vi, afterEach } from "vitest";
import { hasCommandHelp, printHelp } from "../src/cli-help.js";

describe("hasCommandHelp", () => {
  it("recognizes a known topic and rejects an unknown topic", () => {
    expect(hasCommandHelp("store")).toBe(true);
    expect(hasCommandHelp("not-a-real-command")).toBe(false);
  });
});

describe("printHelp — full reference", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("writes to stdout and includes header", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp();
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm — Long Context Manager for coding agents");
    expect(text).toContain("Usage: lcm <command> [options]");
    expect(text).toContain("search <query>");
    expect(text).toContain("store <text>");
  });

  it("lists all groups", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp();
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("Setup");
    expect(text).toContain("Runtime");
    expect(text).toContain("Memory");
    expect(text).toContain("Connectors");
    expect(text).toContain("Sensitive");
    expect(text).toContain("Hooks (internal)");
    expect(text).toContain("post-tool");
  });

  it("includes version and help flags", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp();
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("-V, --version");
    expect(text).toContain("--help");
  });
});

describe("printHelp — per-command detail", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("prints compact command help", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("compact");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm compact");
    expect(text).toContain("--all");
    expect(text).toContain("--dry-run");
    expect(text).toContain("--replay");
    expect(text).toContain("--reasoning-effort <level>");
    expect(text).toContain("--fast-mode");
    expect(text).toContain("--no-fast-mode");
    expect(text).toContain("--timeout-ms <ms>");
    expect(text).toContain("--retry-max-attempts <n>");
    expect(text).toContain("--retry-initial-delay-ms <ms>");
    expect(text).toContain("--retry-max-delay-ms <ms>");
    expect(text).toContain("--retry-multiplier <n>");
    expect(text).toContain("--max-concurrency <n>");
    expect(text).toContain("Codex process: minimal, low, medium, high, xhigh");
    expect(text).toContain("Stored llm.provider=auto configuration accepts the shared low, medium, high, and xhigh values");
    expect(text).toContain("invocation overrides under auto validate against the actual resolved process provider");
    expect(text).toContain("overrides llm.reasoningEffort for this invocation without rewriting ~/.lcm/config.json");
    expect(text).toContain("override llm.fastMode for one auto or process-provider invocation");
    expect(text).toContain("lcm compact --reasoning-effort high");
    expect(text).toContain("lcm compact --timeout-ms 300000");
    expect(text).toContain("lcm compact --retry-max-attempts 4");
    expect(text).toContain("lcm compact --all --max-concurrency 4");
    expect(text).toContain("llm.maxConcurrency defaults to 1");
    expect(text).toContain("--replay clamps stored concurrency to 1");
    expect(text).toContain("SIGINT exits 130 and SIGTERM exits 143 only after local and daemon-owned work drains");
    expect(text).toContain("promotion remains sequential and deterministic");
    expect(text).toContain("--dry-run validates configuration and discovery without starting the daemon");
    expect(text).toContain("Retry flags remain OpenAI-compatible-only");
    expect(text).toContain("Examples:");
  });

  it("prints config command help with masking and restart guidance", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("config");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm config <get|set>");
    expect(text).toContain("--effective");
    expect(text).toContain("--json");
    expect(text).toContain("always masked");
    expect(text).toContain("custom and openai-compatible normalize to OpenAI and retain those settings");
    expect(text).toContain("lcm daemon restart");
  });

  it("prints the canonical durable-store tag set", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("store");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("--tag, --tags <tag>");
    expect(text).toContain("lcm store 'Auth uses JWT with 24h expiry' --tag 'type:solution' --tag 'scope:project' --tag 'project:lcm' --tag 'source:<actual-thread-uuid>'");
    expect(text).toContain("lcm store 'Use ensureDaemon before background promote' --tag 'type:solution' --tag 'scope:project' --tag 'project:lcm' --tag 'source:<actual-thread-uuid>'");
    expect(text).not.toContain('lcm store "Auth uses JWT with 24h expiry"');
    expect(text).not.toContain('lcm store "Use ensureDaemon before background promote"');
    expect(text).not.toContain("Store a plain-text memory");
    expect(text).not.toContain("scope:lcm");
  });

  it("prints daemon restart help", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("daemon");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("Usage: lcm daemon start [--detach] [--foreground]\n         lcm daemon restart");
    expect(text).not.toContain("lcm daemon <start|restart> [--detach] [--foreground]");
    expect(text).toContain("--detach      For daemon start:");
    expect(text).toContain("--foreground  For daemon start:");
    expect(text).not.toContain("lcm daemon restart [--detach]");
    expect(text).not.toContain("lcm daemon restart [--foreground]");
    expect(text).toContain("lcm daemon restart");
  });

  it("prints sensitive command help with purge warning", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("sensitive");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("IRREVERSIBLY");
    expect(text).toContain("--global");
  });

  it("routes unknown command to stderr + full help, not silent fallthrough", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("not-a-real-command");
    const errText = err.mock.calls.map(c => c[0]).join("");
    const outText = out.mock.calls.map(c => c[0]).join("");
    expect(errText).toContain("Unknown command: not-a-real-command");
    expect(outText).toContain("lcm — Long Context Manager for coding agents");
  });

  it("prints hook command help (restore)", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("restore");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm restore");
    expect(text).toContain("SessionStart");
  });

  it("prints hook command help (post-tool)", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("post-tool");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm post-tool");
    expect(text).toContain("PostToolUse");
  });

  it("prints mcp command help", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("mcp");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm mcp");
    expect(text).toContain("MCP server");
  });

  it("prints search command help", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("search");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm search");
    expect(text).toContain("--limit N");
    expect(text).toContain("--layer <name>");
    expect(text).toContain('lcm search "hook failure" --layer promoted --tag type:solution');
    expect(text).toContain("promoted entries");
  });

  it("prints the grep since timestamp contract", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("grep");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("YYYY-MM-DDTHH:mm:ss[.S{1,3}](Z|+/-HH:mm)");
    expect(text).toContain("normalized UTC year 0001-9999");
    expect(text).toContain("malformed or out-of-range values return HTTP 400");
    expect(text).toContain("Omit it to include all history");
  });

  it("prints doctor command help with sidecar scan limit", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("doctor");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm doctor");
    expect(text).toContain("--events-max-dbs <n|all|unlimited>");
    expect(text).toContain("lcm doctor --events-max-dbs all");
  });

  it("prints machine and project command help", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("machine");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm machine");
    expect(text).toContain("recover <machine-id>");
    expect(text).toContain("--force");

    out.mockClear();
    printHelp("project");
    const projectText = out.mock.calls.map(c => c[0]).join("");
    expect(projectText).toContain("lcm project");
    expect(projectText).toContain("link <project-id|local-target>");
    expect(projectText).toContain("show [path|local-hash|remote-project-id]");
    expect(projectText).toContain("lcm project show <remote-project-uuid>");
    expect(projectText).toContain("exactly one local binding");
    expect(projectText).toContain("--allow-existing-data");

    out.mockClear();
    printHelp("postgres");
    const postgresText = out.mock.calls.map(c => c[0]).join("");
    expect(postgresText).toContain("lcm postgres migrate [--json]");
    expect(postgresText).toContain("LCM_POSTGRES_URL");
    expect(postgresText).toContain("storage.postgresql.migrationRole");
    expect(postgresText).toContain("LCM_POSTGRES_MIGRATION_ROLE");
    expect(postgresText).toContain("does not install extensions or grant runtime privileges");
  });

  it("prints import command help with Codex provider flags", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("import");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("--provider <name>");
    expect(text).toContain("--codex");
    expect(text).toContain("Codex CLI sessions");
  });

  it("prints events command help with global promotion", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("events");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm events");
    expect(text).toContain("promote --all");
    expect(text).toContain("--json");
    expect(text).toContain("metadata-backed");
    expect(text).toContain("status");
    expect(text).toContain("validate");
    expect(text).toContain("quarantine");
    expect(text).toContain("replay <event-id>");
    expect(text).toContain("operator commands are staged");
  });

  it("prints connector help with global scope option", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("connectors");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("--global");
    expect(text).toContain("--transport cli|mcp");
    expect(text).not.toContain("--type");
    expect(text).toContain("CLI transport");
    expect(text).toContain("MCP transport");
    expect(text).toContain("Install the GitHub Copilot workspace skill for VS Code");
    expect(text).toContain("Install Codex into ~/.codex");
    expect(text).not.toContain("hooks, skill, and rules");
    expect(text).toContain("native hook + skill");
    expect(text).toContain("does not mutate MCP configuration");
  });
});
