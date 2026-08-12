---
"@donadiosolutions/lcm": patch
---

Retry short authenticated root-bootstrap contention during a bounded window across CLI startup—20 total attempts at 50 ms intervals, up to about 950 ms—so read-only commands such as `lcm search` continue after a competing bootstrap completes, while ambiguous or unsafe lock states still fail closed.
