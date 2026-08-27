import { Buffer } from "node:buffer";
import { isAbortError } from "../cancellation.js";
import type { InvocationCoordinator, InvocationInput } from "../invocation-coordinator.js";
import { InvocationCoordinatorError } from "../invocation-coordinator.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";

const MAX_CONTROL_BODY_BYTES = 16 * 1024;
const ACTIONS = new Set(["start", "heartbeat", "cancel", "finish"]);
const REQUIRED_FIELDS = new Set(["action", "invocation_id", "command", "daemon_instance_id"]);

function controlError(message = "invalid invocation control request"): InvocationCoordinatorError {
  return new InvocationCoordinatorError("invalid-input", message, 400);
}

/**
 * Parse one bounded JSON object while retaining top-level duplicate-key
 * detection. JSON.parse alone silently keeps the last duplicate member.
 */
export function parseInvocationControlBody(body: string): Record<string, unknown> {
  if (Buffer.byteLength(body, "utf8") > MAX_CONTROL_BODY_BYTES) {
    throw Object.assign(new Error("payload too large"), { statusCode: 413 });
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw controlError();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw controlError();
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== REQUIRED_FIELDS.size || keys.some(key => !REQUIRED_FIELDS.has(key))) {
    throw controlError();
  }
  for (const key of ["action", "invocation_id", "command", "daemon_instance_id"]) {
    if (typeof input[key] !== "string" || (input[key] as string).length === 0) throw controlError();
  }
  if (!ACTIONS.has(input.action as string) || input.command !== "compact") throw controlError();

  // A small lexical pass catches duplicate top-level keys without accepting
  // duplicate names that JSON.parse has already collapsed. Nested values are
  // forbidden, so any top-level object member is enough for this contract.
  const duplicate = detectDuplicateTopLevelKeys(body);
  if (duplicate) throw controlError();
  return input;
}

function detectDuplicateTopLevelKeys(body: string): boolean {
  const seen = new Set<string>();
  const keyPattern = /"((?:\\.|[^"\\])*)"\s*:/gu;
  for (const match of body.matchAll(keyPattern)) {
    const key = JSON.parse(`"${match[1]}"`) as string;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function asTarget(input: Record<string, unknown>): InvocationInput {
  return {
    invocationId: input.invocation_id as string,
    command: input.command as "compact",
    daemonInstanceId: input.daemon_instance_id as string,
  };
}

/** Handle the fixed, authenticated invocation-control protocol. */
export function createInvocationControlHandler(coordinator: InvocationCoordinator): RouteHandler {
  return async (_req, res, body, context) => {
    try {
      const input = parseInvocationControlBody(body);
      const target = asTarget(input);
      const action = input.action as "start" | "heartbeat" | "cancel" | "finish";
      const result = action === "start"
        ? coordinator.start(target)
        : action === "heartbeat"
          ? coordinator.heartbeat(target)
          : action === "cancel"
            ? await coordinator.cancel(target, context?.signal)
            : await coordinator.finish(target, context?.signal);
      sendJson(res, 200, result);
    } catch (error) {
      if (isAbortError(error)) return;
      if (error instanceof InvocationCoordinatorError) {
        sendJson(res, error.statusCode, { error: "invalid invocation control request" });
        return;
      }
      const statusCode = (error as { statusCode?: number })?.statusCode;
      sendJson(res, statusCode === 413 ? 413 : 400, {
        error: statusCode === 413 ? "payload too large" : "invalid invocation control request",
      });
    }
  };
}

export { MAX_CONTROL_BODY_BYTES };
