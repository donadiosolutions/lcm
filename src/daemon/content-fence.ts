/**
 * Wraps content in XML-like fence tags with basic sanitization to reduce
 * prompt injection surface when re-injecting summaries into conversations.
 *
 * Not a silver bullet — defense in depth alongside auth + scrubbing.
 */
export function fenceContent(content: string, tag: string): string {
  // Strip ANSI escape sequences
  let sanitized = content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  // Escape any closing tags that match our fence tag
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  sanitized = sanitized.replace(
    new RegExp(`</${escapedTag}\\s*>`, "gi"),
    `&lt;/${tag}&gt;`,
  );
  return `<${tag}>\n${sanitized}\n</${tag}>`;
}
