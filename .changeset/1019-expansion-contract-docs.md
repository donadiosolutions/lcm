---
"@donadiosolutions/lcm": patch
---

Correct the documented `lcm_expand` contract so it matches the shipped tool.
The README configuration table and the agent-tool reference described a token
cap and full source content that the registered tool never provides: the daemon
expansion route passes no token cap and does not request raw source messages, so
a response carries no message content, a child summary longer than 200
characters appears as its first 200 characters followed by an ellipsis, and
expanding a leaf summary returns nothing. The
`LCM_MAX_EXPAND_TOKENS` entry now names the unregistered
`buildExpansionToolDefinition` helper it actually reaches, and the MCP tool
description no longer promises full source content. The `lcm expand` command
description and help text are corrected the same way, since that command posts
to the same daemon route and returns the same child-summary snippets.
