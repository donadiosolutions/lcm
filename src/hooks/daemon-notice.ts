import {
  clearDaemonRemediation,
  daemonScopeDigest,
  isDaemonRefusalReason,
  mapDaemonRefusalToRemediation,
  recordDaemonRemediation,
  type DaemonRemediationClearInput,
  type DaemonRemediationClearResult,
  type DaemonRemediationDecision,
  type DaemonRemediationInput,
  type DaemonRefusalReason,
} from "../daemon/remediation.js";

/** Hook output is injectable so tests never need to capture process stderr. */
export type DaemonNoticeWriter = (message: string) => void;

export type DaemonHookNoticeInput = DaemonRemediationInput & Readonly<{
  write?: DaemonNoticeWriter;
}>;

/** Unknown hook input is reduced to the safe, bounded ambiguous reason. */
export function sanitizeDaemonRefusalReason(value: unknown): DaemonRefusalReason {
  return isDaemonRefusalReason(value) ? value : "ambiguous";
}

/**
 * Format fixed guidance without touching the filesystem or process state.
 * The reason is normalized before interpolation, so paths, PIDs, and secrets
 * supplied by a malformed hook payload can never reach the user-facing text.
 */
export function formatDaemonNotice(reason: unknown): string {
  return mapDaemonRefusalToRemediation(sanitizeDaemonRefusalReason(reason)).message;
}

function unavailableDecision(
  input: DaemonHookNoticeInput,
): DaemonRemediationDecision {
  const reason = sanitizeDaemonRefusalReason(input.reason);
  return {
    emit: true,
    remediation: mapDaemonRefusalToRemediation(reason),
    markerStatus: "unavailable",
    markerIoError: true,
    scopeDigest: daemonScopeDigest(input.scope),
  };
}

/**
 * Emit a deduplicated hook notice.  Marker failures are deliberately treated
 * as an emission path: hooks must remain visible even when their optional
 * suppression state cannot be read or written.
 */
export function emitDaemonNotice(input: DaemonHookNoticeInput): DaemonRemediationDecision {
  const normalized: DaemonRemediationInput = {
    ...input,
    reason: sanitizeDaemonRefusalReason(input.reason),
  };
  let decision: DaemonRemediationDecision;
  try {
    decision = recordDaemonRemediation(normalized);
  } catch {
    decision = unavailableDecision(input);
  }

  if (!decision.emit) return decision;
  const write = input.write ?? ((message: string) => {
    process.stderr.write(message);
  });
  try {
    // Include exactly one newline at the output seam.  The pure remediation
    // message itself remains suitable for CLI/status JSON consumers.
    write(`${decision.remediation.message}\n`);
  } catch {
    // Hook processes must not fail because stderr is unavailable or closed.
  }
  return decision;
}

/** Alias used by hook call sites that prefer a predicate-style name. */
export const maybeEmitDaemonNotice = emitDaemonNotice;

/** Clear all refusal entries for a scope after healthy/safe recovery. */
export function clearDaemonNotice(
  input: DaemonRemediationClearInput,
): DaemonRemediationClearResult {
  try {
    return clearDaemonRemediation(input);
  } catch {
    return { cleared: false, markerIoError: true };
  }
}

/** More explicit alias for integrations that call the state a marker. */
export const clearDaemonNoticeMarker = clearDaemonNotice;
