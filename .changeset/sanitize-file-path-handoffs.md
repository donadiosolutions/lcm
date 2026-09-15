---
"@donadiosolutions/lcm": patch
---

Fix error-message path sanitation across quoted URL, drive, nested-bracket,
IPv6-fragment, and scheme-shaped path handoffs. Private path spans are now
removed in the first pass while separate public URLs remain unchanged.
