---
"@donadiosolutions/lcm": patch
---

Deprecate the ignored `compaction.promotionThresholds.dedupBm25Threshold`
setting: existing configs keep loading, `lcm config get/set` reject the path,
and `lcm doctor` warns when it holds a non-default value.
