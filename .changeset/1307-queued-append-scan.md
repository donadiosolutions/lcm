---
"@donadiosolutions/lcm": patch
---

Stop a queued local append from being forced to time out by a mutating
passive-learning sidecar scan. Orphan cleanup now enters the local append order
before it acquires publication consumer admission, so an append that started
first completes and stays durable instead of waiting on a lock the scan is
holding. The scan keeps one retained admission through its diagnostic snapshot,
real close, eligibility check, and prune, and that admission no longer grants
implicit append authority to nested tokenless appends, so an append started
during close cannot write between the snapshot and the prune decision.
Cancellation and the scan deadline are honored before the scan opens anything,
reporting the sidecar as skipped, while unrelated publication contention
remains a per-sidecar error that lets scanning continue.
