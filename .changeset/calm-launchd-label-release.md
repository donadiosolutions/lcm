---
"@donadiosolutions/lcm": patch
---

Stabilize macOS launchd startup when the GUI domain temporarily retains an absent service label by retrying the exact code-5 label-release failure once after bounded absence proof and settling, while preserving all other manager failures.
