---
"@donadiosolutions/lcm": minor
---

Save Codex memory when a turn is interrupted or a session ends. The Codex hook
connector now also registers `Interrupt` and `SessionEnd` hooks that run
`lcm session-snapshot --client codex --terminal` within Codex's three second
limit. The command only hands the transcript to the already running, verified
daemon (it never starts or repairs one, compacts, or promotes), exits 0 with no
output, and records a short reason in the hook error log when it could not hand
the save over. The daemon accepts the request on the new authenticated
`POST /ingest/terminal` route, answers before any storage work, and ingests the
transcript after the hook has exited, combining closely spaced requests so the
newest tail is read once. Reinstall the connector and approve the two new hook
definitions in Codex to enable them.

