---
"@donadiosolutions/lcm": patch
---

Reject non-object JSON request bodies for `lcm expand` with HTTP 400
(`invalid request body`) before project admission. Literal `null`, arrays, and
other JSON primitives now share that stable shape error; malformed JSON syntax
keeps its existing server error behavior.
