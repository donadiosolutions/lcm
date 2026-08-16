---
"@donadiosolutions/lcm": major
---

Replace component-oriented connector installation with one complete transport
bundle per agent. The former `--type` option is removed; use
`lcm connectors install <agent> --transport cli|mcp` and remove a whole bundle
with `lcm connectors remove <agent>`. Explicit transport choices take
precedence over stored `connectors.transports.<agent-id>` choices and registry
defaults, while implicit defaults are not persisted.

Claude Code, Qwen Code, and Zed default to MCP. Codex and every other agent
default to CLI. Cline and Augment are CLI-only until verifiable MCP adapters
exist. Codex's default CLI bundle is hook+skill and does not inspect MCP;
explicit MCP uses native `codex mcp` commands. Guidance is transport-pure, and
transport migration removes only exact LCM-owned MCP state where applicable.

Migration examples:

```bash
lcm connectors install codex --transport cli
lcm connectors install codex --transport mcp
lcm connectors remove codex
```
