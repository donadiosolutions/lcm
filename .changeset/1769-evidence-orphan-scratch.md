---
"@donadiosolutions/lcm": patch
---

Re-running an activation interrupted while writing its attempt or witness
evidence now finishes the write instead of refusing the partial file as
unresolvable. Only a partial file that holds exactly the bytes about to be
written is accepted; any other leftover is still refused.
