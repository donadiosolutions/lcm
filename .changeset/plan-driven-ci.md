---
"@donadiosolutions/lcm": patch
---

Restructure the GitHub Actions CI pipeline into a plan-driven job graph: pull requests and merge-queue entries run only the test files related to the change, pushes to `main`/`release` run the complete suite sharded across runners with the merged 100% coverage gate, and the PostgreSQL conformance harness runs once on an 8 vCPU runner with CPU-derived workers.
