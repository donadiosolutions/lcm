---
"@donadiosolutions/lcm": patch
---

Prevent connector removal and install rollback from deleting or overwriting a
replacement at an authenticated connector pathname. Linux connector mutations
now stage complete candidates privately, claim existing leaves by atomic rename,
and publish with no-replace hard links. Wholly managed leaves are physically
removed after validation; concurrent replacements remain intact and named
recovery artifacts are reported when compensation cannot restore the receipt.

Bind connector publication and rollback authority to immutable pre-link
certificates (SHA-256, size, full mode, and canonical device/inode identity),
so post-link edits to either alias cannot be adopted as LCM state. Certified
restore candidates preserve logical initial bytes and mode on a new inode;
external hard links remain attached to the old inode. Evidence and named
recovery artifacts are retained when a claim, compensation, or finalization
cannot be validated.

Sanitize connector removal and rollback diagnostics so retained descriptor
operation paths and nested low-level error causes are never exposed publicly.
Refuse connector leaves and snapshots larger than 4 MiB before read allocation
or mutation.
