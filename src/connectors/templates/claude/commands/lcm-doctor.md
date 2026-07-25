---
name: lcm-doctor
description: Run Long Context Manager (LCM) diagnostics — checks daemon, hooks, MCP server, and summarizer health.
user_invocable: true
---

# /lcm-doctor

Run diagnostics on the Long Context Manager (LCM) installation.

## Instructions

When invoked, call the `lcm_doctor` MCP tool (no arguments).

The tool returns pre-formatted markdown with status tables per section. Display the output verbatim — it is already formatted correctly.

If any check shows a failure icon, add a **Fix** section listing specific remediation steps for each failure.

End with one of:
- *All checks passed — Long Context Manager (LCM) is healthy.*
- *N check(s) need attention — see Fix section above.*

If `lcm_doctor` is unavailable, run `lcm doctor` via Bash and display the
output verbatim. If `lcm` is unavailable, instruct the user to install the
published npm package and rerun `lcm install`.
