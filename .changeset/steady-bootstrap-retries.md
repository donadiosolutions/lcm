---
"@donadiosolutions/lcm": patch
---

Retry short authenticated root-bootstrap contention once across CLI startup so read-only commands such as `lcm search` continue after a competing bootstrap completes, while ambiguous or unsafe lock states still fail closed.
