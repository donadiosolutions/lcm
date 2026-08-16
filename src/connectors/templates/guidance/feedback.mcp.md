When recalled memory affects the work, store one feedback memory per used memory:

Use `source:<actual-thread-uuid>` with the real UUID when available; omit that source tag when unavailable.

- `lcm_store` with `text`: "memory-used feedback" and `tags`: ["type:feedback", "scope:project", "project:<repo>", "source:<actual-thread-uuid>", "signal:memory_used", "memory_id:<id>"]
