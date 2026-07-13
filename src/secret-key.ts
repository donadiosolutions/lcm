/** Keys whose values must never be emitted in diagnostic or configuration output. */
export const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|authorization|token|secret|password|credential|cookie|set-cookie|private[-_]?key|bearer)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
