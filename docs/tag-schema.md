# LCM Canonical Tag Schema

> **Status:** Canonical — all agents and tools must follow this schema.
> **Source of truth:** This file. The `lcm_store` MCP tool description references it.

## Why a schema?

Without a canonical schema, the same decision gets stored as `decision:X`, `category:decision`, or just `decision` — making promoted `lcm_search` tag filters unreliable. The canonical schema enforces consistent `<prefix>:<value>` pairs so any agent can construct a precise promoted-layer search filter. Episodic messages and summaries remain searchable when tags are supplied, because tags apply only to promoted memories.

## Durable store guidance

When an agent recognizes durable knowledge, it should store the rationale
immediately. Every durable store should use one `type:<classification>` tag,
the literal `scope:project` or `scope:user`, and `project:<repo>`. Add
`source:<actual-thread-uuid>` when the current agent exposes a real thread UUID.
This is required agent guidance for retrieval quality, not a new runtime
rejection rule: legacy or incomplete tags remain accepted by `lcm_store`.

When a recalled memory directly informs the work, add both
`signal:memory_used` and `memory_id:<id>` in one feedback store per memory
used. Do not add the signal without its paired memory identifier.

## Schema

All tags follow the `<prefix>:<value>` format. Free-text tags (no colon) are allowed but are not searchable by category — prefer canonical tags for anything you intend to filter on later.

### `type:` — what kind of insight is this?

| Value | When to use |
|-------|-------------|
| `type:decision` | An architectural or process decision with trade-offs evaluated |
| `type:preference` | A user or team preference ("always do X", "never do Y") |
| `type:root-cause` | The identified cause of a bug, failure, or incident |
| `type:pattern` | A recurring pattern worth reusing (code structure, workflow, etc.) |
| `type:gotcha` | A non-obvious pitfall, footgun, or surprising behavior |
| `type:solution` | A specific fix or answer to a concrete problem |
| `type:workflow` | A step-by-step process or runbook |
| `type:feedback` | Feedback about how a recalled memory affected the current work |
| `type:feat` | A feature addition or enhancement |
| `type:fix` | A bug fix |
| `type:chore` | Maintenance, refactoring, or tooling work |

### `scope:` — what domain does this belong to?

| Value | When to use |
|-------|-------------|
| `scope:project` | Durable knowledge belonging to the current repository or project |
| `scope:user` | Durable knowledge belonging to the user across repositories |
| `scope:token-budget` | Token window management, quota, efficiency |
| `scope:model-selection` | Haiku vs Sonnet vs Opus routing decisions |
| `scope:architecture` | System design, component structure, data flow |
| `scope:process` | Team workflow, governance, sprint cadence |
| `scope:xgh` | Anything in or about the xgh repo |
| `scope:autoimprove` | Anything in or about the autoimprove repo |
| `scope:lcm` | Anything in or about Long Context Manager (LCM) itself |
| `scope:security` | Secret scanning, auth, access control |
| `scope:testing` | Test strategy, test infrastructure, test failures |
| `scope:ci` | CI/CD pipelines, GitHub Actions, release automation |
| `scope:connectors` | Connector integrations, installation, and generated templates |
| `scope:hooks` | Hook behavior, lifecycle, and integration |
| `scope:codecov` | Codecov coverage components, flags, and thresholds |

`scope:project` and `scope:user` are the only literal scope values for new
durable stores. The other scope values listed above are supplemental
legacy/domain filters; they never replace the required literal scope and must
not be used as a substitute for it. Do not invent another runtime scope
prefix.

### `priority:` — how urgent or important?

| Value | When to use |
|-------|-------------|
| `priority:P0` | Critical — system broken, data loss, security issue |
| `priority:P1` | High — blocks a sprint or a release |
| `priority:P2` | Normal — should be addressed in current or next sprint |
| `priority:P3` | Low — nice-to-have, no deadline |

### `owner:` — who is responsible for acting on this?

| Value | When to use |
|-------|-------------|
| `owner:CTO` | Technical architecture, code quality, test coverage |
| `owner:COO` | Process, coordination, sprint management |
| `owner:team-lead-xgh` | xgh repo work |
| `owner:team-lead-autoimprove` | autoimprove repo work |
| `owner:team-lead-lcm` | lcm repo work |
| `owner:co-ceo` | Governance, strategic decisions, both Co-CEOs needed |

### `project:` — which project/repo?

Freeform identifier matching the repo or project name. Examples:
- `project:lcm`
- `project:xgh`
- `project:autoimprove`
- `project:claudinho`

### `sprint:` — which sprint?

Format: `sprint:spN` (e.g. `sprint:sp3`). Use the sprint declared in the current triage file header. Fallback: `sprint:YYYY-MM-DD`.

### `source:` — where did this insight come from?

Prefer `source:<actual-thread-uuid>` when the current agent exposes a real
thread UUID. The named source values below are supplemental legacy/provenance
labels; retain them only when useful, and do not treat them as replacements for
the actual thread UUID when one is available.

| Value | When to use |
|-------|-------------|
| `source:<actual-thread-uuid>` | Preferred conditional source when a real current thread UUID is available |
| `source:adversarial-review` | From an Enthusiast/Adversary/Judge review cycle |
| `source:session` | From a Co-CEO working session |
| `source:ci` | From automated CI output |
| `source:agent` | From a teammate or subagent |
| `source:retrospective` | From a sprint retrospective |

### `category:` — what kind of captured event is this?

| Value | When to use |
|-------|-------------|
| `category:intent` | A captured user intent or requested outcome |
| `category:mcp` | MCP tool or integration activity |

### `signal:` — what memory lifecycle signal does this record?

| Value | When to use |
|-------|-------------|
| `signal:memory_used` | A prior memory directly informed current work |
| `signal:reinforced` | New evidence reinforced an existing memory |
| `signal:review` | A review result or review-derived learning |

### `memory_id:` — which promoted memory was referenced?

| Value | When to use |
|-------|-------------|
| `memory_id:<id>` | The referenced promoted-memory identifier; pair with `signal:memory_used` so recall usage counting can attribute the memory |

## Combining tags

A durable `lcm_store` entry should use one `type:<classification>`, literal
`scope:project` or `scope:user`, and `project:<repo>`; add
`source:<actual-thread-uuid>` when available. Other canonical tags such as
`priority:`, `category:`, or `signal:` can add useful retrieval context. The
guidance is normative for new agent stores but does not reject legacy tags at
runtime.

**Example — good:**
```
["type:decision", "scope:project", "project:lcm", "source:<actual-thread-uuid>"]
```

The stored text must include the decision's rationale, not only its outcome.

**Example — bad (avoid):**
```
["solution", "lcm", "sp3"]
```
The bad form still works for full-text search but cannot be filtered by tag category.

## Migration note

Existing entries tagged with legacy formats (e.g. `category:decision`, `decision`, `category:gotcha`) are not retroactively migrated — the schema applies to new stores only.

## Validation

There is no runtime enforcement today — the schema is normative by convention. A future `lcm doctor` check may warn on tag-less entries or non-canonical formats.
