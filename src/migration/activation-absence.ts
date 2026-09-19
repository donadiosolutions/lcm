/**
 * Small, reusable primitives for attributing the absence of a nullable read.
 *
 * The governing rule, carried over from the frozen cross-item schema this
 * campaign has repeatedly been burned by violating: a conclusion requires
 * that something was compared, that the comparison ran, and that any
 * absence observed can be attributed to a known cause. The forbidden
 * conclusion is 'the value is NULL, therefore the thing it measures is
 * absent' -- a NULL (or a caught exception) can just as easily mean 'the
 * read was refused' as 'the read succeeded and found nothing'.
 *
 * This module follows the same three-valued convention already established
 * in activation-restart-check.ts: a successful read that found nothing
 * and a read that did not succeed are different answers, and the
 * attribution rides along on the result rather than being discarded.
 *
 * attributeNullableRead only ever resolves to "absent" or
 * "unresolvable" for a *recognized* failure signature. An error that the
 * caller's classifier does not recognize is not swallowed into either
 * bucket -- it propagates unchanged, so an unattributable absence refuses
 * to report any conclusion at all rather than guessing which one applies.
 */

/** One nullable read's outcome: it found something, found nothing for a
 * known reason, or could not be completed for a known reason. Never
 * collapse this to a boolean; the "absent" vs. "unresolvable" distinction
 * is the entire point of this module. */
export type NullableReadOutcome<T> = Readonly<
  | { readonly kind: "present"; readonly value: T }
  | { readonly kind: "absent"; readonly cause: string; readonly detail: string }
  | { readonly kind: "unresolvable"; readonly cause: string; readonly detail: string }
>;

/** Two-variant subset of NullableReadOutcome for a lookup that, by
 * construction, can never be "unresolvable" (see attributeNullableValue).
 * Every ValueOutcome is a valid NullableReadOutcome. */
export type ValueOutcome<T> = Readonly<
  | { readonly kind: "present"; readonly value: T }
  | { readonly kind: "absent"; readonly cause: string; readonly detail: string }
>;

/** A classifier's verdict for one caught error: a definite, attributed
 * absence ("absent") or a definite, attributed failure-to-look
 * ("unresolvable"). Returning undefined from the classifier itself (not
 * this type) means "I do not recognize this error"; see
 * NullableReadErrorClassifier. */
export type NullableReadClassification = Readonly<{
  kind: "absent" | "unresolvable";
  cause: string;
  detail: string;
}>;

/**
 * Classify a caught error into an attributed absence or an attributed
 * failure-to-look. Return undefined for any error the classifier does
 * not recognize; the caller of attributeNullableRead then rethrows
 * that error unchanged rather than reporting a false conclusion.
 */
export type NullableReadErrorClassifier = (error: unknown) => NullableReadClassification | undefined;

export type NullableReadOptions<T> = Readonly<{
  /**
   * Classify a thrown error. Defaults to classifyNodeFsAbsence's
   * default codes. An error the classifier does not recognize propagates
   * unchanged instead of being reported as either "absent" or
   * "unresolvable".
   */
  classifyError?: NullableReadErrorClassifier;
  /**
   * When read completes and returns exactly null, attribute that as an
   * absence with this cause and detail instead of treating null as a
   * present value. Omit to treat a returned null as a present value.
   */
  whenNull?: Readonly<{ cause: string; detail: string }>;
}>;

const DEFAULT_NOT_FOUND_CODES: readonly string[] = ["ENOENT", "ENOTDIR"];
const DEFAULT_PERMISSION_DENIED_CODES: readonly string[] = ["EACCES", "EPERM"];

/** Node's conventional "the target does not exist" error codes. */
export const NOT_FOUND_FS_CODES: readonly string[] = DEFAULT_NOT_FOUND_CODES;
/** Node's conventional "the target exists but access was denied" error codes. */
export const PERMISSION_DENIED_FS_CODES: readonly string[] = DEFAULT_PERMISSION_DENIED_CODES;

/**
 * Build a classifier for plain Node.js filesystem errors (the shape thrown
 * by fs.*Sync, including the bounded readers in security-files.ts).
 * A recognized not-found code attributes "absent"; a recognized
 * permission-denied code attributes "unresolvable" -- permission denial
 * means the read could not look, not that the target is absent. Any other
 * error code (or an error without a .code string) is left unrecognized so
 * it propagates instead of being silently folded into either bucket.
 */
export function classifyNodeFsAbsence(
  options: Readonly<{
    notFoundCodes?: readonly string[];
    permissionDeniedCodes?: readonly string[];
  }> = {},
): NullableReadErrorClassifier {
  const notFound = new Set(options.notFoundCodes ?? DEFAULT_NOT_FOUND_CODES);
  const permissionDenied = new Set(options.permissionDeniedCodes ?? DEFAULT_PERMISSION_DENIED_CODES);
  return (error: unknown): NullableReadClassification | undefined => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code !== "string") return undefined;
    if (notFound.has(code)) {
      return {
        kind: "absent",
        cause: "not-found",
        detail: `the read failed with ${code}: the target does not exist`,
      };
    }
    if (permissionDenied.has(code)) {
      return {
        kind: "unresolvable",
        cause: "permission-denied",
        detail: `the read failed with ${code}: permission was denied, so absence cannot be concluded`,
      };
    }
    return undefined;
  };
}

/**
 * Run read and attribute its outcome. A successful, non-null result is
 * "present". A successful null result is "absent" only when whenNull
 * is supplied (otherwise null is itself the present value). A thrown
 * error recognized by classifyError becomes its attributed "absent" or
 * "unresolvable" outcome. A thrown error classifyError does not
 * recognize propagates unchanged: this primitive never guesses.
 */
/**
 * When options.whenNull is supplied, the return type's "present" branch
 * excludes null (NonNullable<T>): a null read result is always reported
 * as "absent" in that overload, never as a present null value.
 */
export function attributeNullableRead<T>(
  read: () => T,
  options: NullableReadOptions<T> & Readonly<{ whenNull: Readonly<{ cause: string; detail: string }> }>,
): NullableReadOutcome<NonNullable<T>>;
export function attributeNullableRead<T>(
  read: () => T,
  options?: NullableReadOptions<T>,
): NullableReadOutcome<T>;
export function attributeNullableRead<T>(
  read: () => T,
  options: NullableReadOptions<T> = {},
): NullableReadOutcome<T> {
  const classify = options.classifyError ?? classifyNodeFsAbsence();
  let value: T;
  try {
    value = read();
  } catch (error) {
    const classified = classify(error);
    if (classified === undefined) throw error;
    return { kind: classified.kind, cause: classified.cause, detail: classified.detail };
  }
  if (options.whenNull !== undefined && value === null) {
    return { kind: "absent", cause: options.whenNull.cause, detail: options.whenNull.detail };
  }
  return { kind: "present", value };
}

/**
 * Attribute a plain value already in hand (no I/O, so no "unresolvable" is
 * possible here by construction): undefined/null becomes "absent"
 * with the supplied cause and detail, anything else is "present". Use this
 * for a lookup inside data a prior attributeNullableRead call
 * already brought into memory, such as finding one row in an already-read
 * roster -- any permission concern for the *container* was already
 * resolved (or refused) by that earlier read.
 */
export function attributeNullableValue<T>(
  value: T | null | undefined,
  whenAbsent: Readonly<{ cause: string; detail: string }>,
): ValueOutcome<T> {
  if (value === null || value === undefined) {
    return { kind: "absent", cause: whenAbsent.cause, detail: whenAbsent.detail };
  }
  return { kind: "present", value };
}

/**
 * Async twin of attributeNullableRead for a read that itself returns a
 * Promise (e.g. a network or database round trip such as a PostgreSQL
 * query). The classifier contract, the three outcomes, and the
 * never-guess rule for an unrecognized error are all identical to the
 * sync form above; only the mechanics of observing the outcome differ.
 *
 * This function is the single attribution boundary for an async read: it
 * awaits read() itself and classifies whatever it throws, in the same
 * try/catch. Resolving a promise first and classifying its rejection
 * afterward, outside this function, is not equivalent -- that pattern
 * either loses the rejection's original shape before a classifier ever
 * sees it, or forces the caller to hand-roll a second, separately
 * maintained catch that duplicates classifyError's job and will drift
 * from it over time. Every async nullable read in this codebase should
 * go through this one boundary rather than reimplementing it.
 */
export function attributeNullableReadAsync<T>(
  read: () => Promise<T>,
  options: NullableReadOptions<T> & Readonly<{ whenNull: Readonly<{ cause: string; detail: string }> }>,
): Promise<NullableReadOutcome<NonNullable<T>>>;
export function attributeNullableReadAsync<T>(
  read: () => Promise<T>,
  options?: NullableReadOptions<T>,
): Promise<NullableReadOutcome<T>>;
export async function attributeNullableReadAsync<T>(
  read: () => Promise<T>,
  options: NullableReadOptions<T> = {},
): Promise<NullableReadOutcome<T>> {
  const classify = options.classifyError ?? classifyNodeFsAbsence();
  let value: T;
  try {
    value = await read();
  } catch (error) {
    const classified = classify(error);
    if (classified === undefined) throw error;
    return { kind: classified.kind, cause: classified.cause, detail: classified.detail };
  }
  if (options.whenNull !== undefined && value === null) {
    return { kind: "absent", cause: options.whenNull.cause, detail: options.whenNull.detail };
  }
  return { kind: "present", value };
}
