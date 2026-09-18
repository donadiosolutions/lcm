---
"@donadiosolutions/lcm": patch
---

Redact private paths that error sanitization previously left visible after a
nested public URL. A rooted successor is now redacted when the nested URL
carries brackets, such as an IPv6 authority or a bracketed path segment, and a
Windows drive root now arms the same handoff as a slash or backslash root.
Bound terminal fields also count supplementary CJK ideographs as two columns so
live-frame output keeps its promised width.
