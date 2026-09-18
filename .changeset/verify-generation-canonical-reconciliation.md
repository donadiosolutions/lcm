---
"@donadiosolutions/lcm": minor
---

Add migration verification with canonical reconciliation evidence for the
reversible SQLite-to-PostgreSQL cutover. A copied generation is now
independently re-verified against the immutable source snapshot and the live
destination inside a single fenced read-only window, producing a durable,
content-addressed report before any activation step may consider the
generation activation-eligible.

A clean report is the only report that ever begins a verify-generation
effect; a report with mismatches is persisted in full as operator evidence,
but requires explicit abort and a new generation rather than an in-place
retry. Reconciliation now includes a sequence self-consistency bound (an
identity sequence's last_value must be at or above the maximum identity
value present in its copied domain), and the step-5 public-read probe runs
through the real PostgreSQL repository path and is compared against the
source's own canonical ordering rather than being recorded and discarded.
