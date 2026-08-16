### CLI operations

- `lcm search '<query>'`
  Search broadly when injected context is absent or insufficient.
  - `<query>` is the natural-language search term [required]
- `lcm grep '<pattern>' --mode regex`
  Search prior context for an exact term or regular-expression match.
  - `<pattern>` is the exact term or regular expression [required]
  - `--mode regex` selects regular-expression matching [required]
- `lcm describe <nodeId>`
  Inspect a recalled node before retrieving more detail.
  - `<nodeId>` identifies the recalled node [required]
- `lcm expand <nodeId> --depth N`
  Recover source detail from a summary node.
  - `<nodeId>` identifies the summary node [required]
  - `--depth N` sets the number of levels to expand [required]
- `lcm store '<memory with rationale>' --tag 'type:<classification>' --tag 'scope:project' --tag 'project:<repo>'{{sourceTag}}`
  Store durable knowledge immediately with its rationale and classification.
  - `<memory with rationale>` is the content to persist [required]
  - `type:<classification>` uses one of `decision`, `preference`, `root-cause`, `pattern`, `gotcha`, `solution`, or `workflow`; `workflow` is a reusable procedure and `solution` is a concrete fix or answer [required]
  - `scope:project` or `scope:user` identifies the memory scope [required]
  - `project:<repo>` identifies the repository [required]
  - `source:<actual-thread-uuid>` is included when a real thread UUID is available
- `lcm doctor --help`
  Show the diagnostic command help.

Prefer single quotes around search terms, regular expressions, and stored text to avoid shell expansion or interpolation.
