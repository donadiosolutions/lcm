---
"@donadiosolutions/lcm": patch
---

Check PostgreSQL pool connections that have been idle for one second or longer
with a bounded `SELECT 1` before reuse. A connection that died silently while
idle is now replaced within about two connection timeouts instead of holding the
request for the full query deadline.
