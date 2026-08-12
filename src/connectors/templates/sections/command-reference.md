## Available Commands

- `lcm search "query"` — Search episodic and promoted memory for the current project
- `lcm grep "pattern" --mode regex` — Regex search across messages and summaries
- `lcm describe <nodeId>` — Inspect metadata for a specific memory node
- `lcm expand <nodeId> --depth N` — Expand a summary node into lower-level detail
- `lcm store "content" --tag type:solution --tag scope:lcm` — Store a solution related to LCM
- `lcm doctor` — Run diagnostics
- `lcm diagnose` — Scan recent sessions for hook and MCP issues
- `lcm import` — Import default agent session transcripts into memory
- `lcm import --all` — Import from all projects

## Tag conventions

Use these basic conventions by default; add others as needed:

- `type:` — Kind of learning, such as `solution`, `decision`, `root-cause`, `workflow`, or `gotcha`
- `project:` — Project or repository, such as `lcm`
- `scope:` — Component or domain, such as `connectors`, `hooks`, or `codecov`
- `source:` — Origin, such as `session`, `adversarial-review`, or `ci`
- `priority:` — Importance, from `P0` to `P3`
- `category:` — Event category, such as `intent` or `mcp`
- `signal:` — Memory signal, such as `memory_used`, `reinforced`, or `review`; pair `signal:memory_used` with `memory_id:<id>`

Run `lcm --help` for all options.
