/** Remove URL userinfo, query values, and fragments before diagnostic display. */
export function sanitizeUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[REDACTED]";
    if (url.username || url.password) {
      url.username = "[REDACTED]";
      url.password = "";
    }
    if (url.search) url.search = "?[REDACTED]";
    if (url.hash) url.hash = "#[REDACTED]";
    return url.toString();
  } catch {
    return "[REDACTED]";
  }
}
