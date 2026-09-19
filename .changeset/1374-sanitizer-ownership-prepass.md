---
"@donadiosolutions/lcm": patch
---

Classify sanitizer path ownership in a pre-pass so error messages stop leaking
private paths after wrapper closes, quoted public URLs and repeated delimiters,
and stop over-redacting ordinary named values and relative successors.

A quote around a URL now bounds every nested file path inside it, including one
that follows a space, so a second nested file URL no longer leaks the tail of a
path containing spaces. A nested file child in its own brackets now returns path
ownership to the wrapper that contains it, so bracketing a child no longer
leaves its private-root successor visible. URL syntax owns only the text that
follows it, so a trailing URL no longer redacts an earlier named Windows value
in the same group. A trailing file URL is directional the same way: it owns a
named value written after it, but never reaches back over one written before
it.

Sanitizing an error message twice now gives the same result for a nested file
URL whose path is followed by a delimiter and a private root, because ownership
no longer reads a `<path>` marker from an earlier pass as evidence about the
child that produced it.

A URL in a still-open ancestor group owns the values after it in that span, so
nested values such as `[https://x|[name=...]]` redact exactly like their
single-wrapper twins. A one-character scheme counts only with the two-slash
authority marker: `a://host` is recognized as URL syntax, so a private value
written after one is redacted instead of being left in clear, while a Windows
drive root and a zero-slash form such as `a:public` are still not. A named
Windows value after a nested file path is redacted on the first pass, so
forwarding an already sanitized message no longer changes its bytes. Bracketed
prose whose only
URL-shaped character is a question mark keeps its named Windows value, and a
quote around a URL stops bridging whitespace after a single gap.
