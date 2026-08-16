When recalled memory affects the work, store one feedback memory per used memory:

Use `source:<actual-thread-uuid>` with the real UUID when available; omit that source tag when unavailable.

- `lcm store 'memory-used feedback' --tag 'type:feedback' --tag 'scope:project' --tag 'project:<repo>' --tag 'source:<actual-thread-uuid>' --tag 'signal:memory_used' --tag 'memory_id:<id>'`
