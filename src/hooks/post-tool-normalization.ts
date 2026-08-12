import {
  extractPostToolEvents,
  type PostToolInput,
} from "./extractors.js";

const COMMAND_SOFT_CAP = 2000;
const NATIVE_TOOL_NAMES = new Set(["functions.exec", "functions.exec_command"]);

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

function normalizeStatus(toolOutput: unknown, toolResponse: unknown): { isError?: boolean } | undefined {
  const outputStatus = isRecord(toolOutput) ? statusFromRecord(toolOutput) : undefined;
  if (outputStatus !== undefined) return { isError: outputStatus };

  const responseStatus = isRecord(toolResponse) ? statusFromRecord(toolResponse) : undefined;
  return responseStatus === undefined ? undefined : { isError: responseStatus };
}

function normalizeLegacyToolOutput(value: unknown): { isError?: boolean } | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.isError === "boolean" ? { isError: value.isError } : {};
}

function boundCommand(command: string): string {
  return command.length > COMMAND_SOFT_CAP
    ? `${command.slice(0, COMMAND_SOFT_CAP)}...`
    : command;
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
  if (input.client !== "codex" || !NATIVE_TOOL_NAMES.has(toolName)) {
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
    tool_input: { command: boundCommand(selectedCommand) },
  };
  const status = normalizeStatus(input.tool_output, input.tool_response);
  if (status !== undefined) normalized.tool_output = status;
  return normalized;
}

export function codexPostToolFunctionalCoverage(): boolean {
  const fixtures = [
    {
      tool_name: "functions.exec",
      tool_input: { command: "git branch" },
      expected: "git_branch",
    },
    {
      tool_name: "functions.exec_command",
      tool_input: { cmd: "npm install probe" },
      expected: "env_install",
    },
  ] as const;

  return fixtures.every(({ expected, ...fixture }) => {
    const events = extractPostToolEvents(normalizePostToolInput({ client: "codex", ...fixture }));
    return events.length === 1 && events[0]?.type === expected;
  });
}
