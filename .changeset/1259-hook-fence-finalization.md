---
"@donadiosolutions/lcm": patch
---

Preserve hook publication failures when final root validation and descriptor
cleanup succeed. Retain publication journal reasons and ordered evidence when
cleanup also fails, and classify combined missing-evidence, contention, or other
failures as unsafe storage without changing each hook's exit-code handling.
