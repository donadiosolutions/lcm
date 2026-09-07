---
"@donadiosolutions/lcm": patch
---

Allow the exact optional migration receipt v1 epoch/event table pair in captured SQLite sources and resumed portable destinations. Legacy schemas remain supported; partial or malformed pairs still fail closed. Receipt metadata stays private to migration orchestration and is neither authenticated nor copied by canonical transfer.
