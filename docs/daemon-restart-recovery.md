# Kernel-backed recovery for a wedged managed daemon

> **Status:** protocol contract for [#417](https://github.com/donadiosolutions/lcm/issues/417). This document is deliberately merged before implementation. It does **not** enable offline recovery; until [#419](https://github.com/donadiosolutions/lcm/issues/419) is merged, the existing fail-closed behavior remains in force.

This protocol is the narrowly scoped recovery path for a managed LCM daemon
that is genuine but cannot complete its loopback health exchange. A pathname
and a numeric PID are not safe authority to stop a process: either can change
between validation and a signal. The recovery path therefore relies on Linux
kernel capabilities, not a longer TypeScript pathname check.

It is intentionally conservative. It applies only to an explicit
**lcm daemon restart**, on a supported Linux x64 host, and only to a daemon that
already has authenticated launch evidence. Every other case preserves the
process and its evidence.

## Availability gate

The helper is eligible only when every condition below is true.

| Requirement           | Meaning                                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit action       | The user invoked **lcm daemon restart** after normal configuration validation. Automatic startup, hooks, **lcm doctor**, passive learning, and ordinary **ensureDaemon** calls never enter offline recovery.                                                      |
| Platform              | The process is Linux on x64, the exact packaged Linux x64 helper is present, and the helper proves the expected x86_64 syscall ABI.                                                                                                                               |
| Kernel and filesystem | **pidfd_open**, **pidfd_send_signal**, **openat2**, required **renameat2** flags, **getrandom**, **setns**, and **prctl/PDEATHSIG** have the required semantics. Procfs and the state filesystem support all descriptor, fsync, and gated-child operations below. |
| Health outcome        | The initial public health exchange received **no HTTP response**. A received Response object of any status is not offline recovery.                                                                                                                               |
| Prior evidence        | Recover requires a canonical authenticated launch record that exactly matches the PID file, token, process, runtime, and listener observed through held descriptors. A first managed start instead requires the exact fresh-state predicate below.                |
| State                 | The recovery namespace is exact and has no operation or the one exact resumable operation specified here. Any extra, malformed, replaced, or unexpected state is a refusal.                                                                                       |

An unsupported platform or ambiguous state retains today's behavior: LCM reports
that it cannot safely restart the daemon and does not signal it, remove its PID
file, start a competing daemon, or clean up recovery evidence. This helper is
not a general process killer. It has no fallback based on kill(2),
process.kill, numeric-PID liveness, or a path-only check.

### The no-response boundary

The caller records the health outcome before parsing a response body:

| Outcome         | Definition                                                                                                                         | Required action                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **response**    | Fetch resolved an HTTP Response, including a non-2xx status, authentication error, malformed JSON, or a body that later times out. | Stay on the existing authenticated lifecycle path. Never invoke offline recovery.    |
| **no-response** | Connection setup or transport failed, or the bounded deadline expired before any HTTP response was obtained.                       | It may be considered for offline recovery, but only after every other gate succeeds. |

This stops a responding daemon—however incorrectly it responds—from being
treated as invisible and killed outside the existing authenticated path. A body
timeout after headers is a response, not an offline-recovery condition.

The integration must add a private discriminated transport outcome at the point
fetch resolves. Existing health helpers that return a parsed value or null may
continue to serve the ordinary lifecycle path, but they are prohibited from
deciding offline-recovery eligibility because they collapse a non-OK response,
malformed body, body timeout, and transport failure into the same value. The
restart path consumes the discriminated outcome directly. Tests must cover an
HTTP response whose headers arrive but whose body never completes.

## Trust model and non-goals

The protocol protects managed LCM state against races, stale PID reuse, and
namespace substitution during recovery. It does not make a same-UID user who
can run arbitrary native code or read the daemon bearer token into a separate
security principal. Its purpose is to remove avoidable TOCTOU windows in LCM
and fail closed when the kernel cannot provide the required identity proof.

The helper does not:

- recover a daemon without prior launch evidence;
- upgrade, adopt, or signal a legacy daemon;
- accept a bearer token, health body, or shared-token proof over IPC; the
  helper's controlled admission child performs the direct bearer exchange;
- follow symlinks, magic links, mount crossings, or user-supplied recovery
  paths, except for the three narrowly defined final procfs magic-link captures
  for the target network namespace, a proven listener FD, and the proven direct
  parent's executable described below;
- infer ownership from a port alone, process name alone, UID alone, or a
  numeric PID alone; or
- delete uncertain evidence to make a later retry appear clean.

The foreground/debug launch path is outside the protocol until it can create
the same authenticated managed-launch evidence. It is preserved rather than
retroactively adopted by offline recovery.

## Descriptor-owned state

The protocol has two different, simultaneously retained directory
capabilities. They are never aliases and a successful check on one is never a
check on the other.

| Capability               | Scope                                                                                                                                                        | Rules                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| State-root descriptor    | The private managed LCM state directory. It contains the canonical PID and token leaves and is the only parent from which the recovery root may be resolved. | It is used for daemon.pid, token, and fixed recovery-root creation only.                                                         |
| Recovery-root descriptor | The fixed helper-owned daemon-recovery.v1 child of the state root. It contains selectors, launch evidence, and terminal slots only.                          | It is used for every recovery record and terminal transition. It is revalidated independently before and after every transition. |

The helper receives fixed home and state-root capabilities, not mutable
home/state path strings. It independently resolves the fixed state-root child
through the held home descriptor with openat2 and requires it to be identical
to the separately inherited state-root descriptor. It then resolves the fixed
recovery root relative to that held state-root descriptor. Bootstrap is the
only operation permitted to create that fixed recovery directory; it creates it
with mkdirat, opens it again with openat2, validates its stable directory identity and
privacy, and fsyncs both directories before exposing it as a recovery
capability.

Every directory component resolved below either held state directory
descriptor uses these flags:

    O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV

The helper refuses if it cannot establish either capability, if either
directory is not private to the current user, or if either stable directory
identity changes. Stable directory identity deliberately excludes mutable link
count, size, and timestamp fields, as defined below. It never falls back to a
realpath/stat/pathname sequence. Final
regular-file leaves are opened relative to their correct retained parent with
no-follow semantics, bounded reads, and complete descriptor metadata checks.
The only exceptions to no-magic-link resolution are the three final procfs
captures explicitly defined in this contract; they do not relax
descriptor-bound traversal to their fixed parent directories.

Unknown entries, duplicate records, malformed content, unexpected hard-link
counts, non-regular files, and directory identity drift are ambiguous. They
cause a refusal with no signal and no cleanup.

### Inherited descriptor contract

The role list below previously named the intended capabilities but did not fix
their complete admission ABI. This subsection is the normative version-1
policy. The helper receives exactly descriptors 0 through 8. It rejects every
open descriptor numbered 9 or greater, every missing role, and every pair of
roles that aliases the same kernel object. `FD_CLOEXEC` is clear on all nine
descriptors at entry.

| FD | Role | Exact version-1 admission policy |
| -- | ---- | -------------------------------- |
| 0 | Bounded binary request stream | A Node `stdio: "pipe"` child endpoint, used by the helper only for reads. The accepted Linux representations are defined below. |
| 1 | Bounded binary response stream | A distinct Node `stdio: "pipe"` child endpoint, used by the helper only for writes. The accepted Linux representations are defined below. |
| 2 | Reserved diagnostic stream | A third distinct Node `stdio: "pipe"` child endpoint with the same write direction as FD 1. Version 1 emits exactly zero diagnostic bytes. |
| 3 | Verified helper image | `O_RDONLY`, regular, one link, permission/special bits exactly `0755`, owner pair exactly either `0:0` or the invoking effective UID:GID, and size 1 through 33,554,432 bytes. The complete descriptor bytes must be an ELF64 little-endian, `EM_X86_64` static image whose ELF type is either `ET_EXEC` or `ET_DYN`; both forms require no `PT_INTERP` program header and no `DT_NEEDED` dynamic entry. `ET_DYN` is admitted only in that structurally validated static-PIE form, never as an arbitrary dynamically linked image. SHA-256 is computed over exactly the recorded size. |
| 4 | HOME directory | `O_RDONLY` directory, current effective UID, with neither group nor other write permission. Its GID and exact permission bits are recorded. Link count, size, and timestamps are not policy or identity fields. |
| 5 | Private state root | `O_RDONLY` directory, current effective UID and GID, permission/special bits exactly `0700`, with the stable directory identity required by the descriptor-held stable-state admission slice. Link count, size, and timestamps are excluded. |
| 6 | Node interpreter | `O_RDONLY`, regular, one link, permission/special bits exactly `0755`, and size 64 through 134,217,728 bytes. The complete bytes must be boundedly parsed as ELF64 little-endian `ET_EXEC`, `EM_X86_64`; bounded program-header structure is required and a dynamic interpreter is allowed. SHA-256 covers exactly the recorded size. Its initial strict identity/hash capture is revalidated before the final parent-proof suffix, and it is admitted only when that revalidated identity equals the fresh direct-parent executable capture at that suffix's linearization point, as specified below. No FD 6 owner-pair allowlist exists. |
| 7 | Packaged runtime script | `O_RDONLY`, regular, one link, permission/special bits exactly `0755`, owner pair exactly either `0:0` or the current effective UID:GID, and size 20 through 16,777,216 bytes. Its bytes begin exactly `#!/usr/bin/env node\n`, are strict UTF-8 with no NUL, and are hashed completely. It is never directly executed. |
| 8 | Canonical configuration snapshot | `O_RDONLY`, regular, one link, current effective UID:GID, permission/special bits exactly `0600`, and size 1 through 1,048,576 bytes. The complete bytes are strict UTF-8 with no NUL, contain exactly one structurally valid JSON object, and are hashed completely. This slice does not admit config field semantics, ports, backends, paths, or recovery eligibility; that later semantic parse must use these same held bytes. |

`mode` above means `st_mode & 07777`; object kind is checked separately. Every
regular-file read is position-independent, reads exactly the pre-read `st_size`,
requires EOF at that boundary, and repeats metadata afterward. Short reads,
growth, replacement, metadata drift, invalid UTF-8/ELF/JSON structure, or a
digest mismatch fail closed. No pathname is reopened to obtain file content.

FD 3 retains the existing package-helper trust chain. The already-running
compiled Node runtime authenticates the anchored helper manifest and the exact
helper descriptor before executing the inherited FD 3 through
`/proc/self/fd/3`. On entry the helper requires FD 3's `fstat` identity to
equal its own `/proc/self/exe` identity, then independently hashes FD 3 and
captures that strict identity. It accepts no caller-supplied helper or
descriptor-set digest.

The FD 3 owner pair is a package-installation boundary, not the image's trust
anchor. Exact `0:0` admits a system-owned package and the invoking effective
UID:GID admits a user-owned package; every mixed or different owner pair is
rejected. In both cases authority still comes from the descriptor-held,
compiled-anchor-authenticated manifest/image chain plus the FD 3/self identity
proof. Likewise, `ET_DYN` does not relax the static-helper requirement: only an
otherwise identical x86_64 ELF64 static PIE with neither `PT_INTERP` nor
`DT_NEEDED` is admitted.

#### FD 6 runtime provenance

FD 6's authority is the exact descriptor-held identity of the runtime that
executed Node, not a class of owner pairs and not a package pathname. The
strict immutable-leaf identity used here is exactly the regular-file identity
defined below: device, inode, UID, GID, mode, link count, bounded size, and the
complete descriptor-read SHA-256. Thus FD 6 still receives the full
regular/single-link/mode/size/bounded-ELF/hash validation in the role table;
the parent-executable equality is an additional admission proof and does not
weaken any of those checks. It deliberately permits a runtime owned by a third
UID only when that exact running parent runtime is proven. Equality is not a
general owner grant, a pathname grant, or package authority.

An unsuspended parent cannot be proven to remain on an image after an
observation. Therefore the parent-runtime proof is a **linearizable
observation**, not a promise about the parent at lease return or during the
lease lifetime. The helper completes every non-parent-dependent admission
operation before its final parent-proof suffix: FD inventory, content, and hash
validation; FD 3/self proof; both FD 4/FD 5 relationship checks; the initial FD
6 strict identity/hash capture; every `FD_CLOEXEC` mutation; and their required
post-mutation revalidations. None of those earlier captures, including any
retained parent-executable descriptor, is authority for the final comparison.

The final parent-proof suffix is the last pre-frame operation sequence, with no
output or durable state mutation before `LeaseIssued`:

1. Its final tuple **before** capture records the decimal direct-parent PID from
   `getppid()`, calls `prctl(PR_SET_PDEATHSIG, SIGKILL)`, and immediately
   rereads `getppid()`. The value must be nonzero and exactly the recorded
   parent PID. It opens a PIDFD for that direct parent with `pidfd_open`, proves
   the same PID namespace, and captures the parent's bounded proc start-time
   from the fixed decimal-PID proc entry. It then confirms the complete tuple:
   recorded direct-parent PID, PIDFD-backed liveness of that exact parent, same
   PID namespace, and that recorded bounded start-time. Missing, malformed,
   changing, inaccessible, or different evidence is ambiguous and refuses. The
   parent-death fence remains armed for the helper's lifetime.
2. It makes the **fresh** supported procfs magic-link capture
   `/proc/<decimal-ppid>/exe`, opens that exact executable descriptor, and
   performs the complete FD 6-equivalent regular-file validation and
   descriptor-read SHA-256. The complete strict immutable-leaf identity must
   equal the already revalidated FD 6 identity. A parent-executable descriptor
   captured before this suffix, whether retained or revalidated, never has
   authority for that equality. This fresh executable capture is the proof's
   linearization point.
3. Its final tuple **after** capture repeats the direct-parent PID,
   PIDFD-liveness, same-PID-namespace, and bounded proc-start-time observations.
   Every member of that tuple must still hold.
4. It immediately records the in-memory `LeaseIssued` result. There is no frame
   I/O, output, durable mutation, lock operation, spawn, network operation,
   `fcntl`, or cleanup between the final tuple and `LeaseIssued`; temporary
   parent-proof descriptors are disposed only after that result exists.

Successful issuance proves only that the direct parent's executable equalled FD
6 at this suffix's fresh executable-capture linearization point. It makes no
claim that the parent remains on that image at lease return or for the lease
lifetime. An `execve` before that point refuses; an `execve` after it is not
retroactively observable and cannot invalidate the bounded successful claim.

No pathname is retained as authority, and neither a successful earlier check
nor a matching UID/GID alone permits FD 6. Parent exit, PID reuse, a parent
`execve` race, another procfs race, a short or malformed start-time read, a
changed FD 6 or parent executable identity, an unsupported `prctl` or
`pidfd_open`, or any inability to complete the proof is an explicit pre-frame
refusal with no output and no state mutation. The helper must not clear
PDEATHSIG as part of this proof; it is cleared only by the separately specified
managed-child commit protocol.

Integration #419 obtains the runtime descriptor solely by opening
`/proc/self/exe` in the already-running Node process, retains that descriptor,
and passes it to the helper as the numeric Node `stdio` index `6`. It must not
derive FD 6 from `process.execPath`, `PATH`, a mutable package runtime path, or
any reopened runtime pathname. Node executes the helper only through held FD 3
at `/proc/self/fd/3`; after admission, the helper-managed child receives the
runtime only through the authenticated FD duplication defined below. No other
Node-to-helper runtime handoff is version-1 authority.

This #450 linearization correction preserves #447's third-UID equality and
leaves the FD 3 policy from #442/#443 unchanged. It does not specify or enable
the deferred P2 work in #444 or #448.

The FD 6 and FD 7 limits are a source-slice fail-closed envelope, not a claim
that every Node installation or future LCM bundle has those sizes. The 128 MiB
Node envelope covers the supported bundled Codex Node runtime, and
the 16 MiB script envelope covers the single `dist/lcm.mjs` artifact produced
by the package build. FD 7 remains subject to its explicit owner-pair policy.
FD 6 instead uses the direct-parent proof above, so it can support the actual
runtime without an unbounded UID grant or a mutable-path fallback. This slice
captures and binds their exact strict identities but does **not** make their
captured digests package authority. Integration #419 must provide the FD 6
parent-runtime proof and bind FD 7 to the package-authoritative runtime before
any helper-managed launch or recovery is reachable. An artifact outside either
envelope is unsupported until a new versioned policy is deliberately specified;
it is never accepted by path fallback.

#### Standard-stream representation and bounds

Node documents each `stdio: "pipe"` endpoint abstractly; version 1 consequently
admits either of these Linux representations after descriptor observation:

- an anonymous `S_IFIFO` pipe object: FD 0 is `O_RDONLY`, and FDs 1 and 2 are
  `O_WRONLY`; or
- an unnamed, connected, non-listening `AF_UNIX` `SOCK_STREAM` endpoint with
  `O_RDWR` on each of FDs 0, 1, and 2.

All three must use the same representation class, must be pairwise distinct,
and **must** have `O_NONBLOCK` set on entry. The only permitted status bits are
the role's access mode, `O_NONBLOCK`, and the kernel-generated
`O_LARGEFILE`; `O_APPEND`, `O_ASYNC`, and every other mutable status flag are
rejected. `O_NONBLOCK` is a caller-provided version-1 descriptor-ABI property,
not a helper normalization: the helper checks it with `F_GETFL` and never calls
`F_SETFL` on an inherited protocol stream, because status flags belong to an
open file description and changing them could silently alter caller-visible
descriptor state. This requirement makes the post-`poll` `read` and `write`
attempts bounded even when an input peer withholds bytes or an output peer does
not drain them. A named FIFO or socket, a listening or disconnected socket, a
regular file, character device, terminal, or mixed representation is not a
protocol stream. The logical directions remain helper-relative: read FD 0,
write FD 1, and reserve FD 2 for sanitized diagnostics. The exact version-1
diagnostic budget is zero bytes, so no sanitizer, raw error, token, config,
state, journal, or durable-record byte can be invented at this boundary. Node
may synthesize a bounded public error after observing the helper's exit status;
that text is not helper output.

The frame header is 120 bytes and the payload is at most 8,192 bytes, making
8,312 bytes the maximum encoded frame. The stream reader must tolerate header
or payload fragmentation, multiple frames coalesced in one read, short writes,
and `EAGAIN`/`EINTR` after readiness. It reads or writes only the remaining
bounded bytes under the operation's monotonic deadline; bytes belonging to a
coalesced next frame are retained for that frame, never treated as padding for
the current frame.

The initial two-handshake helper slice uses the fixed helper-local version-1
`OPEN_STABLE_FRAME_DEADLINE_MS = 10,000` monotonic-millisecond budget. The
deadline begins when the inherited descriptor/provenance gates have completed
and issued `LeaseIssued`; it covers exactly one bounded zero-session frame
read, the matching durable-layout admission, entropy acquisition, and the one
response write. It is not inherited from Node, FD 8, or configuration. The
helper retains every descriptor/provenance authority from `LeaseIssued` until
the response write completes or it exits.

After `LeaseIssued`, the entrypoint runs one bounded **pre-frame router**. It
reads one frame before durable-layout inspection and accepts only a complete
zero-session `OpenStable` or `ResumeActive` request: the session ID is all zero,
the ordinal is zero, the request ID is nonzero, and the payload is empty. It
routes `OpenStable` only to stable admission and `ResumeActive` only to the
Prepared-only active admission defined below, before it emits any response. It
does not accept `Bootstrap`, a later-session frame, a second frame, or any
other request kind at this entrypoint. The router is not a general lifecycle
dispatcher and cannot turn a frame into permission to spawn, signal, perform
network/preflight work, use a PID/PIDFD, or mutate durable state.

For either route, the helper opens `lifecycle.serial.v1`, identity-validates it,
and takes its nonblocking exclusive `F_OFD_SETLK` lock **before** inspecting a
durable layout. It retains the serial descriptor and lock, as well as the
inherited descriptor/provenance authorities, through response completion. A
malformed, oversize, checksum-invalid, unsupported, timed-out, or otherwise
unapproved request; entropy failure; failure to open, validate, or lock the
serial; layout, MAC, or identity mismatch; or an incomplete response write is
silent and performs no durable mutation. If a short write has already placed
bytes in the peer's receive buffer before a later failure or deadline, the peer
may observe that partial response; it is not a complete protocol response, and
the helper performs no compensating write, retry beyond its deadline, or
durable mutation.

The initial `ResumeActive` route is a deliberately narrow contract for the
implementation work in #467. It does not make `ResumeActive` user-reachable or
claim that the route is implemented. It accepts exactly this authenticated
Prepared shape and refuses every other active layout:

- the held state root and `daemon-recovery.v1` root have their exact stable
  identities; the token and `lifecycle.serial.v1` have their exact strict
  identities; every record MAC verifies; and the authenticated record graph
  binds the held roots, token, serial identity, and helper identity;
- `lifecycle.current.v1` is one MAC-verified lifecycle selector and
  `restart.current.v1` is one MAC-verified journal, with equal nonzero
  operation ID, equal operation kind, equal terminal-slot index, equal strict
  serial/token identities, equal preflight digest, equal expected PID digest,
  and equal expected launch digest. The selector's lifecycle predecessor and
  the journal's lifecycle predecessor are the same strict identity, while the
  journal also binds the strict restart predecessor;
- exactly one `terminal.N.v1` is the reserved active slot, where `N` equals the
  shared terminal-slot index. Its `lifecycle.exchange` and `journal.exchange`
  are the exact predecessor lifecycle and restart vacancy records exchanged out
  of the roots. The other two terminal slots are absent: sealed or otherwise
  occupied neighbors are not admitted by this slice and fail closed; and
- the canonical state-root `daemon.pid` and recovery-root
  `daemon.launch.current.v1` are the exact MAC-verified PID-vacant and
  launch-vacant records bound by the selector and journal. A numeric PID,
  active launch, missing vacancy, or any cross-record identity/MAC mismatch is
  not Prepared authority.

The selector and journal each carry a little-endian `u64` `phase_bitmap`. For
this initial route, both values are exactly `0x0000_0000_0000_0001`: bit zero
means `PREPARED`, namely that the matching selector and journal have been
durably published at their roots while their exact predecessor vacancies remain
in the one reserved terminal slot. It does not represent a spawned candidate,
PID publication, admission, a signal, or any later recovery phase. The only
accepted operation kinds are `InitialStart` (`1`) and `Rotation` (`2`). Zero,
any other bit or combination, unequal selector/journal bitmaps, `Recovery`,
`RetireDead`, another operation kind, or any later durable phase is silently
refused by this slice rather than derived or normalized.

A successful `ResumeActive` response is exactly a `ResumeActive` response
frame with the request ID repeated, a freshly generated nonzero session ID,
ordinal zero, and the empty-body payload `OK_RESUMED` (`0x0003`), `PREPARED`
(`0x0001`), and `u32le(0)`. `OpenStable` continues to use its matching
`OK_OPEN_STABLE`/`STABLE` response. Neither response authorizes a lifecycle
transition; it only grants the bounded live session described by the admitted
durable state.

#### HOME/state relationship and admission order

FD 4 and FD 5 are never aliases. The helper validates FD 4, opens exactly its
`.lcm` child with the fixed `openat2` no-follow/beneath/no-magic-link/no-cross-
device rules, and requires that reopened directory's stable identity to equal
FD 5. It validates FD 4 and FD 5 both before and after that comparison, reopens
the `.lcm` child a second time, and requires the same identities again. A
renamed HOME, replaced state root, different fixed child, or any identity drift
is an admission failure.

Admission order is exact:

1. prove that the open descriptor inventory is exactly 0 through 8, all with
   `FD_CLOEXEC` clear;
2. validate the three protocol streams, every access/status flag, every
   per-role metadata policy, pairwise non-aliasing, FD 3/self identity, all
   bounded content and hashes including the initial FD 6 strict identity/hash
   capture, and the repeated FD 4/FD 5 relationship;
3. set `FD_CLOEXEC` on FDs 3 through 8 only, without changing any access or
   status flag;
4. revalidate the six descriptor identities, the FD 3/self proof, the initial
   FD 6 strict identity/hash capture, and both sides of the HOME/state
   comparison; and
5. run the final parent-proof suffix: final tuple before, fresh
   `/proc/<decimal-ppid>/exe` capture, complete FD 6-equivalent validation/hash
   and equality, final tuple after, and immediately in-memory `LeaseIssued`.

Only after that lease exists may the helper accept a frame or enter the
descriptor-held stable-state admission slice. Before it exists, the only
permitted operations are bounded descriptor enumeration, `fcntl`, metadata and
socket queries, position-independent reads/hashing, the two read-only fixed
child opens, the one FD 6 parent-proof suffix above (including its PIDFD and
fresh parent-executable capture), and the specified close-on-exec changes.
The `fcntl` and cleanup permissions end before the final tuple begins; from
that tuple through in-memory `LeaseIssued`, only the ordered suffix operations
are permitted. Descriptor admission
must not parse configuration semantics; acquire a durable-state lock; read or
write a protocol frame; write FD 1 or FD 2; create, chmod, chown, truncate,
fsync, unlink, rename, or exchange a filesystem object; create a socket or make
network traffic; inspect or signal another process other than the bounded FD 6
direct-parent proof; spawn; or mutate any durable state. Rejection does not
close, repair, normalize, or clean up an unexpected inherited descriptor before
process exit; it closes only temporary descriptors opened for the FD 6 proof.

#### Canonical invocation descriptor-set digest

`InvocationDescriptorSetV1` is the helper-derived canonical binding for FDs 3
through 8 and the fixed managed launch schemas. It is never supplied by Node.
Its body is exactly 456 bytes:

| Body offsets | Bytes | Field |
| ------------ | ----- | ----- |
| 0..3 | 4 | Exact ASCII `LCMI`. |
| 4..5 | 2 | Unsigned little-endian version `1`. |
| 6..7 | 2 | Unsigned little-endian entry count `6`. |
| 8..87 | 80 | FD 3 regular entry. |
| 88..119 | 32 | FD 4 directory entry. |
| 120..151 | 32 | FD 5 directory entry. |
| 152..231 | 80 | FD 6 regular entry. |
| 232..311 | 80 | FD 7 regular entry. |
| 312..391 | 80 | FD 8 regular entry. |
| 392..423 | 32 | Fixed managed-argv schema digest. |
| 424..455 | 32 | Fixed empty-environment schema digest. |

Every entry starts with exactly `u8 fd`, `u8 role`, `u8 kind`, `u8 zero`.
Roles are helper image `1`, HOME `2`, state root `3`, Node `4`, runtime script
`5`, and config snapshot `6`. Kinds are directory `1` and regular file `2`.
The common identity then encodes `u64le device`, `u64le inode`, `u32le UID`,
`u32le GID`, and `u32le mode`. A directory entry ends there. A regular entry
continues with `u64le link-count`, `u64le size`, and the 32 descriptor-read
SHA-256 bytes. Thus a directory entry is 4 + 28 = 32 bytes and a regular entry
is 4 + 28 + 8 + 8 + 32 = 80 bytes; the complete arithmetic is
8 + (4 * 80) + (2 * 32) + 32 + 32 = **456 bytes**.

The invocation descriptor-set digest is exactly:

    SHA-256("LCMR/INVOCATION-DESCRIPTORS/v1" || InvocationDescriptorSetV1-body)

The fixed managed-argv body uses the protocol's byte-string rule: `u16le(4)`,
then `u32le(length) || bytes` for each of these exact UTF-8 values in order:
`/proc/self/fd/12` (16), `/proc/self/fd/13` (16), `daemon` (6), and
`run-managed` (11). The body is 67 bytes, and its schema digest is:

    SHA-256("LCMR/MANAGED-ARGV/v1" || argv-body)
    = dfc13f989a5adc19ba13f7df0eb09008a060544e621869f7083777610692cc5a

The environment body is exactly `u16le(0)` and contains no names or values. Its
schema digest is:

    SHA-256("LCMR/MANAGED-ENV/v1" || 0x0000)
    = cf8700f139847b30cea0b9ccf17cd51556faad05247912c6e8b098fc99737f50

The 456-byte body and its digest exclude FDs 0 through 2, paths, token bytes,
config bytes, raw descriptor values other than the six fixed FD and role numerals,
file offsets, close-on-exec and transient status flags, timestamps, directory
link counts/sizes, manifest bytes, environment values, and caller-provided
identity or digest material. Unknown role/kind/reserved values, alternate
ordering, padding, or any different byte count are not version 1.

#### Pre-frame refusal and later error mapping

Descriptor admission precedes trusted framing. Any failure in this subsection
produces no response and no FD 1 or FD 2 bytes. The helper calls `_exit(69)` only when a
required platform capability or this ABI version is unsupported. Every other
pre-frame failure, including malformed type/access/metadata/content,
replacement, alias, extra FD, FD 6 parent-proof failure, identity mismatch, or
ambiguous I/O, calls `_exit(78)`.
Neither exit status carries secret detail.

After descriptor admission and a request has passed its matching durable
admission, later replacement or descriptor drift maps to `E_IDENTITY`; a
genuinely unavailable required platform capability maps to `E_UNSUPPORTED`; and
an otherwise ambiguous bounded I/O failure maps to `E_IO`. Every
response-capable post-admission error—those three, `E_PROTOCOL`, `E_PHASE`, or
any other `E_*` code—has an empty body and the durable phase of the route or
session already admitted: `STABLE` (`0x0000`) for `OpenStable`, or `PREPARED`
(`0x0001`) for the initial Prepared-only `ResumeActive` route. A malformed or
unapproved router frame is not a response-capable `E_PROTOCOL`: the bounded
zero-session router above remains silent until matching admission succeeds, so
these response codes never retroactively make a pre-frame or router refusal
response-capable.

The recovery-root descriptor is helper-derived from descriptor 5 and is
deliberately neither the HOME nor state-root descriptor. Bootstrap derives it
through descriptor 5, and every later helper invocation independently reopens
and compares its fixed child relationship before using it. No ambient path,
inherited directory, socket, token, writable file descriptor, or environment
value is authority for the operation.

IPC fields contain no paths; every object reference is a fixed schema leaf
relative to either the state root or recovery root.

For a helper-managed daemon child, the helper duplicates exactly these
capabilities onto fixed child descriptor numbers: 8 HOME directory, 9 state
root directory, 10 read-only token file, 11 read-only canonical configuration
snapshot, 12 verified Node ELF, and 13 verified runtime script. Child
descriptors 8 through 11 and 13 deliberately have close-on-exec cleared because
the helper-managed runtime consumes them after exec. Descriptor 12 may remain
close-on-exec because it is the exec image. Every other descriptor is closed or
close-on-exec. The helper execs the separately verified Node ELF through
/proc/self/fd/12 with exactly this argv:

    ["/proc/self/fd/12", "/proc/self/fd/13", "daemon", "run-managed"]

The runtime-script descriptor survives solely so Node can reopen that exact
script through /proc/self/fd/13 after exec. Each inherited capability is opened
or inherited, no-follow validated, identity-bound into the launch plan, and
deliberately inherited only by the managed child. The FD 12 copy is solely the
already authenticated FD 6 runtime descriptor duplicated to the managed child;
no Node, helper, or child path lookup re-resolves it. If any such capability is
missing, changed, or cannot be duplicated onto its assigned child descriptor,
the helper does not launch. The child has no PATH, NODE_OPTIONS, shebang,
shell, ambient executable resolution, or caller-controlled launch argument.
The helper-managed runtime mode is required to use those descriptor
capabilities and is forbidden to path-write, replace, or unlink daemon.pid.
Ordinary foreground mode remains legacy.

### Canonical leaves

All records have fixed byte limits. The state root owns the canonical
daemon.pid and daemon.token leaves. The token is not a recovery-state record:
its raw bytes are the key for those records, so the helper establishes the
token before creating anything that requires a persistence MAC.

The helper's **fresh-state predicate** is the conjunction of all of these
facts, observed through held descriptors in the helper's current network and
PID namespaces:

- daemon.pid is absent; daemon-recovery.v1 is absent or is the exact gap-free
  bootstrap prefix defined below; and daemon.token is absent or the one exact
  token-only/bootstrap-prefix token described below;
- the inherited configuration descriptor is a regular, single-link,
  owner-only snapshot with canonical bounded content and digest, names at most
  eight distinct loopback TCP listener tuples, and still matches the state
  root and fixed launch plan;
- a descriptor-relative `getdents64` walk of the helper's held `/proc`
  capability contains at most 65536 numeric process directories, and bounded
  no-follow reads of each same-UID process's `status`, `stat`, and `cmdline`
  (16 KiB per leaf, 64 MiB total) find no exact helper-managed argv and no
  recognized legacy/foreground LCM daemon argv for this configuration. It does
  not dereference an `exe` magic link or infer authority from a process name;
- descriptor-relative, bounded parsing of `/proc/self/net/tcp` and
  `/proc/self/net/tcp6` (at most 1 MiB and 8192 canonical rows apiece) is
  complete and shows no LISTEN entry for any configured tuple; and
- for every configured tuple, the helper can create a real TCP socket with
  SO_REUSEADDR and SO_REUSEPORT disabled and bind it exclusively in that
  namespace. It retains those bound socket descriptors as exclusion
  reservations through bootstrap and start preparation.

Malformed, truncated, inaccessible, over-bound, duplicate, or changing
configuration or proc data; a matching daemon process; an occupied tuple;
inability to bind; a namespace change; or any race is unknown, not vacancy.
The process and net scans are repeated after acquiring all exclusion sockets
and immediately before PID-marker creation. The helper preserves foreground or
legacy state: initial uncertainty refuses before any recovery or PID marker,
and a later race refuses before PID vacancy and retains any already-durable
bootstrap evidence rather than repairing it. These
real bound sockets, not an O_PATH descriptor, are the short-lived port
reservations. They are closed only for the controlled candidate's bind; a
candidate bind failure or post-close competing listener triggers exact
candidate abort and never successful publication.

Only after the first fresh-state check succeeds may the helper bootstrap a
missing daemon.token. It obtains exactly 32 bytes from the kernel CSPRNG and
encodes them as exactly 64 lowercase hexadecimal ASCII bytes. Relative to the
held state-root descriptor it opens the fixed leaf with
`O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC` and mode 0600, writes
all 64 bytes, verifies a regular file owned by the current UID, mode 0600,
expected GID, link count one, and exact length, fsyncs the file and state root, reopens it
read-only/no-follow, and requires the same strict leaf identity and bytes.
Short entropy, short write, EEXIST, replacement, or any metadata mismatch is a
refusal; the helper never chmods, truncates, replaces, or repairs a token. A
preexisting token is admitted only through the separate strict read-only path
with those same canonical-content and metadata checks. If a crash leaves only
the newly created token, a later Bootstrap may use it only after proving the
entire fresh-state predicate again; any additional legacy evidence refuses.
Token bytes never enter a durable record, IPC frame, response, environment, or
diagnostic stream.

While still holding the configuration, namespace, token, and exclusion-socket
descriptors, Bootstrap repeats the fresh-state checks and creates the recovery
layout in exactly this order: recovery directory, lifecycle.serial.v1,
lifecycle.current.v1 vacancy, restart.current.v1 vacancy, and
daemon.launch.current.v1 vacancy. Each step is file/parent durable and
reopened/verified before the next. Bootstrap may resume only an exact gap-free
prefix of that sequence with no terminal directory or unexpected child, after
revalidating every existing MAC and the complete fresh-state predicate;
OpenStable never accepts a prefix. A crash or later legacy race may therefore
leave bounded bootstrap evidence, but it never turns that evidence into daemon
authority or repairs contradictory state.

Bootstrap handles daemon.pid exactly once and last: when it remains absent,
the helper creates an immutable MACed LCMR-PID-VACANT-v1 marker with no-follow
`O_CREAT | O_EXCL`, fsyncs the file and state root, reopens it, and compares
the held strict leaf identity and canonical bytes. Absence alone is never PID
vacancy authority. If daemon.pid already contains a numeric or other
non-vacancy record that is not bound by an exact authenticated helper-managed
launch record, or any configured listener is occupied or cannot be proven
vacant, it is legacy/ambiguous state and Bootstrap/OpenStable refuses without
creating or changing a marker. A current numeric PID is admitted only when its
strict leaf identity, record MAC, PIDFD/start facts, launch plan, and current
helper-managed facts all match. No protocol operation overwrites a preexisting
legacy PID, and no direct TypeScript path writes, replaces, or unlinks
daemon.pid.

The recovery root has this exact bounded layout:

| Recovery leaf                       | Stable state                                                                                                      | Active/terminal use                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| lifecycle.serial.v1                 | Permanent helper-created regular control record.                                                                  | Its descriptor is identity-bound into all control records. Helpers take a nonblocking exclusive OFD lock on it before layout inspection and retain it through terminalization. |
| lifecycle.current.v1                | Exact immutable LCMR-LIFECYCLE-VACANT-v1 marker.                                                                  | Holds one immutable lifecycle operation while an operation is active.                                                                                                          |
| restart.current.v1                  | Exact immutable LCMR-RESTART-VACANT-v1 marker.                                                                    | Holds one immutable journal while an operation is active.                                                                                                                      |
| daemon.launch.current.v1            | Exact immutable LCMR-LAUNCH-VACANT-v1 marker until the first admission, then the current immutable launch record. | It is updated only by a verified exchange with a helper-created candidate.                                                                                                     |
| terminal.0.v1 through terminal.2.v1 | All three are absent.                                                                                             | Exactly one may be an active reserved slot; a completed slot remains sealed forever in protocol version 1.                                                                     |

The serial control record and three vacancy markers are helper-created fixed
records, not absence tests. Bootstrap creates and fsyncs lifecycle.serial.v1,
the two selector vacancies, and the recovery-root launch vacancy before any
selector becomes active. It creates the separate state-root PID vacancy only
when daemon.pid is absent, as specified above. OpenStable and ResumeActive re-open/compare its descriptor,
take F_OFD_SETLK exclusive nonblocking, and retain that lock through all
preflight, slot reservation, exchange, direct admission, and terminalization.
Busy, unsupported, replaced, or ambiguous locking fails before mutation or
signal. This lock serializes participating helpers only; it is not authority
by itself. The durable selectors, journals, and post-exchange descriptor proofs
remain the crash fence and source of truth. The vacancy markers are held and
compared through every exchange, so a later operation cannot accept an
attacker-replaced empty file merely because a pathname exists or does not
exist.

Each terminal directory is created with mkdirat and exclusive creation under
the held recovery-root descriptor, opened again no-follow, fully validated, and
held for the entire operation. It has only these fixed children:

| Terminal child                                                          | Active contents                                                                                                    | Sealed contents                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| journal.exchange                                                        | Fresh helper-created journal candidate, then the restart vacancy marker.                                           | The exact former active journal.                                                                                         |
| lifecycle.exchange                                                      | Fresh helper-created lifecycle candidate, then the lifecycle vacancy marker.                                       | The exact former active lifecycle record.                                                                                |
| pid.old                                                                 | Helper-created PID-vacant sentinel before PID quarantine or dead retirement.                                       | The exact prior canonical PID leaf.                                                                                      |
| pid.publish.exchange                                                    | Fresh helper-created replacement PID candidate.                                                                    | The exact PID-vacant sentinel that occupied the canonical PID leaf.                                                      |
| launch.exchange                                                         | Fresh admitted-launch candidate, or a launch-vacant marker for dead/failed-recovery retirement.                    | The exact former current launch record or launch-vacant marker.                                                          |
| target.term.intent.v1, target.kill.intent.v1, target.exited.v1          | Absent until their ordered old-target recovery condition is reached.                                               | Immutable old-target phase receipts, each with the operation ID and target PIDFD/start facts.                            |
| candidate.spawn.intent.v1                                               | Absent until immediately before the one permitted candidate creation attempt.                                      | Immutable launch-plan/parent/operation intent; without a spawned receipt it is unresolved and forbids another candidate. |
| replacement.spawned.v1                                                  | Absent until the parent owns the exact child PIDFD/start facts while the child is behind its pre-exec commit gate. | Exact child, parent, launch plan, and commit-gate receipt written before the child may exec.                             |
| candidate.execed.v1                                                     | Absent until the committed child closes the CLOEXEC error pipe by successful exec and the parent revalidates it.   | Immutable successful-exec acknowledgement for the exact spawned receipt.                                                 |
| candidate.term.intent.v1, candidate.kill.intent.v1, candidate.exited.v1 | Absent until a spawned/published candidate must be aborted.                                                        | Immutable candidate-abort receipts, each with the operation ID and candidate PIDFD/start facts.                          |
| terminal.commit-ready.v1                                                | Absent.                                                                                                            | The immutable inventory and completion receipt.                                                                          |

The canonical member bitmap in terminal.commit-ready.v1 names the permitted
subset for the operation kind. No unexpected child is tolerated. An ordinary
completed initial or normal start has journal.exchange, lifecycle.exchange,
pid.publish.exchange, launch.exchange, candidate.spawn.intent,
replacement.spawned, candidate.execed, and commit-ready. A completed recovery
has that same set plus pid.old, target.exited, and exactly the old-target
TERM/KILL receipts that the observed phase required. A prepared start aborted
before its spawn intent has journal.exchange, lifecycle.exchange, and
commit-ready with an explicit abort reason.

A spawn intent without replacement.spawned never seals and never permits a
second candidate; it remains the one bounded unresolved operation in version 1.
An implementation may prove and safely stop only an exactly identified single
pre-exec child, but even that cleanup does not invent the missing receipt or
authorize sealing/relaunch. Once
replacement.spawned exists, an abort retains the spawn intent, spawned
receipt, any exec acknowledgement, candidate TERM/KILL/exited receipts, and
pid.publish.exchange only if PID publication actually occurred. It may seal
only after that exact candidate is proven dead and canonical daemon.pid is the
held PID-vacant marker.

RetireDead, and a recovery whose old target has exited but whose replacement
must be aborted, also retain launch.exchange containing the exact former
launch record after exchanging a fresh MACed launch-vacant marker into
daemon.launch.current.v1. Their commit-ready result is the supported no-daemon
state: both canonical PID and launch are the exact vacancy markers. A
RetireDead group contains journal.exchange, lifecycle.exchange, pid.old,
launch.exchange, target.exited, and commit-ready, with no signal intent or
candidate member. A post-target-exit recovery abort additionally contains the
applicable spawn/abort members. If either vacancy exchange or its source proof
fails, the operation remains unresolved and cannot seal.

There is one active operation and three lifetime terminal slots. Before any
signal, an operation reserves one absent slot and stores its index in the
journal. A terminal slot is never recycled, deleted, truncated, or renamed in
protocol version 1. A later operation may use only an absent slot. Three slots
are the minimum bounded capacity for an initial managed start, a RetireDead
transition, and one later managed start; this is finite retention, not
recycling. With three sealed slots, preparation fails before PID quarantine or signalling. A
future stopped-daemon retention protocol may reclaim capacity only after a new
independent security review; it cannot be inferred from this version.

### Lifecycle publication fence

The lifecycle selector, together with the permanent serial control record, is
the mutation fence. The OFD lock makes participating-helper reservation
serializable; the selector is the durable crash fence and source-bound state
proof. To begin an operation, a helper holding lifecycle.serial.v1 creates
lifecycle and journal candidates inside its reserved terminal slot, syncs them,
and exchanges each with the held root vacancy marker. It then reopens both
endpoints and proves that the root owns the exact new records while the terminal
slot owns the exact former markers. The operation is active only after both
directory fsyncs succeed.

Every protocol-capable managed start, restart, PID writer, and launch-record
rotation must acquire a live OpenStable or ResumeActive helper session before
spawning or publishing any managed PID state. The helper owns initial, normal,
and replacement launch; Node and systemd do not start a protocol-capable
candidate themselves. PID publication is a helper action, never a Node pathname
write. The caller holds only the live session; a raw operation identifier, a
path, a copied descriptor, an advisory flock, or an in-process mutex is not
later authority. A launcher unable to acquire the serial lock and selector does
not start a protocol-capable daemon.

When a helper exits, its volatile session ends but its root lifecycle and
restart records remain. A later helper must derive the exact durable phase and
either resume that operation or refuse. A pre-protocol writer that does not
participate is legacy/unmanaged. Any mutation it races into a canonical name is
detected by post-exchange revalidation before a signal or replacement
publication; it is never adopted as authority.

The integration retains ordinary user-manager parent enforcement. A
non-systemd parent is accepted only for an exact helper-managed daemon: a
MAC-verified launch record and spawned receipt must bind its PID/PIDFD,
proc-start-time, parent relationship at spawn, helper image, Node interpreter,
runtime script, fixed managed argv, state/token/config descriptor identities,
network namespace, and admitted-facts digest. Any absent or mismatched field
leaves the existing systemd-parent enforcement in force; it does not justify
signalling a process or accepting a recovered daemon.

## Authenticated launch evidence

The helper, not Node and not a daemon-supplied shared-token proof, owns healthy
admission. Node never receives or transports a bearer token in helper IPC and
cannot convert a parsed health result, a shared-token proof, token hash, or
assertion into offline-recovery authority.

For AdmitHealthy, the helper opens and retains the exact no-follow token
descriptor. It then forks one bounded single-purpose admission child before it
creates threads or performs any network I/O. The child receives only the held
token descriptor, a private result pipe, and a descriptor for the exact target
network namespace. It first opens its current network namespace and compares
its complete descriptor identity with the held target:

- If identities are equal, it does not call setns.
- If they differ, it calls setns(target, CLONE_NEWNET) before opening a socket,
  resolving a name, spawning a process, or using a network library, then
  reopens its current namespace and requires exact equality with target.
- EPERM, ENOSYS, EINVAL, a changed descriptor, or any failed comparison is
  unsupported and refuses. In particular, attempting setns to an already
  current namespace is prohibited; an ordinary unprivileged user may receive
  EPERM for that needless call.

Only after this namespace admission does the child directly connect to the
exact recorded loopback listener tuple without DNS, proxy, redirect, or a
caller-selected address. It performs the fixed bounded health and diagnostics
exchange itself with the full Authorization: Bearer value read from the held
token descriptor, returns only bounded non-secret admitted facts through its
private pipe, and exits.

The parent accepts admission only when that exact child exits successfully
within its monotonic deadline, the response satisfies the managed-admission
predicate below, and every held process, listener, state-root, recovery-root,
runtime, token, and launch-plan fact still matches. The bearer value, request
bytes containing it, and response body never enter Node IPC, a diagnostic
stream, a terminal record, or an environment variable. A failed fork,
namespace comparison, setns, connection, response parse, deadline, pipe, or
child exit is a refusal.

Recover runs a separate RecoveryPreflight child after persistent launch-record
validation but before terminal-slot reservation, PID quarantine, TERM, or KILL.
It performs the same compare-then-conditional-setns procedure but performs no
network I/O and never launches a daemon. It also validates that the held helper
image, Node ELF, runtime script, HOME/state/token/config child descriptors,
fixed managed argv, and sanitized environment can reproduce the exact
MAC-verified launch plan. Any failed preflight refuses before a destructive
transition. A successful preflight is not a daemon response and is not durable
admission evidence.

The same controlled-child namespace rule applies to LaunchManaged and
LaunchReplacement, but candidate creation has an additional crash fence. The
helper first creates and MAC/fsyncs candidate.spawn.intent.v1, binding the one
permitted attempt to the operation, parent PID/start, planned namespace,
verified executable/config descriptors, and launch-plan digest. It then creates
private ready, commit, and exec-error pipes and forks exactly once.

Before setns, exec, or any network-capable action, the child calls
`prctl(PR_SET_PDEATHSIG, SIGKILL)` and immediately verifies that `getppid()` is
the recorded parent. If prctl is unavailable or fails, or the parent changed,
the child `_exit`s. It closes unauthorized descriptors, compares its current
namespace with the held planned namespace, conditionally enters and revalidates
the exact distinct namespace, writes one fixed PREEXEC_READY byte, and blocks
on the private commit pipe. The child performs no network I/O and cannot exec
while behind that gate; EOF or any byte other than the one fixed COMMIT byte
causes `_exit`. After consuming COMMIT, and only because the durable spawned
receipt now identifies it, the child clears PDEATHSIG and verifies that clear
before exec so a successfully admitted daemon can outlive the helper. Failure
to clear exits; a parent crash before the clear kills the child, while a crash
after the clear leaves only the exact receipt-bound candidate for Resume to
abort.

Only after PREEXEC_READY does the parent acquire and validate the child PIDFD,
PID, proc-start-time, parent relationship, namespaces, and launch plan. It then
creates and MAC/fsyncs replacement.spawned.v1 and the slot, reopens the receipt,
and proves its strict leaf identity. That durable receipt is the commit
authority. For a fresh start, the parent revalidates and closes the real bound
exclusion sockets immediately before it writes COMMIT; it never substitutes an
O_PATH observation as a port lease. The child execs only the verified
Node/runtime descriptor pair using the fixed managed launch plan; it does not
use a shell, PATH, systemd, an ambient working directory, a shebang, or a
caller-selected executable. Its exec-error pipe is CLOEXEC: a fixed bounded
errno record followed by exit means failure, while EOF plus exact PIDFD/start
and `/proc/PID/exe` descriptor revalidation means exec success. The parent then
creates and MAC/fsyncs candidate.execed.v1 before returning OK_SPAWNED.

A crash after spawn intent but before a durable spawned receipt can never
release the commit gate: PDEATHSIG, the post-prctl parent check, and commit-pipe
EOF force the child to die without exec or networking. Nevertheless Resume
treats that intent as unresolved and never launches another candidate; it may
only perform an exact, non-scanning proof and cleanup of that one child, never
blind PID/process-name cleanup. A crash after the spawned receipt but before
commit, during exec, or before candidate.execed is handled as the exact
recorded candidate: Resume opens a PIDFD only after matching PID/start and
enters candidate abort, because the private exec acknowledgement cannot survive
the old helper. It never resends COMMIT or promotes process appearance into an
exec receipt. An exec error is always candidate-abort input. Failure to enter the exact
namespace leaves the journal unresolved and never launches a fallback-namespace
replacement. `PR_SET_PDEATHSIG`, parent recheck, all three private pipes, and
the required PIDFD/proc comparisons are availability gates, not optional
hardening.

Recover has no live health response to prove. It is authorized only by a launch
record previously published by this helper after direct bearer admission, plus
complete kernel revalidation. A prior Node health result, a shared-token proof,
a token hash, a frame checksum, a reusable capability, or an indirect proxy
response is not authorization to signal.

RetireDead is the only non-destructive transition from an exact stable
helper-managed PID/launch pair back to the supported no-daemon state. Under an
OpenStable lock it verifies both record MACs and strict leaf identities, the
recorded boot/PID-namespace/PID/proc-start tuple, and the complete old listener
set. Because a descriptor cannot be recovered from a dead process, version 1
also requires the recorded target network namespace to equal the helper's
currently opened and verified namespace; a dead target from a distinct,
now-unreachable namespace is preserved and refused. It then takes two bounded
descriptor-relative `/proc` snapshots around a PIDFD-open attempt. The old
subject is retired only when no process with that exact PID/start tuple exists
and the stopped listener predicate proves every configured tuple absent in
that exact current namespace. ESRCH plus absent
descriptor-bound `/proc/PID`, or a currently reused numeric PID with a
different start tuple in both snapshots, proves only that the recorded subject
has exited; a reused process is never opened as the subject or signalled.
Changing/oscillating observations, an exact live subject, any listener, or
inaccessible/over-bound proc data refuses without mutation.

After that proof RetireDead reserves a terminal slot and activates a dedicated
journal/lifecycle operation. It writes target.exited without TERM/KILL intent,
exchanges a fresh MACed PID vacancy with daemon.pid through pid.old, exchanges
a fresh MACed launch vacancy with daemon.launch.current.v1 through
launch.exchange, and terminalizes only when both canonical vacancies and both
retained predecessors are exact. It never performs admission, starts a process,
or sends a signal. A later PrepareStart is permitted only after this exact
retirement is sealed. A responsive daemon remains on the existing authenticated
restart path and is never live RetireDead input. After that existing path has
authenticated and stopped it, RetireDead performs the same exact dead-record
retirement before a helper-managed replacement; Node still does not unlink or
rewrite daemon.pid directly.

Systemd ownership is not inferred away: if the user manager still owns or
restarts a legacy/systemd daemon, the PID, parent, or listener observations are
occupied or changing and RetireDead refuses. Implementation must use the
existing authenticated systemd stop/restart coordination outside this protocol
before dead retirement can become eligible; this protocol does not disable a
unit, suppress its restart policy, or claim a systemd-launched process is a
helper-managed candidate.

There is a deeper manager boundary: a momentary D-Bus “inactive” response or an
empty proc/listener snapshot is not a lease against a pending systemd restart.
Protocol-capable Bootstrap, RetireDead, and PrepareStart are therefore
unavailable for a systemd-managed configuration unless integration #419 can
hold an authenticated manager operation that prevents unit activation/restart
through PID/launch retirement and candidate publication. That lease is not
defined or fabricated by this native protocol. If the integration cannot
provide it, version 1 must keep that configuration on the existing responsive
systemd lifecycle and disable helper-managed fresh/offline transitions. It may
not handwave a manager snapshot into the fresh-state predicate.

### Durable authentication and bounded schemas

Every durable recovery-state v1 leaf created after token establishment is a
canonical record with a trailing
domain-separated token-keyed MAC. The helper alone computes and verifies this
persistence MAC using raw token bytes read from its held token descriptor after
structural parsing and descriptor validation. A managed daemon may receive its
own fixed read-only token descriptor for normal bearer authentication, but it
cannot request, supply, or verify a persistence MAC. The MAC is:

    HMAC-SHA-256(
      raw-token-bytes,
      "LCMR/PERSIST/v1" || u16le(record-kind) || canonical-envelope-through-sha256
    )

The final 32 bytes of every durable recovery-state record are this MAC; the MAC
field is excluded from its own coverage. The preceding SHA-256 covers the fixed
envelope and body, and the MAC covers that SHA-256 too. The helper rejects a missing,
wrong-length, all-zero, duplicate, non-canonical, or mismatched MAC before
using the record as state. It computes no persistence MAC from IPC bytes and
does not accept a MAC, proof tag, or token derivative from Node or the daemon.

This authenticates persisted helper control state against token changes and
record substitution; it does not authenticate a live daemon response. Direct
helper-owned bearer admission remains the only live response evidence.
Pre-admission initial-start controls may be MACed by the live helper session,
but cannot authorize Recover until a launch record has been published after
direct admission.

| Durable kind                                                      | Maximum bytes including envelope/digests/MAC | Required bounded facts                                                                                                                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vacancy and lifecycle.serial                                      | 512                                          | Fixed marker/serial kind, stable state-root/recovery-root identities, serial's non-self inode tuple, and helper image digest.                                                                               |
| Lifecycle selector and journal                                    | 16 KiB                                       | Operation ID, kind including RetireDead, terminal slot, strict serial identity, selector predecessor identities, token identity/digest, preflight digest, expected PID/launch identities, and phase bitmap; the initial ResumeActive slice accepts only the equal `0x0000_0000_0000_0001` Prepared bitmap. |
| PID-vacant and PID record                                         | 1 KiB                                        | Operation ID, PID decimal bytes or vacancy marker, strict PID-file identity when referenced by another record, and expected exchange peer identity.                                                         |
| Launch record                                                     | 64 KiB                                       | Record ID, operation ID, all stable root and strict serial/PID/token/runtime/config identities, process/network facts, listener observations, launch plan, admitted-facts digest, and terminal head.        |
| Spawn intent, spawned, execed, TERM, KILL, exited, abort receipts | 4 KiB                                        | Operation ID, exact receipt kind/subject, parent and candidate PID/start facts where applicable, launch-plan/prior-phase digests, listener result, commit/exec result, and monotonic deadline/result.       |
| Terminal commit-ready inventory                                   | 16 KiB                                       | Operation ID, slot, exact member bitmap, every other member's strict identity, expected root selector/PID/launch facts, vacancy identities, and terminal result enum; never its own identity or digest.     |

Identity encodings are fixed binary schemas, not platform-dependent stat
strings. They are deliberately type-specific:

| Identity type                   | Exact fields                                                                                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable directory identity       | Directory enum; device and inode as u64 little-endian; UID, GID, and mode as u32 little-endian. Link count, size, mtime, ctime, and every other child-mutation-dependent parent field are excluded.                     |
| Strict immutable-leaf identity  | Regular-file enum; device and inode; UID, GID, mode, and link count in the encodings above; bounded u64 size; and exactly 32 bytes of descriptor-read SHA-256 over complete canonical content. Timestamps are excluded. |
| Socket or namespace observation | Object enum and schema-defined, descriptor-observed kernel facts, encoded canonically and reduced to a 32-byte identity digest. A socket O_PATH observation is never a binding or liveness lease.                       |

Creating, mkdiring, renaming, or exchanging a child may change a parent
directory's size and timestamps without changing its authority. All root,
recovery-root, terminal-directory, and namespace-parent comparisons therefore
use stable directory identity. Transition-specific pre/post observations may
record expected child-name sets and durability results, but mutable parent
metadata is never a static authority field.

Record bodies are acyclic. No record body embeds its own MAC, envelope digest,
content digest, size, or timestamp. lifecycle.serial.v1 binds itself only by
its stable non-self inode tuple (type, device, inode, UID, GID, mode, and link
count); other records may refer to the serial by its strict leaf identity.
terminal.commit-ready.v1 inventories every other permitted terminal member and
the explicit expected root selector/PID/launch facts, but excludes its own
strict identity and digest. Its envelope SHA-256 and MAC authenticate the
inventory itself. These exceptions are schema requirements, not omitted
validation.

The launch record contains protocol version and a 32-byte helper-created record
ID; state-root, recovery-root, and serial descriptor identities; canonical PID
leaf identity and decimal PID; token-file identity/digest but never token bytes;
boot-ID digest, PID-namespace identity, PID, process UID, and proc-start-time;
helper image, Node ELF, runtime script,
HOME/state/token/config descriptor identities and digests; fixed managed argv
and environment schema IDs; package version, backend, configured port, and
runtime/entrypoint digests; target network-namespace identity; a sorted listener
array; and the admitted-facts digest. Each listener element contains family,
address bytes, port, LISTEN state, socket inode, the exact decimal FD number,
and the descriptor identity of the held proc/PID/fd/N socket capability captured
only after PIDFD and proc-start-time proof.

The helper checks every runtime digest through its opened descriptor rather than
rereading a pathname. Before PID quarantine, TERM, or KILL it reopens and
revalidates every recorded old-target fact, including token digest/MAC, PID-file
identity, process start time, Node/runtime/config identities, both directory
identities, namespace, and each listener FD capability and TCP tuple. The
network namespace descriptor is opened from the held target process descriptor
and retained across transitions. This one namespace capability is a deliberate
procfs final-magic-link exception to no-magic-link resolution: it is opened
only after PIDFD and proc-start-time proof, then compared by descriptor identity
rather than reused by pathname. The listener capture below is the second such
exception, and the FD 6 direct-parent executable capture is the third. A changed
version, runtime, namespace, listener capability, or launch plan is a mismatch,
not an upgrade signal; the old process remains untouched.

Recording is best effort for ordinary healthy lifecycle use. If a supported
managed start cannot record evidence, the healthy daemon continues on the
ordinary authenticated path; it simply lacks authority for future offline
recovery.

### Managed-admission predicate

Version 1 direct admission has no caller-selected endpoint or parser. The
helper child makes exactly two loopback TCP requests, in this order, to the
admitted listener tuple in its verified target namespace:

| Request     | Required request                                                                                                                                      | Required bounded successful response                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health      | GET /health with Authorization: Bearer raw-token, Accept: application/json, Connection: close, no redirect/proxy/DNS, and a 2 KiB header/body budget. | Status 200, exactly one application/json content type, body at most 2 KiB, and canonical public fields protocol="lcm-daemon/v1", ready=true, pid, port, packageVersion, runtimeSha256, and entrypointSha256.                                                  |
| Diagnostics | GET /diagnostics with the same bearer and fixed headers, only after health succeeds, with an 8 KiB header/body budget.                                | Status 200, exactly one application/json content type, body at most 8 KiB, and canonical authenticated fields authenticated=true, readiness="ready", storageBackend, packageVersion, runtimeSha256, entrypointSha256, pid, port, and managedMode="helper-v1". |

The parser rejects a missing, duplicate, unknown, malformed, non-canonical, or
out-of-bound required field; a non-200 status; an extra redirect; a connection
to another tuple; or any identity mismatch. It compares PID and port with the
candidate PIDFD/tuple, compares package version, backend, runtime, and
entrypoint digests with the held launch plan/config descriptors, and requires
the public and authenticated overlapping fields to agree byte-for-byte. It
serializes the accepted facts in the fixed durable-record encoding and stores
SHA-256 of those exact bytes as admitted-facts digest in the launch record,
journal, spawned receipt, and terminal inventory. The helper never stores the
health or diagnostics body.

The admitted-facts digest input is exact and non-secret: protocol version;
verified network-namespace identity; listener FD number, socket inode, and
loopback tuple; the method, path, status, and normalized content type of each
request/response; every canonical public and authenticated response field; and
the held package, backend, runtime, entrypoint, PID, and configured-port facts
to which those fields were compared. It excludes the bearer token, Authorization
header bytes, and raw response bodies. A launch record is admitted only when
the digest is the SHA-256 of this complete canonical encoding, not a digest of
one endpoint, a parsed health boolean, or a daemon-supplied assertion.

### Listener phase predicates

A port number, socket inode, or proc pathname by itself is never a process
proof. A listener capability is the exact family, loopback address, port, TCP
state LISTEN, socket inode, and recorded FD number together with a held procfs
socket-observation descriptor. It is captured only after PIDFD and
proc-start-time proof and is compared both to the target namespace TCP tuple
and the process-owned socket object.

Listener capture is the second deliberately narrow procfs exception. After
the PIDFD and proc-start-time proof, the helper reaches the fixed target
`/proc/PID/fd` directory only through held, descriptor-bound procfs directory
descriptors. It then opens the one bounded decimal `N` final component of
`/proc/PID/fd/N` with `O_PATH | O_CLOEXEC`, deliberately without `O_NOFOLLOW`,
`RESOLVE_NO_MAGICLINKS`, or `RESOLVE_NO_SYMLINKS` on that final magic link.
Those restrictions would make the required procfs socket object unobtainable;
they remain mandatory for every preceding component and every other procfs
traversal. `fstat` on the resulting O_PATH descriptor must report a socket and
the exact recorded socket inode, and the helper must match that socket to the
same exact LISTEN TCP tuple in the proven target namespace before it records or
uses the capability. The O_PATH descriptor is an observation capability, not a
lease: it does not keep the listener bound, so every live pre-signal predicate
reacquires and revalidates the fixed FD/tuple while the subject is still alive.

| Phase                                                   | Required predicate                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct admission of an existing or newly started daemon | The candidate PIDFD and proc-start-time are exact; every recorded FD number still resolves to the exact socket capability/inode; that process owns every tuple in the complete expected listener set; each tuple is LISTEN in its exact network namespace; no required tuple is missing or duplicated by an unknown competing listener. |
| Before PID quarantine, TERM, and KILL                   | The recorded old target still owns every exact listener capability and namespace TCP tuple. A changed FD, socket inode, tuple, state, namespace, disappearance, or unknown competing listener refuses before a signal.                                                                                                                  |
| Original target stopped                                 | The original PIDFD reports exit and no matching LISTEN tuple remains in the retained namespace. A live listener on any configured tuple is ambiguity, not evidence that a replacement is ready.                                                                                                                                         |
| Replacement publication and direct admission            | The helper-spawned candidate owns the complete expected tuple set in the retained namespace, no old or unknown process owns a configured tuple, and the helper's direct bearer admission succeeds.                                                                                                                                      |
| Terminal state                                          | The new active launch record, current PID leaf, held namespace identity, and listener set are identical to the admitted replacement facts named by terminal.commit-ready.v1.                                                                                                                                                            |

Malformed procfs, a missing socket-to-process association, a non-LISTEN state,
a partial set, a tuple in another namespace, or an unexpected listener makes
the phase contradictory and preserves evidence without a signal or launch.
The generic old-target revalidation rule ends at target.exited. After that
receipt, the stopped and replacement predicates above—not an impossible
revalidation of a dead process—are authoritative.

## Versioned helper IPC

Node and the helper use one bounded binary IPC protocol. JSON, command-line
paths, unbounded environment values, and ad hoc text parsing are excluded.

Every frame has exactly this 120-byte little-endian header:

| Offset | Bytes | Field          | Rule                                                                                                                                   |
| ------ | ----- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | 4     | magic          | Exact ASCII LCMR.                                                                                                                      |
| 4      | 2     | version        | Unsigned little-endian value 1.                                                                                                        |
| 6      | 2     | kind           | Unsigned little-endian schema enum.                                                                                                    |
| 8      | 4     | flags          | Exactly zero in version 1.                                                                                                             |
| 12     | 32    | session ID     | All zero only for zero-session Bootstrap, OpenStable, and ResumeActive. Every later request uses the nonzero helper-issued session ID. |
| 44     | 8     | ordinal        | Zero for a zero-session handshake; otherwise starts at one and increases by exactly one.                                               |
| 52     | 32    | request ID     | Nonzero caller-generated bytes, unique within the current session or zero-session handshake.                                           |
| 84     | 4     | payload length | Unsigned little-endian value from 0 through 8192.                                                                                      |
| 88     | 32    | checksum       | SHA-256 of bytes 0 through 87 followed immediately by exactly payload-length payload bytes.                                            |

The payload follows at byte 120. It is fixed-order for its kind: each variable
byte string is a u32 little-endian byte length followed by exactly that many
bytes; UTF-8 strings reject NUL and non-canonical encoding; booleans are one
byte zero or one; enum values and reserved fields have one exact allowed
encoding; and arrays begin with a u16 little-endian count and are
lexicographically sorted where the schema names an ordering. Frame readers
reject short reads, a checksum mismatch, excess bytes, trailing padding,
unknown fields, duplicate fields, invalid enums, non-canonical integers, or a
payload whose decoded size exceeds its kind-specific bound. The checksum
detects accidental framing corruption; it is not authentication. All deadlines
are monotonic and bounded by the lifecycle operation.

Every durable recovery-state record, vacancy marker, journal, phase receipt,
and terminal receipt is canonical bytes, not JSON. Its envelope is exactly:
four-byte ASCII LCMR magic; u16 little-endian record kind; u16 little-endian
record version; u32 little-endian body length; body; a 32-byte SHA-256 of all
preceding envelope bytes; and the 32-byte domain-separated token-keyed MAC
defined above. The body uses the same scalar rules as frames, has one
schema-defined field order with no tags or optional unknown fields, and must
consume exactly body length. SHA-256 digests, record IDs, request IDs, and
descriptor identity hashes are exactly 32 bytes. Listener arrays are sorted by
family, address bytes, port, state, socket inode, then FD number and reject
duplicates. Any alternate encoding, surplus byte, incorrect length, digest
mismatch, or MAC mismatch is not a recovery-state record and is never repaired
or normalized.

The packaged helper build manifest is deliberately different: it has the
canonical build-manifest envelope and SHA-256 digest required by the compiled
trust anchor, but no per-user token MAC because it is built before any user
token exists. The runtime first authenticates that manifest through the
compiled manifest digest, then uses it only to verify the helper image as
described in Package-helper integrity. It is never accepted as recovery-state
authority.

The following request table is normative. A request carries no pathname,
bearer token, health body, shared-token proof, caller-supplied descriptor
identity, or caller-supplied process identity. The helper derives such facts
through its held capabilities.

| Frame             | Session and allowed layout                                                                                                                        | Exact bounded caller payload                                          | Required action before response                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bootstrap         | Zero session. Exact fresh state/token-only residue, exact gap-free bootstrap prefix, or exact stable layout with zero through three sealed slots. | Empty.                                                                | For fresh/prefix state, validate config and acquire real bound exclusion sockets; strictly open/create the token before any MAC, resume only the fixed prefix, then predicate-gate absent-only PID vacancy. For stable state, only verify the exact layout.                                                                                                                                                                                |
| OpenStable        | Zero session. Exact stable selectors, exact serial control record, and zero through three sealed slots.                                           | Empty.                                                                | Acquire serial OFD lock before layout inspection, verify MACs/identities, issue a fresh volatile session ID, and return the stable phase.                                                                                                                                                                                                                                                                                                  |
| VerifyExisting    | OpenStable session with a non-vacant exact current launch record and matching current helper-managed PID record.                                  | Empty.                                                                | Run direct helper-owned bearer admission against the existing record and return without creating a slot, journal, selector, PID, or launch mutation.                                                                                                                                                                                                                                                                                       |
| ResumeActive      | Zero session. In the initial slice, only the exact Prepared selector/journal, one reserved slot with predecessor vacancies, canonical PID/launch vacancies, and no sealed neighbor defined above. | Empty.                                                                | Route before durable inspection; open/identity-validate/OFD-lock the serial, verify the exact Prepared-only layout, issue a fresh volatile session ID, and return only `OK_RESUMED`/`PREPARED` with the lock retained through response completion. Every other active phase silently refuses. |
| PrepareStart      | OpenStable session in stable state with one absent terminal slot and canonical PID vacancy marker.                                                | One u8 kind: 1 initial or 2 normal rotation; remaining payload empty. | Reserve a slot, create/ MAC journal and lifecycle candidates, exchange root selectors, revalidate, and fsync.                                                                                                                                                                                                                                                                                                                              |
| RetireDead        | OpenStable session with an exact helper-managed PID/launch pair whose recorded subject and listeners satisfy the dead predicate.                  | Empty.                                                                | Without signalling, reserve/activate a RetireDead group, record exit, exchange PID and launch with fresh MACed vacancies, and terminalize the supported no-daemon state; any live, reused-ambiguity, listener, or source mismatch refuses.                                                                                                                                                                                                 |
| LaunchManaged     | Prepared initial/normal session.                                                                                                                  | Empty.                                                                | MAC/fsync spawn intent; create the PDEATHSIG/parent-checked gated child; MAC/fsync spawned receipt before COMMIT; require exact exec acknowledgement; MAC/fsync candidate.execed; otherwise enter exact abort or remain unresolved.                                                                                                                                                                                                        |
| Recover           | OpenStable session; explicit restart path has private no-response result; exact admitted helper-managed launch is stable.                         | One u8 fixed value 1; remaining payload empty.                        | Run RecoveryPreflight before slot reservation/quarantine, then reserve/ MAC recovery state, quarantine PID, signal only through PIDFD, and return only after target.exited is durable.                                                                                                                                                                                                                                                     |
| LaunchReplacement | Exact stopped recovery phase.                                                                                                                     | Empty.                                                                | Use the same intent, PDEATHSIG, ready/commit/exec-error pipes, durable spawned receipt, and execed receipt as LaunchManaged.                                                                                                                                                                                                                                                                                                               |
| PublishPid        | Exact launched-candidate phase with helper-held candidate PIDFD.                                                                                  | Empty.                                                                | Create a MACed candidate PID record in terminal staging and exchange it with the exact canonical PID-vacant marker; reopen/compare/fsync before returning.                                                                                                                                                                                                                                                                                 |
| AdmitHealthy      | Exact PublishedPid phase with a helper-held candidate PIDFD.                                                                                      | Empty.                                                                | Run direct helper-owned full-bearer admission, create/MAC a launch candidate, exchange it into daemon.launch.current.v1, revalidate, and fsync.                                                                                                                                                                                                                                                                                            |
| Abort             | Prepared, exact stopped-recovery, or exact recorded-candidate phase.                                                                              | One u16 little-endian reason enum; remaining payload empty.           | Before spawn intent, seal a start abort; a stopped recovery also retires the old launch to vacancy. An intent without a spawned receipt remains unresolved in v1 even if an exact pre-exec child can be safely stopped. For a recorded candidate, terminate it through exact PIDFD receipts, restore PID vacancy if published, and after old-target exit exchange current launch to vacancy; seal only in an exact supported stable state. |

Bootstrap is initialization only. Every operation begins with OpenStable or,
only when a separately specified ResumeActive slice admits its exact layout,
ResumeActive; either route acquires the serial OFD lock before it trusts a
stable or active layout. Ordinary healthy lifecycle checks use VerifyExisting
after OpenStable and consume no terminal slot. The normal flow is Bootstrap,
OpenStable, PrepareStart, LaunchManaged, PublishPid, AdmitHealthy, and terminal
retirement. A later clean death uses OpenStable, RetireDead, and terminal
retirement before another PrepareStart. The recovery flow is OpenStable,
Recover, LaunchReplacement, PublishPid, AdmitHealthy, and terminal retirement.
LaunchManaged and
LaunchReplacement are helper-owned because the planned namespace and
descriptor-safe launch plan are held kernel capabilities; Node and systemd may
not substitute an ambient launch.

Every response uses message kind request-kind OR 0x8000 and repeats the
request ID. Its payload is exactly u16 little-endian result code, u16
little-endian durable phase, u32 little-endian body length, and that exact
body. For OpenStable and ResumeActive, the response header carries the issued
nonzero session ID and ordinal zero. Bootstrap responses retain zero session.
No response body contains a token, path, raw descriptor value, journal bytes,
or health/diagnostics body.

| Numeric result code                                                                                                                                                                                        | Fixed response body                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0x0001 OK_BOOTSTRAPPED, 0x0002 OK_OPEN_STABLE, 0x0003 OK_RESUMED, 0x0004 OK_VERIFIED, 0x0005 OK_PREPARED, 0x0006 OK_ADMITTED, 0x0007 OK_STOPPED, 0x0008 OK_COMPLETED, 0x0009 OK_ABORTED, 0x000C OK_RETIRED | Empty body.                                                                  |
| 0x000A OK_SPAWNED                                                                                                                                                                                          | u32 PID and u64 proc-start-time.                                             |
| 0x000B OK_PID_PUBLISHED                                                                                                                                                                                    | u32 PID and 32-byte PID-record digest.                                       |
| 0x8001 E_PROTOCOL, 0x8002 E_UNSUPPORTED, 0x8003 E_BUSY, 0x8004 E_LAYOUT, 0x8005 E_MAC, 0x8006 E_IDENTITY, 0x8007 E_PREFLIGHT, 0x8008 E_NO_SLOT, 0x8009 E_PHASE, 0x800A E_IO, 0x800B E_TIMEOUT              | Empty body; the code and durable phase are the only machine-readable detail. |

The durable-phase u16 is exact: 0x0000 STABLE, 0x0001 PREPARED,
0x0002 CANDIDATE_SPAWNED, 0x0003 PID_PUBLISHED, 0x0004 TARGET_TERM,
0x0005 TARGET_KILL, 0x0006 TARGET_EXITED, 0x0007 CANDIDATE_ABORT_TERM,
0x0008 CANDIDATE_ABORT_KILL, 0x0009 CANDIDATE_ABORT_EXITED,
0x000A ADMITTED, 0x000B COMMIT_READY, 0x000C SEALED, 0x000D SPAWN_INTENT,
and 0x000E SPAWN_RECORDED. CANDIDATE_SPAWNED means candidate.execed is
durable, not merely that fork returned. No other phase value is accepted or
emitted.

The following persistence table fixes both phase ownership and idempotency
after a helper crash. It does not broaden the initial zero-session ResumeActive
slice: until a later phase receives its own versioned admission rule, that slice
accepts only the exact Prepared row and silently refuses every other row.

| Durable phase                            | Exact persistence proof                                                                                                                                                                           | Repeated or resumed request                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap                                | Token is strict/opened or exclusively created and file/parent fsynced before the fixed gap-free sequence of MAC-verified serial, selector, launch, and predicate-gated absent-only PID vacancies. | Bootstrap resumes only the exact next prefix step under the full fresh predicate, or is a no-op for exact stable layout; gaps/extra children refuse.                 |
| Open stable / resumed active             | The serial OFD lock is held and the root/slot layout plus every MAC is exact; initial ResumeActive further requires the exact Prepared-only shape above.                                             | A new zero-session handshake obtains a new volatile session only after the matching checks; the initial ResumeActive slice returns only `OK_RESUMED`/`PREPARED`.       |
| Existing verified                        | VerifyExisting completed direct admission against a MAC-verified existing launch record without writing a record.                                                                                 | A duplicate VerifyExisting returns OK_VERIFIED only while every admitted fact remains exact; otherwise it refuses without consuming a slot.                          |
| Prepared                                 | Root lifecycle/restart selectors are MAC-verified operation records; chosen slot holds exact predecessor vacancy markers and journal names that slot. In the initial ResumeActive slice, both kinds are InitialStart or Rotation and both phase bitmaps are exactly `0x0000_0000_0000_0001`. | ResumeActive derives this phase; PrepareStart does not allocate another slot.                                                                                        |
| Spawn intent                             | candidate.spawn.intent is MAC-verified and slot durable before fork.                                                                                                                              | Resume never forks another candidate. Without replacement.spawned it preserves the unresolved operation; exact non-scanning cleanup cannot make the missing receipt. |
| Spawn recorded                           | replacement.spawned is MAC-verified and names the exact child PIDFD/start/parent/launch plan while COMMIT was still gated.                                                                        | After a helper crash, Resume proves and aborts that exact candidate; it never reconstructs the private ack, sends a second COMMIT, or forks again.                   |
| Candidate spawned                        | candidate.execed and replacement.spawned are MAC-verified; exec-error EOF and exact process/executable revalidation succeeded.                                                                    | LaunchManaged or LaunchReplacement returns only that exact candidate; an exec failure enters abort.                                                                  |
| PID published or target quarantined      | The state-root PID endpoint and terminal peer have passed a MAC-verified exchange, reopen/compare, and both-parent fsync.                                                                         | PublishPid is a no-op only when the held candidate PIDFD and both endpoints still match.                                                                             |
| Old-target or candidate TERM/KILL intent | The subject-specific immutable intent is MAC-verified and slot-dir durable before its PIDFD signal.                                                                                               | Resume may reissue only through a newly opened PIDFD proven to be that exact subject PID/start.                                                                      |
| Subject exited                           | The matching subject exited receipt is MAC-verified and its listener predicate is exact.                                                                                                          | Recover/Abort returns the observed phase without a second signal.                                                                                                    |
| Dead record retired                      | RetireDead target.exited, PID/launch vacancy exchanges, predecessor leaves, commit-ready, and selector retirement are all exact and durable.                                                      | It returns OK_RETIRED only in the supported no-daemon state; a partial exchange resumes only that retirement.                                                        |
| Direct admission                         | The helper child succeeded, admitted-facts digest is exact, and launch.exchange has completed its MAC-verified exchange.                                                                          | AdmitHealthy is a no-op only when new active launch/admission facts exactly match.                                                                                   |
| Commit-ready                             | The MAC-verified terminal inventory is durable while lifecycle.current.v1 remains active.                                                                                                         | Resume completes only the specified selector retirements; it cannot create a different group.                                                                        |
| Sealed terminal                          | Commit-ready is exact, both root selectors are original vacancy markers, canonical PID/launch facts match inventory, and serial lock remains held until response.                                 | The session is complete; all later operation frames refuse.                                                                                                          |

For a live session, an exact duplicate request ID with byte-identical frame
contents returns its first bounded response and performs no second transition.
The same request ID with different bytes, a skipped ordinal, an old ordinal
outside the cached response window, or a request not allowed by durable phase
is E_PROTOCOL or E_PHASE. After a crash, volatile response caching is
discarded and an admitted ResumeActive slice derives the idempotent result
solely from MAC-verified persistence; the initial slice derives only Prepared
and never guesses from process timing.

EOF, malformed frames, mismatched session or request IDs, a deadline, or an
unexpected message never causes a fallback signal, cleanup, or new process
launch. The durable journal remains for exact resume. A new helper may resume
only when every persisted and kernel-observed identity proves it is the same
operation; otherwise it preserves evidence and refuses.

## Active managed-launch evidence schema (#493)

This section defines two **codec-only** records for a future managed launch.
They are authenticated evidence, not a grant of authority. The helper does not
yet accept either record in the recovery-root layout, publish either name, use
one to select a route, or infer that a process can be adopted, recovered,
signalled, or retired. In particular, an `ActivePidRecord` or `LaunchRecord`
alone never changes the legacy-daemon rule. That invariant remains in force
until the separately reviewed publisher work in #489 and consumer/admission
work in #490 implement every precondition below.

The records retain the existing `LCMR` version-1 authenticated envelope:

| Envelope field | Canonical encoding |
| --- | --- |
| magic | Four ASCII bytes `LCMR` |
| kind | Exact little-endian `u16`: `0x0006` ActivePid or `0x0007` Launch |
| version | Exact little-endian `u16` value `1` |
| body length | Little-endian `u32`, exactly the fixed body size for its kind |
| envelope digest | SHA-256 of header plus body |
| MAC | HMAC-SHA-256 under the exact held 64-lowercase-hex token, over `LCMR/PERSIST/v1 || kind-u16-le || header-through-envelope-digest` |

The kind is deliberately covered both by the header digest and by the
domain-separated MAC input. Unknown kinds, versions, identity tags, reserved
bytes, alternate integer encodings, non-exact lengths, trailing bytes, a zero
MAC, and every digest or MAC mismatch are refusal. MAC calculation follows
structural parsing, so malformed input never becomes an alternate parser or
MAC oracle. The complete canonical record, including envelope digest and MAC,
is the content whose SHA-256 is used when a later record binds it.

All fixed-width integers are little-endian. A stable directory identity is tag
`1` followed by device `u64`, inode `u64`, UID `u32`, GID `u32`, and mode
`u32` (29 bytes). A strict immutable leaf identity is tag `2` followed by the
same fields, link count `u64`, size `u64`, and a complete-content SHA-256 (77
bytes). Every identity tag must be exact; every device, inode, link count, and
digest must be nonzero; mode is at most `07777`. A digest means exactly 32
nonzero bytes. These rules preserve the existing identity format and do not
reinterpret existing serial, vacancy, selector, or journal records.

Both new bodies begin with this 462-byte binding prefix, in this exact order:

1. `Authority`: state-root stable identity; recovery-root stable identity;
   helper image digest.
2. Strict identities for `serial`, `token`, `configuration`, and `runtime`, in
   that order.
3. `listener_digest`, then `admitted_facts_digest`.

`ActivePidRecord` appends `pid` (`u32`, nonzero), `process_start_time` (`u64`,
nonzero), and `process_digest`; its body is exactly 506 bytes and complete
record is at most 582 bytes. `LaunchRecord` instead appends
`active_pid_digest`, the SHA-256 of the complete canonical `ActivePidRecord`;
its body is exactly 494 bytes and complete record is at most 570 bytes. The
four leaf identities and both facts digests are duplicated deliberately: a
consumer must reject a PID/launch pair unless root, serial, token,
configuration, runtime, listener, and admitted-fact bindings all agree and
the launch's PID digest equals the held complete PID record. A numeric PID,
path, port, UID, a matching token alone, or an independently re-created body
never substitutes for that equality.

The future publisher must hold the state and recovery roots, serial, token,
configuration, runtime, process, and listener descriptors throughout its
admission proof; capture the complete canonical admitted facts from that same
proof; create/write each candidate through its held descriptor; fsync the file
and its parent; exchange only against the exact held vacancy/predecessor; then
reopen, compare strict identity, canonical bytes, envelope digest, and MAC,
and fsync every changed parent. Any create, fsync, exchange, reopen, binding,
or post-operation revalidation ambiguity is retained and refused, never
repaired by pathname cleanup. These ordering rules are preconditions for
#489/#490, not operations introduced by #493.

## Kernel transition rules

The Linux x64 helper uses first-party raw syscall wrappers only. It requires:

| Operation         | Required property                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pidfd_open        | Obtains a stable handle for the recorded process before the destructive transition.                                                                                                         |
| pidfd_send_signal | Is the only way to send SIGTERM or SIGKILL. Numeric-PID kill(2), process.kill, and signal fallbacks are prohibited.                                                                         |
| openat2           | Resolves state and procfs hierarchy under held descriptors without symlink or magic-link traversal, except for the two fixed final procfs magic-link captures explicitly constrained above. |
| renameat2         | Publishes helper-created leaves with no-replace semantics and performs identity-checked exchanges where a pre-existing name must change.                                                    |
| setns             | Is used only by a helper-forked child to enter a held exact network namespace before direct admission or replacement exec. A parent-side or fallback namespace transition is prohibited.    |
| getrandom         | Supplies the exact 32-byte token seed for absent-only pre-MAC fresh bootstrap; short or unavailable entropy has no fallback.                                                                |
| prctl             | `PR_SET_PDEATHSIG` with SIGKILL plus an immediate parent check is mandatory before a candidate child may report ready, receive COMMIT, exec, or perform network I/O.                        |

Before the destructive transition, the helper opens /proc, /proc/PID, the PID
file through the state-root descriptor, token, current launch record, both
selectors, runtime file, target network namespace, and PIDFD. It retains every
relevant descriptor through replacement validation and terminal retirement.
Listener evidence comes from the held target proc descriptor and retained
network namespace, never from the helper's own namespace.

Before PID quarantine, SIGTERM, and SIGKILL, the helper compares stable
directory identities and strict immutable-leaf/MAC-verified content values
against the held
old-target snapshot. The process must still be the process identified by both
PIDFD and recorded proc start time. If it exits, that is an observed state
transition, never permission to signal a recycled PID. After target.exited, the
stopped, candidate, replacement, and terminal listener predicates are
authoritative; the helper does not try to revalidate a dead old target before
completion.

After a durable prepared journal and exact PID quarantine, the helper sends
SIGTERM through the PIDFD and waits with bounded poll on that PIDFD. It
revalidates live evidence before SIGKILL through the same PIDFD. If the process
remains alive after the bounded kill phase, or any revalidation differs, the
journal is retained and no replacement starts.

### Source binding and exchange-only retirement

Openat2 protects name resolution and a directory FD protects the directory.
Neither binds the source of renameat2(source path, destination path) to the
inode previously validated. RENAME_NOREPLACE protects destination absence; it
does not bind a mutable source pathname to a held descriptor.

Every pre-existing canonical source is moved directly into its final terminal
child by RENAME_EXCHANGE with a helper-created, MACed candidate or sentinel.
The helper holds both source and candidate descriptors before the exchange,
reopens both post-exchange names, compares strict leaf identity, canonical bytes,
and MAC, and fsyncs every affected parent. A state-root/recovery-root exchange
is supported only when the two held roots have the same filesystem identity;
otherwise the platform gate refuses before preparation.

The following transitions are the only permitted transitions:

| Transition                                                           | Helper-created terminal staging                                                                                                                                                                                                          | Required post-exchange proof                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Activate journal                                                     | terminal.N/journal.exchange starts as a fresh journal and exchanges with restart.current.v1.                                                                                                                                             | Root is the held journal; terminal child is the held restart vacancy marker.                                    |
| Activate lifecycle fence                                             | terminal.N/lifecycle.exchange starts as a fresh lifecycle record and exchanges with lifecycle.current.v1.                                                                                                                                | Root is the held lifecycle record; terminal child is the held lifecycle vacancy marker.                         |
| Quarantine or retire old PID                                         | terminal.N/pid.old starts as a fresh PID-vacant sentinel and exchanges with state-root daemon.pid only after the operation's exact live-target or dead-target predicate.                                                                 | Terminal child is the exact held old PID inode/content; canonical PID is the held sentinel.                     |
| Publish any candidate PID (initial, normal, or recovery replacement) | terminal.N/pid.publish.exchange starts as the fresh helper-held candidate PID record and exchanges with the exact canonical PID-vacant marker: the bootstrap marker for an initial/normal start or the quarantine sentinel for recovery. | Canonical PID is the exact new record; terminal child is the exact held PID-vacant marker.                      |
| Abort published candidate                                            | Canonical candidate PID exchanges with terminal.N/pid.publish.exchange, which holds the exact PID-vacant marker after publication.                                                                                                       | Canonical PID is the exact held vacancy marker; terminal child is the exact dead candidate PID record.          |
| Publish admitted launch                                              | terminal.N/launch.exchange starts as a fresh directly admitted launch record and exchanges with daemon.launch.current.v1.                                                                                                                | Canonical launch is the new record; terminal child is the exact held old launch record or launch-vacant marker. |
| Retire dead or failed-recovery launch                                | terminal.N/launch.exchange starts as a fresh MACed launch-vacant marker and exchanges with the exact old daemon.launch.current.v1 after dead-target proof.                                                                               | Canonical launch is the exact held vacancy marker; terminal child is the exact old launch record.               |
| Retire journal                                                       | restart.current.v1 exchanges with terminal.N/journal.exchange, which still holds the original vacancy marker.                                                                                                                            | Terminal child is the exact journal; root is the exact original restart vacancy marker.                         |
| Retire lifecycle fence                                               | lifecycle.current.v1 exchanges with terminal.N/lifecycle.exchange, which still holds the original vacancy marker.                                                                                                                        | Terminal child is the exact lifecycle record; root is the exact original lifecycle vacancy marker.              |

There is no path-check-then-rename sequence and no no-replace move of a
pre-existing source. There is no unlinkat, rename-to-trash, or cleanup path for
any protocol record in version 1. A terminal child may contain a helper-created
vacancy marker after a later exchange; it is retained in the sealed inventory
rather than deleted. The current active launch is retained at
daemon.launch.current.v1 as an immutable inode; a successor appears there only
through the direct launch exchange above, which deposits its predecessor in the
terminal group.

### Durability, crash linearization, and resume

Every durable mutation means: create or write through a held descriptor, fsync
that file, fsync its held parent directory, reopen the named endpoint through
the correct parent descriptor, and compare stable parent identity plus strict
leaf identity and bounded contents.
For an exchange, both changed parent directories are fsynced. The filesystem
must support all required directory fsync calls. A failed or interrupted write,
fsync, or rename is potentially mutating; the helper retains state and refuses
unless the exact table layout proves a safe resume.

| Stage                       | Required persistence and linearization point                                                                                                                                                                     | Resume/refusal rule                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token bootstrap             | Under the exact fresh predicate and live bound exclusion sockets, exclusively create/write/validate/fsync/reopen daemon.token before any MACed record.                                                           | EEXIST, malformed token, listener/config uncertainty, or token-only residue outside the fresh predicate preserves/refuses; no recovery or PID marker is created.         |
| Bootstrap                   | Recheck fresh state while reservations are held; create/MAC/fsync/reopen lifecycle.serial and recovery selector/launch vacancies, then create the still-absent canonical PID vacancy last.                       | A preexisting or raced PID/listener/legacy topology is never changed or marked vacant.                                                                                   |
| Open/Resume precheck        | Take serial OFD lock; verify serial identity, all record MACs, exact stable/active layout, and held root identities. For recovery, run conditional-setns RecoveryPreflight before a slot, quarantine, or signal. | Busy/unsupported/preflight mismatch refuses before mutation or signal.                                                                                                   |
| PrepareStart                | Create/MAC/fsync terminal slot, journal candidate, and lifecycle candidate; exchange each with root vacancy marker; reopen/compare/MAC-check and fsync recovery root and slot.                                   | Both root operation records and both slot vacancy markers must be exact; otherwise preserve/refuse. No PID signal occurs before this point.                              |
| Spawn intent                | Create/MAC/fsync candidate.spawn.intent before the one fork. Child establishes PDEATHSIG, verifies parent, enters namespace without networking, reports ready, and waits behind COMMIT.                          | A crash leaves SPAWN_INTENT; no later helper launches another candidate. The gated child dies on parent loss/EOF and only exact safe cleanup is allowed.                 |
| Spawn receipt/commit        | Parent validates PIDFD/start/parent/plan, creates/MAC/fsyncs replacement.spawned while child is gated, then sends the sole COMMIT byte.                                                                          | A crash after the receipt treats only that exact candidate as live-or-abortable; it never infers that COMMIT was or was not consumed.                                    |
| Candidate exec              | CLOEXEC exec-error EOF plus exact PIDFD/start/executable proof precedes create/MAC/fsync of candidate.execed.                                                                                                    | Errno, pipe ambiguity, child exit, or missing execed receipt enters exact candidate abort or remains unresolved; OK_SPAWNED is impossible earlier.                       |
| PID publication             | Create/MAC/fsync candidate PID record in slot and exchange with an exact canonical PID-vacant marker; reopen/compare/MAC-check and fsync state root and slot.                                                    | Any non-vacancy/preexisting numeric PID source refuses untouched. A partial exchange is unresolved.                                                                      |
| PID quarantine              | Fsync/MAC-check held old PID; create/MAC/fsync pid.old sentinel; exchange it with canonical PID; reopen/compare and fsync state root and terminal slot.                                                          | Only exact quarantined layout and successful RecoveryPreflight permit TERM. Any swapped endpoint refuses.                                                                |
| Old-target TERM             | Create/MAC target.term.intent.v1, fsync it and the slot, satisfy pre-TERM listener predicate, then send PIDFD SIGTERM.                                                                                           | Exact resume may reissue only after proving same target PID/start through a new PIDFD.                                                                                   |
| Old-target KILL             | After bounded poll and pre-exit listener/process revalidation, create/MAC target.kill.intent.v1, fsync it and the slot, then send PIDFD SIGKILL.                                                                 | The same exact-PIDFD rule applies. A liveness/listener mismatch refuses.                                                                                                 |
| Subject exit                | Prove subject exit through its held PIDFD, satisfy stopped predicate for old target or candidate-abort predicate for candidate, then create/MAC subject.exited receipt and fsync.                                | No replacement begins until target.exited is exact. Candidate abort cannot seal until candidate.exited is exact.                                                         |
| Candidate abort             | Create/MAC candidate TERM/KILL/exited receipts as required, then exchange canonical candidate PID back with held vacancy marker.                                                                                 | If the candidate cannot be proven dead or the vacancy exchange is not exact, retain unresolved state; Abort never discards a live candidate.                             |
| Dead retirement             | Without a signal, MAC/fsync target.exited, exchange PID and launch with fresh vacancies into pid.old/launch.exchange, and prove both endpoints and parents durable.                                              | A partial RetireDead resumes only that operation. Any live/reused-ambiguous subject or listener refuses.                                                                 |
| Recovery abort to no-daemon | After target.exited and exact candidate exit/PID restoration, exchange a fresh launch vacancy with the old active launch and prove the old launch retained in the slot.                                          | It may commit only with canonical PID and launch both vacant; otherwise the recovery remains active.                                                                     |
| Launch record               | After direct admission only, create/MAC launch candidate with admitted-facts digest and exchange it into current launch; reopen/compare/MAC-check and fsync every changed parent.                                | A partial exchange is unresolved; no pathname cleanup repairs it.                                                                                                        |
| Commit-ready                | Write/MAC terminal.commit-ready.v1 with every other member identity/digest and expected active PID/launch facts, excluding its own identity/digest; fsync file and slot while lifecycle.current remains active.  | The operation is still fenced. Resume may only retire the named selectors.                                                                                               |
| Terminal linearization      | Reverse-exchange restart selector first, then lifecycle selector last; reopen/compare/MAC-check each and fsync recovery root and slot after each.                                                                | The final lifecycle exchange plus both directory fsyncs is completion. Before it, operation remains unresolved; after it, only exact sealed terminal layout is accepted. |

The journal kind distinguishes initial/normal launch, recovery, and abort. A
non-recovery kind still uses helper-owned launch, canonical PID vacancy
exchange, selectors, serial lock, slot reservation, MACs, fsync, direct
admission, terminalization, and refusal rules. This prevents a healthy normal
path from bypassing lifecycle publication fencing.

## State-machine outcomes

An active restart.current.v1 selector is exclusive, so there is one durable
unresolved operation and no concurrent recovery. The journal holds a complete,
bounded pre-transition snapshot; phase is derived from exact retained leaves
and current kernel facts, not by repeatedly overwriting mutable state.

| Condition                                                                                                                                               | Required outcome                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon.pid is absent; recovery root is absent or an exact bootstrap prefix; token state and complete fresh config/process/listener predicate hold       | Bootstrap may establish or resume the token/marker sequence while holding real exclusion sockets. Absence by itself never authorizes a marker, and OpenStable never admits a prefix.                                                                          |
| Both daemon.launch.current.v1 and daemon.pid are their exact MAC-verified vacancy markers                                                               | This is the supported stable no-daemon state. A helper-owned start may proceed; no existing process is adopted. A former managed PID requires sealed RetireDead or exact recovery-abort retirement first.                                                     |
| daemon.launch.current.v1 is vacant while daemon.pid is non-vacant, numeric, malformed, or not exactly bound to an admitted helper-managed launch record | Treat any apparent daemon as legacy. Preserve it, its PID file, token, and all evidence.                                                                                                                                                                      |
| Launch record or descriptor mismatch                                                                                                                    | Preserve all leaves and refuse.                                                                                                                                                                                                                               |
| lifecycle.serial.v1 cannot be opened, identity-verified, or exclusively OFD-locked                                                                      | A zero-session OpenStable/ResumeActive router silently refuses before layout trust, slot selection, process launch, PID publication, quarantine, or signal. Only an already response-capable live-session operation may return E_BUSY, E_LAYOUT, or E_UNSUPPORTED, with its already-admitted durable phase. Selectors remain the durable fence even when the lock is held. |
| A received HTTP response exists                                                                                                                         | Use the existing authenticated path; do not invoke the helper.                                                                                                                                                                                                |
| Syscall, procfs, filesystem, architecture, or helper check is unsupported                                                                               | Preserve state and return the existing fail-closed result.                                                                                                                                                                                                    |
| VerifyExisting has an exact managed PID/launch record                                                                                                   | Run the direct managed-admission predicate without reserving a slot or changing a selector, PID, launch record, or terminal group. A mismatch refuses rather than falling back to recovery.                                                                   |
| RecoveryPreflight cannot validate the exact namespace and Node/runtime descriptor launch plan                                                           | Refuse before terminal-slot reservation, PID quarantine, TERM, KILL, connection, or replacement launch.                                                                                                                                                       |
| An active selector/journal and exact reserved terminal slot prove resume                                                                                | Resume only the same bounded operation; never create a second journal or slot.                                                                                                                                                                                |
| candidate.spawn.intent is durable without replacement.spawned                                                                                           | Preserve one unresolved operation and never launch another candidate. Only an exact non-scanning proof may clean up the gated child; otherwise refuse indefinitely rather than guess.                                                                         |
| replacement.spawned is durable without candidate.execed                                                                                                 | Reopen/prove and abort only that exact PID/start candidate; never reconstruct the lost private acknowledgement, infer commit consumption, or launch a second candidate.                                                                                       |
| Journal proof is incomplete or contradictory                                                                                                            | Preserve it and refuse.                                                                                                                                                                                                                                       |
| A candidate was spawned and direct admission or PID/launch publication fails                                                                            | Abort only that exact candidate through its PIDFD and durably record receipts. Restore PID vacancy only if published; after an old recovery target exited, also exchange the old launch to vacancy. Seal only in an exact stable admitted or no-daemon state. |
| Exact helper-managed PID/launch records name a dead subject and the stopped listener predicate is exact                                                 | RetireDead may non-signallingly exchange both records to vacancies and seal their predecessors. A live, responsive, restarted, listener-owning, or changing subject is preserved.                                                                             |
| Target exits and replacement direct bearer admission succeeds                                                                                           | Publish replacement PID and launch through staged exchanges, then perform only selector-proved terminal retirement.                                                                                                                                           |
| All three terminal slots are sealed                                                                                                                     | Refuse before preparation, PID quarantine, or signalling.                                                                                                                                                                                                     |
| Crash, timeout, EOF, or fault after journal publication                                                                                                 | Preserve the selectors, terminal group, PID, token, and listener evidence. Derive only the exact intent/receipt/exchange phase; do not clean state by pathname.                                                                                               |

The exported TypeScript APIs and RestartDaemonResult remain unchanged. Native
refusal preserves the existing fail-closed behavior at the call boundary that
encountered it: an existing throwing live-but-unverified restart remains a
sanitized throw, while an existing result-returning boundary remains a
disconnected/warning result. The integration may not silently turn one into the
other or fabricate a successful restart. User output does not expose token
material, paths, descriptor identities, or journal payloads.

## Packaged-helper integrity

The helper is a statically linked Rust 1.93.0 x86_64-unknown-linux-musl binary
with no third-party Rust crates. Its canonical version-1 build manifest records
the exact helper filename, target, compiler evidence, mode, size, and SHA-256
digest. The packaged static image may use `ET_EXEC` or the structurally static-
PIE `ET_DYN` form admitted above; neither form may contain `PT_INTERP` or
`DT_NEEDED`. The manifest is not discovered by directory scanning.

The build also generates a native-helper trust anchor into the already-running
packaged LCM runtime. That immutable-in-process anchor fixes the manifest
format version, exact relative manifest name, expected target and filename, and
the SHA-256 of the complete canonical manifest bytes. The existing packaged
runtime digest covers the compiled anchor and is itself bound into authenticated
launch evidence. A manifest stored beside the helper is therefore not a trust
anchor by itself: replacing both files after the CLI has loaded cannot satisfy
the in-memory anchor.

CI regenerates the checked-in native-helper trust module and fails if doing so
changes the tree. It verifies that the packed tarball contains the anchored
manifest and exact helper. The expected manifest digest must not come from a
package sibling, package metadata, an environment variable, dynamic directory
selection, or a signature whose verification key is supplied by that same
mutable manifest. Altering the already-loaded runtime verifier itself is outside
this local package-root race boundary and is covered by the existing packaged
runtime trust boundary.

Before execution, Node:

1. selects only the anchor-named manifest and helper paths under a held,
   no-follow package-root descriptor;
2. opens each with no-follow descriptor semantics and verifies regular-file
   type, the exact `0:0` or invoking-effective-UID:GID owner pair, mode, bounded
   size, and expected name;
3. hashes the manifest through its descriptor and compares it first with the
   compiled trust anchor before parsing its strict version-1 fields;
4. hashes the helper through its already-open descriptor and compares it with
   the now-authenticated manifest digest; and
5. executes that exact inherited helper descriptor through its /proc/self/fd/N
   path.

It must not hash one pathname and execute another, reopen the helper by path,
or run a copied executable after verification. A package-root, anchor, manifest,
descriptor, digest, or platform mismatch leaves offline recovery disabled and
preserves the daemon.

## Required validation

Before enabling the protocol, implementation must include:

- Rust unit tests for every frame and response-code/phase schema, canonical
  record parser, descriptor comparison, SHA-256, every durable-kind
  persistence-MAC domain/coverage rule, and every state transition. They must
  prove that a malformed record is structurally rejected before a MAC is used
  and that only the helper computes a valid record MAC from its held token;
  distinguish stable directory from strict immutable-leaf identities; mutate
  parent link count/size/timestamps through every allowed create/mkdir/exchange
  without self-invalidating authority; and prove serial and commit-ready encodings are
  acyclic and exclude their own digest/size/MAC;
- syscall-fault tests for ENOSYS, EPERM, EOPNOTSUPP, short I/O, fsync, rename,
  getrandom, PIDFD poll, OFD lock, prctl/PDEATHSIG, ready/commit/exec-error
  pipes, bind reservations, and every openat2/descriptor-reopen failure. They must
  include the final listener O_PATH capture's normal socket behavior, ENXIO on
  an inappropriate ordinary socket open, wrong object type/inode, and TCP-tuple
  mismatch;
- crash-resume tests at every durable boundary, proving one unresolved
  operation, MAC-verified selector/slot derivation, and no cleanup on
  ambiguity. They include before/after spawn intent, fork, PDEATHSIG/parent
  check, PREEXEC_READY, spawned-receipt file/slot fsync, COMMIT, exec-error EOF,
  execed receipt, each RetireDead exchange, and failed-recovery launch-vacancy
  exchange; no case may fork a second candidate;
- real Linux process/listener tests for PID reuse, PIDFD-only TERM/KILL,
  replacement, target network namespaces, procfs path replacement, and the
  rule that generic old-target FD revalidation stops after target.exited;
- listener-capability race tests proving descriptor-bound traversal through the
  target `/proc/PID/fd` directory, the narrowly permitted final magic-link
  capture only after PIDFD/start proof, exact FD/inode/TCP matching, and that
  an O_PATH observation descriptor does not incorrectly treat a later-unbound
  listener as still live;
- token-content, persistence-record substitution, runtime-symlink, PID-file,
  listener, and pre-signal race tests, including a different-token MAC, a
  changed durable kind/domain, and every record kind listed in the bounded
  schema table. Fresh-token cases cover secure exact 64-hex creation,
  token-only crash residue, raced O_EXCL EEXIST refusal, malformed preexisting token refusal,
  file/root fsync, zero token bytes in records/IPC, and the build manifest's
  deliberate lack of a per-user MAC;
- RecoveryPreflight tests proving it compares current and target namespaces,
  skips setns when equal, enters and verifies only a distinct target namespace,
  performs neither network I/O nor launch, and refuses before slot reservation,
  PID quarantine, or signal when the exact Node/runtime/config plan cannot be
  reproduced;
- managed-child launch tests proving exact fixed FDs 8 through 13, the exact
  `/proc/self/fd/12` Node exec image and argv, the surviving FD 13 script,
  absence of PATH/shell/shebang resolution, and rejection of a managed runtime
  attempt to write or unlink daemon.pid;
- bootstrap/start/abort tests for the held config snapshot; bounded
  proc/net parsing; every occupied, inaccessible, unknown, and raced listener
  result; real exclusive bind reservations; absent-only predicate-gated PID
  vacancy creation; every exact gap-free bootstrap prefix and every refused
  gap/extra-child prefix; unchanged legacy numeric/non-vacancy PID and foreground
  state; helper-owned initial/normal publication; candidate bind failure; and
  post-publication admission failure that PIDFD-terminates the exact candidate
  and restores the held vacancy or remains unresolved;
- spawn-gate tests proving the child establishes PDEATHSIG and rechecks its
  parent before setns/ready, does no network/exec before COMMIT, dies on parent
  loss or commit EOF, clears PDEATHSIG only after receipt-backed COMMIT, reports
  bounded exec errno, acknowledges exec by CLOEXEC EOF plus process proof, and
  cannot become an unrecorded second candidate at every parent/child crash
  interleaving;
- RetireDead tests proving an exact exited subject and absent old listeners,
  safe numeric-PID reuse handling without a signal, refusal for live,
  responsive, changing, inaccessible, distinct/unreachable target namespace,
  or systemd-restarted state, source-bound
  PID/launch vacancy exchanges, exact resume of partial exchanges, and the rule
  that a later managed start requires sealed no-daemon retirement;
- direct-admission tests proving that Node IPC never carries bearer bytes or a
  bearer-derived proof; the child rejects wrong token, method, path, status,
  content type, field, endpoint, response identity, proxy, redirect, DNS,
  child-pipe, and deadline; and only the complete canonical admitted facts
  produce the persisted admitted-facts digest;
- helper-integrity and unsupported-platform tests, including inherited-
  descriptor execution, a swapped helper-and-manifest pair, and a stale
  compiled-anchor value. They must admit FD 3 owned by exactly `0:0` and by the
  invoking effective UID:GID, reject mixed or unrelated owner pairs, admit both
  static `ET_EXEC` and static-PIE `ET_DYN`, and reject `ET_DYN` carrying either
  `PT_INTERP` or `DT_NEEDED`;
- FD 6 provenance tests proving that #419 opens only `/proc/self/exe`, retains
  that descriptor, and supplies it at numeric `stdio` index 6; that it never
  uses `process.execPath`, `PATH`, or a package runtime pathname; and that the
  helper starts only from FD 3 through `/proc/self/fd/3`. They must prove the
  exact pre-frame order: FD inventory/content/hash validation, FD 3/self,
  both FD 4/FD 5 checks, initial FD 6 strict identity/hash capture,
  `FD_CLOEXEC` mutations, and post-mutation revalidation all precede the final
  parent-proof suffix. They must admit a matching third-UID runtime, reject
  every owner-only or nonmatching-identity case, parent
  exit/PID reuse/namespace/start-time/procfs race, and prove no FD 1/FD 2
  output, frame consumption, durable state mutation, or invocation lease on
  ambiguity. The required parent-`execve` injection matrix is:

  | Injection point | Required result |
  | --- | --- |
  | After every pre-linearization checkpoint, including every non-parent admission checkpoint and every observation in the final tuple before the fresh executable capture | Refuse. No retained earlier parent-executable descriptor may satisfy equality, and no frame consumption, output, durable mutation, or invocation lease is permitted. |
  | Immediately after the fresh `/proc/<decimal-ppid>/exe` open, or while its complete FD 6-equivalent validation/hash is running | Issuance is allowed only when the fresh capture linearized before the injected `execve`. The test must demonstrate that success claims equality only at that capture point, not at lease return or later. |
  | After the final tuple after capture, before the caller observes lease return | Issuance is allowed only when that fresh capture already linearized. The test must demonstrate that the immediate in-memory `LeaseIssued` has the same bounded, non-retroactive claim and that no forbidden intervening operation occurred. |
- TypeScript coverage for response versus no-response, unchanged result types,
  headers-received/body-timeout handling, legacy refusal, package verification,
  VerifyExisting's no-mutation path, and the normal authenticated path;
- concurrent lifecycle tests proving that OpenStable/ResumeActive acquire and
  retain the serial OFD lock before layout inspection, that each helper session
  receives the specified zero-session handshake and numeric response, that
  every protocol-capable start/PID publication is also fenced by the durable
  selectors, and that a legacy/raced writer is detected before signal or
  replacement publication; and
- terminal-slot tests for every partial group, three-slot capacity, the bounded
  initial-start/RetireDead/later-start sequence, later recovery alternatives, exact exchange source
  binding, spawn-intent-only unresolved inventory, candidate abort before and
  after PID publication, failed recovery after old-target exit with retained
  old launch and canonical launch vacancy, and each fsync/rename crash boundary.

The helper delivery also pins Rust 1.93.0, the musl target acquisition, and
every downloaded build artifact to immutable versions plus verified integrity
data. Every added CI action is pinned to its immutable commit identifier and
has an explicit version annotation. Before any new package, tool, action, or
other dependency is introduced, its Socket package evaluation is recorded and
reviewed; the helper itself adds no third-party Rust crate.

Valid adversarial scenarios from closed PR #405 are requirements, not reusable
implementation. Permission denial must be injected through deterministic
syscall seams instead of chmod (a root test process can bypass it), and
listener ownership must derive the current UID rather than assume UID 1000.

CodeQL must analyze the Rust source using build mode none. Native package and
normal package tarball verification, complete TypeScript coverage, PostgreSQL
conformance, and CI artifact gates remain mandatory.

## Delivery boundaries

The work merges in this order:

1. [#417](https://github.com/donadiosolutions/lcm/issues/417) locks this
   protocol contract.
2. [#418](https://github.com/donadiosolutions/lcm/issues/418) adds the Linux
   x64 helper, reproducible build, package verification, and Rust analysis
   without enabling the public recovery path.
3. [#419](https://github.com/donadiosolutions/lcm/issues/419) integrates the
   helper into explicit restart, adds user-facing availability documentation and
   a patch changeset, and closes the parent Epic
   [#400](https://github.com/donadiosolutions/lcm/issues/400).

PR #414 remains exclusively about #408 and is not an implementation source for
this protocol. PR #405 remains closed: its adversarial cases inform this test
matrix, but its TypeScript pathname/PID design cannot satisfy the descriptor-
and PIDFD-owned transition requirements above.
