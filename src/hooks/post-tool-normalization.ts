import {
  extractPostToolEvents,
  type PostToolInput,
  type ToolOutcome,
} from "./extractors.js";

// "Bash" is the name current Codex emits for unified exec; the dotted names are
// legacy aliases kept for compatibility.
const CODEX_SHELL_TOOL_NAMES = new Set(["Bash", "functions.exec", "functions.exec_command"]);

export interface RawPostToolInput {
  readonly client?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  readonly tool_output?: unknown;
}

type StatusRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function statusFromRecord(record: StatusRecord): boolean | undefined {
  if (typeof record.isError === "boolean") return record.isError;
  if (typeof record.is_error === "boolean") return record.is_error;
  if (typeof record.exit_code === "number" && Number.isFinite(record.exit_code)) {
    return record.exit_code !== 0;
  }
  if (typeof record.exitCode === "number" && Number.isFinite(record.exitCode)) {
    return record.exitCode !== 0;
  }
  return undefined;
}

function shellOutcome(toolOutput: unknown, toolResponse: unknown): ToolOutcome {
  const outputStatus = isRecord(toolOutput) ? statusFromRecord(toolOutput) : undefined;
  const status = outputStatus ??
    (isRecord(toolResponse) ? statusFromRecord(toolResponse) : undefined);
  if (status === undefined) return "unknown";
  return status ? "failed" : "succeeded";
}

function mcpFlagOutcome(record: StatusRecord): ToolOutcome | undefined {
  const flag = record.isError !== undefined ? record.isError : record.is_error;
  if (flag === undefined) return undefined;
  if (typeof flag !== "boolean") return "unknown";
  return flag ? "failed" : "succeeded";
}

function mcpOutcome(toolOutput: unknown, toolResponse: unknown): ToolOutcome {
  const outputFlag = isRecord(toolOutput) ? mcpFlagOutcome(toolOutput) : undefined;
  if (outputFlag !== undefined) return outputFlag;
  if (!isRecord(toolResponse)) return "unknown";
  const responseFlag = mcpFlagOutcome(toolResponse);
  if (responseFlag !== undefined) return responseFlag;
  return Array.isArray(toolResponse.content) ? "succeeded" : "unknown";
}

function normalizeLegacyToolOutput(value: unknown): { isError?: boolean } | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.isError === "boolean" ? { isError: value.isError } : {};
}

function isNativeFeedbackLoop(command: string): boolean {
  return /^lcm\s+store(?:\s|$)/u.test(command.trim());
}

function normalizeNonNativeInput(input: RawPostToolInput): PostToolInput {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const normalized: PostToolInput = {
    tool_name: toolName,
    tool_input: normalizeToolInput(input.tool_input),
  };
  if (input.tool_response !== undefined) normalized.tool_response = input.tool_response;
  const toolOutput = normalizeLegacyToolOutput(input.tool_output);
  if (toolOutput !== undefined) normalized.tool_output = toolOutput;
  return normalized;
}

export function normalizePostToolInput(input: RawPostToolInput): PostToolInput {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (input.client === "codex" && toolName.startsWith("mcp__")) {
    return {
      tool_name: toolName,
      tool_input: {},
      tool_output: { outcome: mcpOutcome(input.tool_output, input.tool_response) },
    };
  }
  if (input.client !== "codex" || !CODEX_SHELL_TOOL_NAMES.has(toolName)) {
    return normalizeNonNativeInput(input);
  }

  const toolInput = normalizeToolInput(input.tool_input);
  const selectedCommand = typeof toolInput.command === "string"
    ? toolInput.command
    : typeof toolInput.cmd === "string"
      ? toolInput.cmd
      : "";

  if (selectedCommand.trim().length === 0 || isNativeFeedbackLoop(selectedCommand)) {
    return { tool_name: "Bash", tool_input: { command: "" } };
  }

  const normalized: PostToolInput = {
    tool_name: "Bash",
    tool_input: { command: selectedCommand },
  };
  normalized.tool_output = { outcome: shellOutcome(input.tool_output, input.tool_response) };
  return normalized;
}

export function codexPostToolFunctionalCoverage(): boolean {
  const fixtures = [
    {
      tool_name: "Bash",
      tool_input: { command: "git branch" },
      tool_response: "finished\n",
      expected: { type: "tool_outcome_unknown", data: "Bash outcome unknown: git branch" },
    },
    {
      tool_name: "functions.exec_command",
      tool_input: { cmd: "npm install probe" },
      tool_response: { exit_code: 0 },
      expected: { type: "env_install", data: "npm install probe" },
    },
  ] as const;

  return fixtures.every(({ expected, ...fixture }) => {
    const events = extractPostToolEvents(normalizePostToolInput({ client: "codex", ...fixture }));
    return events.length === 1 &&
      events[0]?.type === expected.type &&
      events[0]?.data === expected.data;
  });
}
