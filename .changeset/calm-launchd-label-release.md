---
"@donadiosolutions/lcm": patch
---

Stabilize macOS launchd startup when the GUI domain temporarily retains an absent service label. For the exact code-5 input/output-error condition, LCM confirms absence before and after bounded settling and retries once; repeated failures, permission errors, other diagnostics, and changed manager state remain errors.
