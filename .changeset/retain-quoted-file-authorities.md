---
"@donadiosolutions/lcm": patch
---

Redact private paths after ambiguous apostrophes in single-quoted `file://`
authorities, including separately quoted nested file URLs whose paths contain
spaces. Close quoted file paths inside brackets so later standalone paths are
also redacted on the first pass, including backslash paths immediately after
the closing quote in an unmatched bracket or after a root-only quoted path.
Redact backslash paths in an exact file URL's own query or fragment while that
file-URL context remains active.
