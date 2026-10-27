---
"@donadiosolutions/lcm": patch
---

`lcm compact` discovery now yields to the event loop between projects,
conversations, message pages, and source-locator lookups, so the invocation
lease heartbeat keeps running during a long scan and Ctrl+C or `SIGTERM` stops
discovery before the next project or conversation instead of after the whole
scan. An interrupted scan closes the storage it opened, records no failure for
the interrupted project, and sends no compact request. Requests to the local
daemon also use a fresh loopback connection each time, so a connection the
daemon closed at its keep-alive timeout can no longer fail with `write EPIPE`.
