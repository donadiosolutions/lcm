---
"@donadiosolutions/lcm": patch
---

Restore a minimal managed `~/.codex/AGENTS.md` memory-retrieval rule to the
default Codex CLI connector bundle while preserving the detailed `lcm-memory`
skill and native hooks. Existing user rules remain intact, explicit Codex MCP
bundles omit the CLI-only entry, and reinstalling remains byte-idempotent.
