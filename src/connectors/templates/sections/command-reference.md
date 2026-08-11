## Available Commands

- `lcm search "query"` — Search episodic and promoted memory for the current project
- `lcm grep "pattern" --mode regex` — Regex search across messages and summaries
- `lcm describe <nodeId>` — Inspect metadata for a specific memory node
- `lcm expand <nodeId> --depth N` — Expand a summary node into lower-level detail
- `lcm store "content" --tag type:solution` — Persist tagged knowledge to promoted memory
- Store tags: `--tag <tag>` and `--tags <tag>` are repeatable aliases that may be mixed in command-line order
- `lcm store "content" --tag type:solution --tags scope:lcm` — Store one ordered pair of tags using both spellings
- `lcm doctor` — Run diagnostics
- `lcm diagnose` — Scan recent sessions for hook and MCP issues
- `lcm import` — Import default agent session transcripts into memory
- `lcm import --all` — Import from all projects

Run `lcm --help` for all options.
