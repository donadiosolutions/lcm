---
"@donadiosolutions/lcm": patch
---

Classify bounded Codex process failures into safe usage, authentication,
unavailable-model, and invalid-request guidance while preserving the existing
compatibility fallback for unknown diagnostics. Usage and authentication
categories also recognize the loopback Responses gateway's upstream 429 and
401 statuses without exposing provider response details.
