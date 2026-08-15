---
name: lcm-memory
description: "Agents MUST immediately store every newly recognized durable decision, preference, root cause, pattern, gotcha, solution, and reusable workflow, including its rationale. Use automatically injected memory first; automatic/passive capture is complementary and never a substitute for explicit durable storage."
---

# Long Context Manager (LCM)

## Required Workflow

- `lcm_search` / `lcm search "query"` — Recall relevant durable and episodic memory. Use automatically injected memory first; run this operation only when injected context is absent or insufficient.
- `lcm_grep` / `lcm grep "pattern" --mode regex` — Find an exact keyword or regular-expression match in prior context. Run only when injected context and broad recall are insufficient and a precise match is needed.
- `lcm_store` / `lcm store "memory with rationale"` — Persist durable knowledge with enough context to reuse later. Agents MUST immediately store every newly recognized durable decision, preference, root cause, pattern, gotcha, solution, and reusable workflow, including its rationale.
- Automatic/passive capture is complementary and never a substitute for explicit durable storage.
- When recalled memory affects the work, record feedback with `lcm_store` using both tags `signal:memory_used` and `memory_id:<actual-id>`. If MCP tools are unavailable, use `lcm store "memory-used feedback" --tag signal:memory_used --tag memory_id:<actual-id>`.

## Advanced Operations

Use these advanced operations only on demand:

- `lcm_describe` / `lcm describe <nodeId>` — Inspect a recalled node before retrieving more detail. Run only on demand when node metadata will guide deeper retrieval.
- `lcm_expand` / `lcm expand <nodeId> --depth N` — Recover source detail from a recalled summary node. Run only on demand when the available summary is insufficient.
- `lcm_doctor` / `lcm doctor` — Inspect LCM installation health. Run only on demand when troubleshooting LCM.
