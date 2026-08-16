### MCP operations

- `lcm_search`
  Search broadly when injected context is absent or insufficient.
  - `query` is the natural-language search term [required]
  - `limit` optionally bounds the number of results
  - `tags` optionally filters entries by all supplied tags
- `lcm_grep`
  Search prior context for an exact text match.
  - `query` is the exact term or phrase [required]
  - `sessionId` optionally limits the search to one session
  - `since` optionally sets an ISO datetime lower bound
- `lcm_describe`
  Inspect a recalled node before retrieving more detail.
  - `nodeId` identifies the recalled node [required]
- `lcm_expand`
  Recover source detail from a summary node.
  - `nodeId` identifies the summary node [required]
  - `depth` optionally sets the number of levels to expand
- `lcm_store`
  Store durable knowledge immediately with its rationale and classification.
  - `text` is the content to persist [required]
  - `tags` contains exactly one `type:<classification>`; `type:<classification>` uses one of `decision`, `preference`, `root-cause`, `pattern`, `gotcha`, `solution`, or `workflow`; `workflow` is a reusable procedure and `solution` is a concrete fix or answer; literal `scope:project` or `scope:user`, `project:<repo>`, and optional `source:<actual-thread-uuid>`
- `lcm_doctor`
  Run installation health diagnostics.
