---
"@donadiosolutions/lcm": patch
---

Reject FIFO and other special-file transcript paths without blocking the
daemon. Native ingest and the pathname transcript readers used by compaction
now open the file non-blocking and check that it is a regular file before
reading, so a FIFO with no writer returns the empty-input result instead of
hanging the request.
