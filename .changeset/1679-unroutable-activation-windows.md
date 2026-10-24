---
"@donadiosolutions/lcm": patch
---

Route the two interrupted `lcm migration` activation windows (after
`prepare-activation` completes and after the publication drive completes) to
`activate` so it resumes them, instead of refusing every command with
route-contradiction (exit 5).
