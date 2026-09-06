# Managed daemon temporary storage

LCM managed background daemons do not inherit a caller's temporary-directory
settings. The `TMPDIR`, `TMP`, and `TEMP` variables inside a managed daemon are
always set to `<canonical state root>/daemon-tmp`.

Before a daemon is registered with systemd or launchd, LCM creates that leaf
only when it is absent. Creation is non-recursive and uses mode `0700`. An
owner-clearing process umask can clip those requested owner bits. When that
happens during a creation performed by LCM, the newly created empty leaf is
removed after an identity and canonical-path recheck, and startup reports that
an owner-preserving umask such as `0077` is required. LCM does not change the
process umask or repair an existing path. If validation or the bounded removal
cannot be confirmed, the leaf is retained as evidence and may need operator
attention.

When this creation error reaches the managed daemon lifecycle, its refusal
contains the fixed retry guidance above for initial starts, stale-registration
repairs, authenticated legacy migrations, and ordinary managed restarts. Other
supervisor failures retain a generic warning; their error text is not exposed.
The ordinary CLI failure renderer includes this exact trusted warning after its
mapped refusal remediation and does not expose other lifecycle warning values.

An existing leaf is accepted only when it is a directory owned by the current
user, has exactly the private mode (including special bits), is not a symbolic
link, resolves to the exact expected pathname, and remains contained beneath
the canonical state root. Any unsafe, partial, or raced condition fails closed;
LCM does not chmod or repair an unsafe existing leaf.

If an unsafe leaf was left by an older release, inspect the state root and
verify that the leaf is owned by the expected user before repairing it. For an
owned directory, either run `chmod 0700 <canonical state root>/daemon-tmp` or,
when it is empty, remove it with `rmdir <canonical state root>/daemon-tmp`, then
start again under an owner-preserving umask such as `0077`. LCM never performs
these operator repairs automatically.

The same state-root path is reused across daemon restarts, stop operations,
credential cleanup, and launchd plist cleanup. This makes temporary files
available to the daemon across a restart while keeping them private to the
state root. After the final path validation there is an unavoidable same-user
pathname window before the service manager consumes its launch arguments; LCM
retains and revalidates a directory descriptor but does not claim a
descriptor-relative manager launch.

After upgrading from a release that included caller temporary values in the
managed launch identity, one authenticated stop followed by a fresh start may
be required to repair the stale manager registration. The repair is bounded to
the authenticated registration and exact absence proof.

The temporary directory follows the filesystem that contains the canonical
state root. The default installation on this host is therefore XFS-backed, but
LCM does not promise XFS for arbitrary home directories or mounted state roots.
There is no separate temporary-directory override for managed daemons; ambient
temporary controls are intentionally ignored.

Foreground processes and other non-managed callers keep their normal process
environment. This stable temporary-root contract applies only to the
systemd-user and launchd-user manager paths used for managed background
daemons.
