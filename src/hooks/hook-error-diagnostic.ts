import { sanitizeError } from "../daemon/safe-error.js";
import { ScrubEngine } from "../scrub.js";
import { sanitizeTerminalText } from "../terminal-sanitize.js";
import { sanitizeEmbeddedUrlValuesForDisplay } from "../url-display.js";

export const MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH = 1_000;

let credentialScrubber: ScrubEngine | undefined;

function scrubCredentials(value: string): string {
  credentialScrubber ??= new ScrubEngine([], []);
  return credentialScrubber.scrub(value);
}

/** Produce one bounded, terminal-safe, credential-free hook diagnostic. */
export function sanitizeHookErrorDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalText(
    sanitizeError(scrubCredentials(sanitizeEmbeddedUrlValuesForDisplay(raw))),
  ).slice(0, MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH);
}
