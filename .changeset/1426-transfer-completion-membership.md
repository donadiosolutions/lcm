---
"@donadiosolutions/lcm": patch
---

Refuse to complete a PostgreSQL migration copy whose destination gained
canonical rows after verification. Completion now holds the project
publication fence while comparing, per non-identity domain, the live
canonical row count against the run transfer ledger tally, so a row
canonical row count against the run transfer-ledger tally, so a row
canonical row count against the run transfer-ledger tally for that domain, so a row
committed by another writer between the verification stream and the
completion transaction refuses as destination-unexpected-rows instead of
completing silently. A deficit against the ledger still refuses as
verification-failed. Identity domains stay outside the tally: their ledger
rows are admission-time lookups rather than writes, and machines are
project-linked rather than project-owned. This lands the same fence PR
#1422 takes, so the two PRs must sequence so only one acquisition survives
the merge; #1422 was still open when this was written.
