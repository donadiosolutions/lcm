---
"@donadiosolutions/lcm": patch
---

Authenticate the immediate project metadata parent before promotion reads
`meta.json`, and retain that identity through bounded reading and atomic
publication so directory replacement fails closed.
