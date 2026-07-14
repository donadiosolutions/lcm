import { describe, it, expect, vi, afterEach } from "vitest";
import { printHelp } from "../src/cli-help.js";

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
    expect(text).toContain("--timeout-ms <ms>");
    expect(text).toContain("--retry-max-attempts <n>");
    expect(text).toContain("--retry-initial-delay-ms <ms>");
    expect(text).toContain("--retry-max-delay-ms <ms>");
    expect(text).toContain("--retry-multiplier <n>");
    expect(text).toContain("none, minimal, low, medium, high, or xhigh");
    expect(text).toContain("overrides llm.reasoningEffort for this invocation without rewriting ~/.lcm/config.json");
    expect(text).toContain("llm.provider=openai with llm.apiMode=responses");
    expect(text).toContain("lcm compact --reasoning-effort high");
    expect(text).toContain("lcm compact --timeout-ms 120000 --retry-max-attempts 4");
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
  });

  it("prints doctor command help with sidecar scan limit", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("doctor");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm doctor");
    expect(text).toContain("--events-max-dbs <n|all|unlimited>");
    expect(text).toContain("lcm doctor --events-max-dbs all");
  });

  it("prints map command help", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("map");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm map");
    expect(text).toContain("add <alias>");
    expect(text).toContain("--canonical");
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
  });

  it("prints connector help with global scope option", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("connectors");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("--global");
    expect(text).toContain("Install the GitHub Copilot workspace skill for VS Code");
    expect(text).toContain("Install Codex into ~/.codex");
  });
});
