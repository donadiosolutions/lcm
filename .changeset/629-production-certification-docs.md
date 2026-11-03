---
"@donadiosolutions/lcm": patch
---

Ship the production certification guide (`docs/production-certification.md`) in
the package, together with the first published local-lane result
(`docs/production-certification-gate.json` and `.md`). The guide explains how
to run the two-machine certification harness against a local PostgreSQL 18
container or a disposable DigitalOcean PostgreSQL 18 cluster, how the gate scores
the frozen workload and SLO contract, how to recover after an interrupted run, and
what the evidence does and does not claim. The published result is the local-lane
`full` run, which passed every SLO under contract v3. The managed lane has no
published result yet.
