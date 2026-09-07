---
"@donadiosolutions/lcm": patch
---

Redact private paths after ambiguous apostrophes in single-quoted `file://`
authorities, including separately quoted nested file URLs whose paths contain
spaces. Close quoted file paths inside brackets so later standalone paths are
also redacted on the first pass, including root-relative Windows paths in a
following query or fragment. Also redact backslash paths in an unquoted file
URL's own query or fragment after its outer path, while that file-URL context
remains active.
