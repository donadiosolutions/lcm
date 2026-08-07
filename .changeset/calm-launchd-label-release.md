---
"@donadiosolutions/lcm": patch
---

Stabilize macOS launchd startup when the GUI domain temporarily retains an absent service label or exposes a transient malformed registration projection after bootstrap. For an exact bootstrap returning numeric code 5 (input/output error), LCM confirms absence before and after each bounded settle and continues only within the original command deadline. Transient malformed metadata is re-observed without mutation during both bounded launchd recovery windows, while persistent malformed state, permission, transport, timeout, ambiguous, registered, other, and deadline-exhausted states remain classified errors.
