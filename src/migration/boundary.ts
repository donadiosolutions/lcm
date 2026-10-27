/**
 * The migration commands' single boundary catch (round-1 B-4, plan section
 * 10). Every classified failure inside an orchestration function is already
 * returned as a closed refusal; this catches only what nothing classified,
 * so that an unknown throw becomes the closed `unexpected-failure` refusal
 * (exit 5) and the command still prints exactly one envelope under
 * `--json`, instead of escaping as an uncaught exception with a stack on
 * stderr and nothing on stdout.
 *
 * The only thing taken from the thrown value is its `name`, and only when
 * it is a plain identifier: a message, a path or a driver string never
 * reaches the evidence.
 */

/** The closed reason an unclassified throw is reported as. */
export const MIGRATION_UNEXPECTED_FAILURE_REASON = "unexpected-failure";

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

export function unexpectedFailureEvidence(error: unknown): string {
  if (error instanceof Error && IDENTIFIER_PATTERN.test(error.name)) return error.name;
  return "UnknownError";
}

export async function withMigrationBoundary<T>(
  run: () => Promise<T>,
  failed: (evidence: string) => T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    return failed(unexpectedFailureEvidence(error));
  }
}
