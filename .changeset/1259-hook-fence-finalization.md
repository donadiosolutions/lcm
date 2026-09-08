---
"@donadiosolutions/lcm": patch
---

Preserve hook publication failures when final root validation and descriptor
cleanup succeed. Retain publication journal reasons and ordered evidence when
cleanup also fails, and classify combined missing-evidence, contention, or other
failures as unsafe storage. Keep PreCompact's initial unsafe-storage failures
observable through its existing error logger. Reclassified finalization failures
follow each hook's journal-error policy: some hooks throw, while best-effort
hooks continue returning exit code 0.
