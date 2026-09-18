---
"@donadiosolutions/lcm": patch
---

Refuse a portable batch successor that duplicates its predecessor's
identitySha256, matching the official manifest scanner instead of
letting createPortableBatch admit a stream the scanner would reject
downstream. Four domains carry an order field outside their logical
key (passive-events' machineSequence, project-aliases' path,
summary-message-links' and summary-parent-links' ordinal), so a
successor could previously repeat a predecessor's identity while its
order still advanced, which the existing order-regression check does
not catch. Batches built from any portable record source, including
the SQLite-to-PostgreSQL migration copy path, now refuse this case
at construction with a `duplicate-identity` error instead of
accepting it.
