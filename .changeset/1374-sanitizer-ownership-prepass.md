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
in the same group.

Sanitizing an error message twice now gives the same result for a nested file
URL whose path is followed by a delimiter and a private root, because ownership
no longer reads a `<path>` marker from an earlier pass as evidence about the
child that produced it.
