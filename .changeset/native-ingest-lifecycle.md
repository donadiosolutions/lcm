---
"@donadiosolutions/lcm": patch
---

Keep native transcript parsing and archival on the same source snapshot, retry one concurrent source change, and drain active ingest work before closing storage on cancellation. Intentional cancellation returns HTTP 499 without recording an ingest error.
