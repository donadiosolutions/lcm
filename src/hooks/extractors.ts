// src/hooks/extractors.ts

export interface ExtractedEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  tags?: string[];
}

export type ToolOutcome = "succeeded" | "failed" | "unknown";

export interface PostToolInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  // `outcome` is the only status signal when present; `isError` applies to
  // outcome-less (non-Codex) input.
  tool_output?: { isError?: boolean; outcome?: ToolOutcome };
}

const SENSITIVE_PATHS = [".env", ".ssh/", "credentials", "secrets/", ".npmrc", ".netrc"];
export const MAX_SCRUB_INPUT = 8_192;

const NEGATIVE_PATTERNS = [
  "don't worry", "dont worry",
  "never mind", "nevermind",
  "not sure", "no idea",
  "doesn't matter", "doesnt matter", "does not matter",
  "forget about", "forget it",
  "no preference", "whatever you think",
  "up to you",
];

const ENV_COMMANDS = ["npm install", "npm i ", "yarn add", "pip install", "pip3 install",
  "nvm use", "volta install", "pnpm add", "uv pip install", "brew install"];

const GIT_COMMANDS = ["git commit", "git merge", "git rebase", "git checkout", "git switch",
  "git branch", "git push", "git pull", "git stash", "git reset", "git cherry-pick"];

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  return SENSITIVE_PATHS.some(p => lower.includes(p));
}

function classifyFile(path: string): string {
  if (/\.(test|spec)\.[tj]sx?$/.test(path) || path.includes("__tests__")) return "test";
  if (/\.(json|ya?ml|toml|ini|env)$/.test(path) || path.includes("config")) return "config";
  if (/\.(md|txt|rst)$/.test(path) || path.includes("docs/")) return "docs";
  return "source";
}

function extractBashEvents(input: PostToolInput): ExtractedEvent[] {
  const command = String(input.tool_input.command ?? "");
  // Keep the command complete through selection and scrubbing. An oversized
  // command is not safe to parse or retain as a partial event.
  if (command.length > MAX_SCRUB_INPUT) return [];
  const outcome = input.tool_output?.outcome;
  const isError = outcome === undefined
    ? input.tool_output?.isError === true
    : outcome === "failed";

  // Error detection (priority 1)
  if (isError) {
    const selector = GIT_COMMANDS.find(gc => command.startsWith(gc)) ??
      ENV_COMMANDS.find(ec => command.startsWith(ec));
    return [{ type: "error_tool", category: "error", data: `Bash error: ${selector?.trim() ?? "command"}`, priority: 1 }];
  }

  // Completed without a status: record that the result is unknown instead of
  // presenting the command as a success.
  if (outcome === "unknown") {
    // Only the matched selector is recorded, never further command tokens.
    const selector = GIT_COMMANDS.find(gc => command.startsWith(gc)) ??
      ENV_COMMANDS.find(ec => command.startsWith(ec));
    return selector === undefined
      ? []
      : [{
        type: "tool_outcome_unknown",
        category: "tool",
        data: `Bash outcome unknown: ${selector.trim()}`,
        priority: 3,
      }];
  }

  // Git operations (priority 2)
  const gitMatch = GIT_COMMANDS.find(gc => command.startsWith(gc));
  if (gitMatch) {
    const commitMsgMatch = command.match(/-m\s+["']([^"']+)["']/);
    const data = commitMsgMatch
      ? `${gitMatch}: ${commitMsgMatch[1]}`
      : gitMatch;
    return [{ type: `git_${gitMatch.split(" ")[1]}`, category: "git", data, priority: 2 }];
  }

  // Env commands (priority 2)
  const envMatch = ENV_COMMANDS.find(ec => command.startsWith(ec));
  if (envMatch) {
    return [{ type: "env_install", category: "env", data: command, priority: 2 }];
  }

  return [];
}

function extractFileEvents(toolName: string, input: PostToolInput): ExtractedEvent[] {
  const filePath = String(
    input.tool_input.file_path ?? input.tool_input.path ?? input.tool_input.pattern ?? ""
  );
  if (!filePath || isSensitivePath(filePath)) return [];

  const typeMap: Record<string, string> = {
    Read: "file_read", Edit: "file_edit", Write: "file_write",
    Glob: "file_glob", Grep: "file_grep",
  };

  return [{
    type: typeMap[toolName],
    category: "file",
    data: `${filePath} (${classifyFile(filePath)})`,
    priority: 3,
  }];
}

const PATCH_EVENT_CAP = 20;
const USER_INPUT_QUESTION_CAP = 3;
const PLAN_STEP_CAP = 10;
const PATCH_HEADERS: readonly (readonly [string, string])[] = [
  ["*** Add File: ", "file_write"],
  ["*** Delete File: ", "file_delete"],
  ["*** Update File: ", "file_edit"],
];
const PATCH_MOVE_HEADER = "*** Move to: ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

// Native Codex responses are normally a JSON string; accept an object as well.
function parseResponse(response: unknown): Record<string, unknown> {
  if (typeof response !== "string") return isRecord(response) ? response : {};
  try {
    const parsed: unknown = JSON.parse(response);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// A present outcome is authoritative; otherwise the legacy isError flag decides.
function isFailedCall(input: PostToolInput): boolean {
  const outcome = input.tool_output?.outcome;
  return outcome === undefined ? input.tool_output?.isError === true : outcome === "failed";
}

interface PatchOperation {
  type: string;
  path: string;
  to?: string;
}

// Mirrors the Codex apply_patch header states: lines inside an Update section keep
// leading whitespace (it marks hunk context), other states trim both sides.
function parsePatchOperations(patch: string): PatchOperation[] {
  const operations: PatchOperation[] = [];
  let updating = false;
  let movable: PatchOperation | undefined;
  for (const raw of patch.split(/\r?\n/)) {
    const line: string = updating ? raw.trimEnd() : raw.trim();
    const header: readonly [string, string] | undefined = PATCH_HEADERS.find(([prefix]) => line.startsWith(prefix));
    if (header) {
      const operation = { type: header[1], path: line.slice(header[0].length).trim() };
      operations.push(operation);
      updating = header[1] === "file_edit";
      movable = updating ? operation : undefined;
    } else if (movable && line.startsWith(PATCH_MOVE_HEADER)) {
      movable.to = line.slice(PATCH_MOVE_HEADER.length).trim();
      movable = undefined;
    } else {
      movable = undefined;
    }
  }
  return operations;
}

function extractPatchEvents(input: PostToolInput): ExtractedEvent[] {
  const { command } = input.tool_input;
  if (typeof command !== "string") return [];
  const events = new Map<string, ExtractedEvent>();
  for (const { type, path, to } of parsePatchOperations(command)) {
    if (isSensitivePath(path) || (to && isSensitivePath(to))) continue;
    const label = to ? `${path} -> ${to} (${classifyFile(to)})` : `${path} (${classifyFile(path)})`;
    events.set(`${type}\0${label}`, { type, category: "file", data: label, priority: 3 });
  }
  return [...events.values()].slice(0, PATCH_EVENT_CAP);
}

function extractSpawnEvents(input: PostToolInput): ExtractedEvent[] {
  const response = parseResponse(input.tool_response);
  const label = [response.task_name, response.nickname, input.tool_input.task_name, input.tool_input.agent_type]
    .map(nonEmptyString)
    .find(Boolean) ?? "agent";
  return [{
    type: "subagent_dispatch",
    category: "subagent",
    data: label,
    priority: 3,
  }];
}

function extractUserInputEvents(input: PostToolInput): ExtractedEvent[] {
  const { questions } = input.tool_input;
  const answers = parseResponse(input.tool_response).answers;
  if (!Array.isArray(questions) || !isRecord(answers)) return [];
  const seen = new Set<string>();
  const events: ExtractedEvent[] = [];
  for (const entry of questions.slice(0, USER_INPUT_QUESTION_CAP)) {
    if (!isRecord(entry) || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const question = nonEmptyString(entry.question);
    const answer = answers[entry.id];
    const given = isRecord(answer) && Array.isArray(answer.answers) ? answer.answers : [];
    const text = given
      .filter((item): item is string => typeof item === "string")
      .map(item => item.replace(/^user_note:/, ""))
      .filter(item => item.trim().length > 0)
      .join("; ");
    if (!question || entry.isSecret === true || !text) continue;
    events.push({ type: "decision", category: "decision", data: `Q: ${question}\nA: ${text}`, priority: 1 });
  }
  return events;
}

// Only an explained plan revision is meaningful; unexplained updates are progress ticks.
function extractPlanEvents(input: PostToolInput): ExtractedEvent[] {
  const explanation = nonEmptyString(input.tool_input.explanation);
  if (!explanation) return [];
  const { plan } = input.tool_input;
  const steps = (Array.isArray(plan) ? plan : [])
    .map(item => (isRecord(item) ? nonEmptyString(item.step) : ""))
    .filter(Boolean)
    .slice(0, PLAN_STEP_CAP);
  const stepLine = steps.length > 0 ? `\nSteps: ${steps.join("; ")}` : "";
  return [{
    type: "plan_update",
    category: "proposal",
    data: `Plan: ${explanation}${stepLine}`,
    priority: 3,
  }];
}

// Native Codex tools run PostToolUse only after success. V2 spawns dispatch as the
// flattened "collaborationspawn_agent"; every other collaboration tool stays uncaptured.
function extractNativeActivityEvents(input: PostToolInput): ExtractedEvent[] | undefined {
  switch (input.tool_name) {
    case "apply_patch": return extractPatchEvents(input);
    case "spawn_agent":
    case "collaborationspawn_agent": return extractSpawnEvents(input);
    case "request_user_input": return extractUserInputEvents(input);
    case "update_plan": return extractPlanEvents(input);
    default: return undefined;
  }
}

export function extractPostToolEvents(input: PostToolInput): ExtractedEvent[] {
  const { tool_name } = input;

  // Skip lcm_store to prevent feedback loops
  if (tool_name.includes("lcm_store") || tool_name.includes("lcm__lcm_store")) return [];

  // AskUserQuestion — extract Q+A pair (priority 1)
  if (tool_name === "AskUserQuestion") {
    const question = String(input.tool_input.question ?? "");
    const answer = String(input.tool_response ?? "");
    return [{
      type: "decision",
      category: "decision",
      data: `Q: ${question}\nA: ${answer}`,
      priority: 1,
    }];
  }

  // Plan mode (priority 1)
  if (tool_name === "EnterPlanMode") {
    return [{ type: "plan_enter", category: "plan", data: "Entered plan mode", priority: 1 }];
  }
  if (tool_name === "ExitPlanMode") {
    const response = String(input.tool_response ?? "");
    const status = /approve/i.test(response) ? "approved" : /reject/i.test(response) ? "rejected" : "exited";
    return [{ type: "plan_exit", category: "plan", data: `Plan ${status}`, priority: 1 }];
  }

  // Bash — multiple categories
  if (tool_name === "Bash") {
    return extractBashEvents(input);
  }

  // File operations (priority 3)
  if (["Read", "Edit", "Write", "Glob", "Grep"].includes(tool_name)) {
    return extractFileEvents(tool_name, input);
  }

  // Task operations (priority 2)
  if (tool_name === "TaskCreate" || tool_name === "TaskUpdate") {
    const subject = String(input.tool_input.subject ?? input.tool_input.taskId ?? "");
    const status = String(input.tool_input.status ?? "created");
    return [{
      type: `task_${tool_name === "TaskCreate" ? "create" : "update"}`,
      category: "task",
      data: `${subject} → ${status}`,
      priority: 2,
    }];
  }

  // Agent/subagent (priority 3)
  if (tool_name === "Agent") {
    const desc = String(input.tool_input.description ?? "");
    return [{ type: "subagent_dispatch", category: "subagent", data: desc, priority: 3 }];
  }

  // Skill (priority 3)
  if (tool_name === "Skill") {
    const skill = String(input.tool_input.skill ?? "");
    return [{ type: "skill_use", category: "skill", data: skill, priority: 3 }];
  }

  // MCP tools (priority 3) — tool name only, no args
  if (tool_name.startsWith("mcp__")) {
    const outcome = input.tool_output?.outcome;
    if (outcome === "failed") {
      return [{ type: "error_tool", category: "error", data: `${tool_name} error`, priority: 1 }];
    }
    if (outcome === "unknown") {
      return [{
        type: "tool_outcome_unknown",
        category: "tool",
        data: `${tool_name} outcome unknown`,
        priority: 3,
      }];
    }
    return [{ type: "mcp_call", category: "mcp", data: tool_name, priority: 3 }];
  }

  // Native Codex activity (a failed call falls through to the generic error below)
  if (!isFailedCall(input)) {
    const native = extractNativeActivityEvents(input);
    if (native) return native;
  }

  // Any other tool with isError flag
  if (input.tool_output?.isError === true) {
    return [{
      type: "error_tool",
      category: "error",
      data: `${tool_name} error`,
      priority: 1,
    }];
  }

  return [];
}

// Extract text content from <channel> XML tags, or return prompt as-is
export function normalizePromptWithChannels(prompt: string): { text: string; fromChannel: boolean } {
  const parts: string[] = [];
  let cursor = 0;
  let fromChannel = false;
  while (cursor < prompt.length) {
    const open = prompt.indexOf("<channel", cursor);
    if (open < 0) {
      parts.push(prompt.slice(cursor));
      break;
    }
    const nameEnd = open + "<channel".length;
    const next = prompt[nameEnd];
    if (next !== undefined && next !== ">" && !/\s/u.test(next)) {
      parts.push(prompt.slice(cursor, nameEnd));
      cursor = nameEnd;
      continue;
    }
    const openEnd = prompt.indexOf(">", open + 8);
    if (openEnd < 0) {
      parts.push(prompt.slice(cursor));
      break;
    }
    const close = prompt.indexOf("</channel>", openEnd + 1);
    if (close < 0) {
      parts.push(prompt.slice(cursor));
      break;
    }
    parts.push(prompt.slice(cursor, open), prompt.slice(openEnd + 1, close));
    cursor = close + "</channel>".length;
    fromChannel = true;
  }
  return { text: parts.join(""), fromChannel };
}

export function extractUserPromptEvents(prompt: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];
  if (prompt.length > MAX_SCRUB_INPUT) return events;

  // Strip <channel> XML tags before running extractors
  const { text: normalizedPrompt, fromChannel } = normalizePromptWithChannels(prompt);

  const lower = normalizedPrompt.toLowerCase();

  const channelTags = fromChannel ? ["source:telegram"] : undefined;

  // Decision extraction with negative-match guards
  const hasNegative = NEGATIVE_PATTERNS.some(np => lower.includes(np));
  if (!hasNegative) {
    const decisionPatterns = [
      /\b(don'?t|never|always|prefer|use .+ instead)\b/i,
    ];
    for (const pattern of decisionPatterns) {
      if (pattern.test(normalizedPrompt)) {
        const event: ExtractedEvent = {
          type: "user_decision",
          category: "decision",
          data: normalizedPrompt,
          priority: 1,
        };
        if (channelTags) event.tags = channelTags;
        events.push(event);
        break;
      }
    }
  }

  // Role extraction
  const rolePatterns = [
    /\b(i'?m a|act as|i am a|as a|my role)\b/i,
    /\b(senior|junior|staff|lead|principal)\s+(engineer|developer|scientist|designer)\b/i,
  ];
  for (const pattern of rolePatterns) {
    if (pattern.test(normalizedPrompt)) {
      const event: ExtractedEvent = {
        type: "user_role",
        category: "role",
        data: normalizedPrompt,
        priority: 2,
      };
      if (channelTags) event.tags = channelTags;
      events.push(event);
      break;
    }
  }

  // Intent extraction
  const intentMap: [RegExp, string][] = [
    [/\b(why|explain|debug|investigate|understand)\b/i, "investigate"],
    [/\b(create|fix|build|implement|add|write)\b/i, "implement"],
    [/\b(review|check|verify|test|validate)\b/i, "review"],
    [/\b(refactor|clean|simplify|optimize)\b/i, "refactor"],
  ];
  for (const [pattern, intent] of intentMap) {
    if (pattern.test(normalizedPrompt)) {
      const event: ExtractedEvent = {
        type: `intent_${intent}`,
        category: "intent",
        data: intent,
        priority: 3,
      };
      if (channelTags) event.tags = channelTags;
      events.push(event);
      break;
    }
  }

  return events;
}
