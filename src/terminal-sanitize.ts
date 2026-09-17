/** Convert untrusted persisted text into one safe terminal display line. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function terminalCodePointWidth(value: string): number {
  if (/\p{Mark}/u.test(value)) return 0;
  const code = value.codePointAt(0) as number;
  return code >= 0x1100 && (
    code <= 0x115f
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
  ) ? 2 : 1;
}

const TERMINAL_CODE_POINTS_PER_COLUMN = 4;
const MAX_TERMINAL_CODE_POINTS = 4096;

/** Sanitize one field, then truncate it to a terminal-column budget. */
export function boundedTerminalText(value: string, maxWidth: number): string {
  if (!Number.isSafeInteger(maxWidth) || maxWidth < 1) {
    throw new RangeError("terminal text width must be a positive safe integer");
  }
  const safe = sanitizeTerminalText(value);
  const codePointBudget = Math.min(
    MAX_TERMINAL_CODE_POINTS,
    maxWidth * TERMINAL_CODE_POINTS_PER_COLUMN,
  );
  let width = 0;
  let codePoints = 0;
  let result = "";
  const truncated = (): string => {
    const target = Math.max(0, maxWidth - 1);
    while (width > target && result.length > 0) {
      const points = Array.from(result);
      const removed = points.pop()!;
      result = points.join("");
      width -= terminalCodePointWidth(removed);
    }
    return `${result}…`;
  };
  for (const codePoint of safe) {
    if (codePoints >= codePointBudget) return truncated();
    const nextWidth = terminalCodePointWidth(codePoint);
    if (width + nextWidth > maxWidth) return truncated();
    result += codePoint;
    width += nextWidth;
    codePoints += 1;
  }
  return result;
}
