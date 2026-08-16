# Long Context Manager (LCM)

## When to retrieve

Use injected memory first. If it is absent or insufficient, search broadly; search covers explicitly stored memories and context captured automatically from prior sessions.

{{operations}}

## When to store

Agents **MUST** immediately store every newly recognized durable decision, preference, root cause, pattern, gotcha, solution, and reusable workflow, including its rationale.

Read-only work still performs required LCM retrieval and durable storage unless the user explicitly forbids memory access or storage; LCM memory operations do not modify project files, Git, host configuration, or services.

Store the rationale with the insight so another session can understand and reuse it.

## When to skip

Skip memory work only when there is no project or user durable insight to retrieve or store.

## Retrieval workflow

Search broadly, grep for an exact term, describe a relevant node, then expand it when its summary is insufficient.

## Storage classification

Classify every durable store with exactly one `type:<classification>` tag, literal `scope:project` or `scope:user`, `project:<repo>`, and optional `source:<actual-thread-uuid>`.

{{feedback}}
