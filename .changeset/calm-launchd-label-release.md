---
"@donadiosolutions/lcm": patch
---

Stabilize macOS launchd startup when the GUI domain temporarily retains an absent service label. For an exact bootstrap returning numeric code 5 (input/output error), LCM confirms absence before and after each bounded settle and continues only within the original command deadline; permission, transport, timeout, malformed, ambiguous, registered, other, and deadline-exhausted states remain classified errors.
