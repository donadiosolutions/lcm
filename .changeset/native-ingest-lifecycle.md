---
"@donadiosolutions/lcm": patch
---

Keep native transcript parsing and archival on the same source snapshot, retry one concurrent source change, and drain active ingest work before closing storage on cancellation. Intentional cancellation returns HTTP 499 without recording an ingest error.

Prevent the retry from hiding a source or quarantine cleanup failure; retain both failures and return the existing sanitized ingest failure.

Keep transcript and scrubber preparation outside backend publication admission on every attempt. Drain and close each attempt before retrying, and revalidate publication state and project identity before further writes.
