/**
 * Quote one argument for the platform's conventional interactive shell.
 *
 * POSIX shells use the close-quote, literal-apostrophe, reopen-quote form.
 * Windows guidance targets PowerShell, whose single-quoted literals escape an
 * apostrophe by doubling it. Callers should still add `--` before positional
 * arguments so a quoted leading dash is not interpreted as an option.
 */
export function quoteShellArgument(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const escaped = platform === "win32"
    ? value.replaceAll("'", "''")
    : value.replaceAll("'", "'\"'\"'");
  return `'${escaped}'`;
}
