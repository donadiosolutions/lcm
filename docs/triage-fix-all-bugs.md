# Triage and fix all open Bugs

The repository skill `triage-fix-all-bugs` coordinates a complete Bug campaign.
Invoke it from an agent working in this repository:

```text
Use $triage-fix-all-bugs to triage and remediate all currently open Bug issues.
```

An agent that does not discover repository skills automatically can read
[the skill entrypoint](../.agents/skills/triage-fix-all-bugs/SKILL.md) directly.
The skill is repository tooling; it does not add an LCM CLI command or change the
installed `lcm-memory` skill.

The campaign first freezes an exhaustively enumerated set of issues with native
GitHub type `Bug`. Labels do not determine membership. It creates a native `Epic`
hierarchy, preserves issues owned by another parent, and finishes all triage and
duplicate adjudication before starting remediation. Up to seven Bug owners then
coordinate fixes, independent reviews, required CI, and merges.

The entrypoint lists the required models and settings. The agent verifies native
GitHub types and sub-issue support, access, dispatch capabilities, and LCM health
before launching the campaign. Missing prerequisites are reported; the workflow
does not silently replace native types with labels or substitute review models.

Only the root coordinator communicates with you or manages the main local LCM
installation. It keeps the tracking Epic current, handles meaningful worker events
immediately, and reports progress every 30 minutes. Decisions and major blockers
may require your input while unrelated work continues.

Each implementation candidate is reviewed at its exact commit SHA. After three
initial reviewed candidates, remaining accepted P2 findings become linked native
Bug follow-ups outside the frozen scope. Accepted P0/P1 findings continue to block
the fix and trigger implementer escalation when necessary. Follow-ups do not
recursively expand the campaign.

The final report accounts for every original Bug as delegated, closed during
triage, merged/resolved, or genuinely externally blocked and reported to you. It
also lists follow-ups, escalations, the final default-branch HEAD, and LCM health.
An empty worker queue or a temporarily parked issue does not establish completion.

Creating, reviewing, or testing the skill itself does not start a Bug campaign.
