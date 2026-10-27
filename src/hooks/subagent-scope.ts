export interface HookSessionScope {
  /** LCM session key: the child thread id for a Codex subagent, otherwise the payload session id. */
  readonly sessionId?: string;
  /** Root thread id of the Codex agent tree. Set only for a subagent; never stored as the child's session. */
  readonly treeSessionId?: string;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly isSubagent: boolean;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolves the LCM session key for a hook payload.
 *
 * Codex reports `session_id` as the root thread of the whole agent tree and
 * `agent_id` as the child thread, so a child's conversation must be keyed by
 * `agent_id`. Only a Codex payload with a non-empty string `agent_id` is a
 * child; every other payload keeps its `session_id`.
 */
export function resolveHookSessionScope(input: Record<string, unknown>): HookSessionScope {
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  const agentId = input.client === "codex" ? nonEmptyString(input.agent_id) : undefined;
  if (agentId === undefined) return { sessionId, isSubagent: false };
  return {
    sessionId: agentId,
    treeSessionId: nonEmptyString(sessionId),
    agentId,
    agentType: nonEmptyString(input.agent_type),
    isSubagent: true,
  };
}

