---
"@donadiosolutions/lcm": patch
---

Make the staged PostgreSQL conformance harness validate its complete run identity before database mutation, require every exposed project repository adapter to register a backend-neutral contract suite, raise nested signal-probe readiness from 30 to 90 seconds with the bounded `LCM_TEST_POSTGRES_SIGNAL_READY_TIMEOUT_MS` override, register signal runs before readiness, exhaustively audit every registered run and Docker resource class, converge transient whole-run cleanup failures before signal exit, retain bounded sanitized cleanup diagnostics, remove verified private directories after orphan reclamation, fail signal tests when Docker cleanup does not complete, and tolerate an exactly owned Docker resource disappearing during concurrent orphan recovery.
