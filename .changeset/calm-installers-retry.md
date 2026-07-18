---
"@donadiosolutions/lcm": patch
---

Make custom-server setup retry empty required values before safely falling back
to the native provider, and make installer health polling reject invalid
timeouts while using a bounded monotonic deadline.
