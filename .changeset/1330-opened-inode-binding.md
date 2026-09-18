---
"@donadiosolutions/lcm": patch
---

Refuse a SQLite connection whose handle is not provably bound to the
authenticated database inode. Replacing the database leaf for the constructor
call and restoring it before the post-open path check previously returned a
usable handle on the substituted file while both pathname observations matched
the authenticated inode. On Linux the retained descriptor is now checked before
LCM changes permissions, initializes pragmas, or pools the connection.
