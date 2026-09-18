---
"@donadiosolutions/lcm": patch
---

Correct error-message sanitization ownership so private paths stop leaking and
ordinary values stop being over-redacted. Sanitized errors now end pathless
file-query ownership at a URL-ending delimiter, keep relative successors after a
nested file URL, hand off after quoted and bracketed nested public URLs, accept a
Windows drive root as a handoff root, return from a nested file child on a pipe,
and own a sibling bracket group after a closed one. Bound terminal text also
counts supplementary CJK ideographs as two columns so live-frame output keeps its
promised width.
