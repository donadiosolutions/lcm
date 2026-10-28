---
"@donadiosolutions/lcm": patch
---

Make daemon `/search` and `/store` wait for a live publication-lock owner
instead of failing. PostgreSQL reads (`/search`, `/grep`, `/recent`,
`/describe`, `/expand`) now wait up to 4 seconds per request, covering both
the daemon's publication queue and a lock held by another process or by the
daemon's own concurrent work, before returning the retryable `503`. `/store`
waits up to 3 seconds for a live lock owner and then answers a retryable
`503` with `status: "busy"` instead of a `500`. The capture routes
(`/ingest`, `/restore`, `/promote-events`) also wait for the daemon's own
concurrent lock users.
