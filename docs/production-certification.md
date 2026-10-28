# Production certification harness

The production certification harness runs one frozen workload from two isolated
LCM machine identities against PostgreSQL 18. It records the exact contract,
machine identities, scheduled attempts, operation samples, fault steps, cleanup
witnesses, and SLO calculations needed to reproduce a gate decision.

The committed contract (`test/certification/contract-v3.json`, version 3) remains
byte-for-byte in `draft` status. Approval lives in
`test/certification/contract-v3.approval.json`, which names the approved contract
SHA-256, approver, approval time, and approval reference. The harness refuses to
collect evidence unless that hash matches the contract bytes, and evidence must
start at or after the approval time. Changing either file invalidates the binding;
changing the contract requires a new approval record. Version 3 supersedes v2; its
only change lowers the largest primary-text size from 8,192 to 6,144 bytes, because
hook capture drops an event whose text and tags exceed 8,192 characters and the
8,192-byte `TaskCreate` fixture produced 8,202. It keeps the v2 hook-command limits
(pooled p50/p95/p99 600/1500/2500 ms, per-kind and per-machine p95 1500 ms).
`contract-v2.json` and its approval record stay in the tree as history only: the
contract loader used by the harness, the machine agents, and the gate refuses any
version other than 3. No certification evidence was collected under v1 or v2.

## What the two machines mean

The local lane uses two rootless Podman containers built from the repository's
digest-pinned Node image. Each container has its own LCM home, registered UUIDv7
and identity key, daemon process, hostname, network namespace, IP address, and
writable evidence directory. Both machines share the host kernel, hardware, and
clock. The result therefore proves behavior across two independent LCM machine
identities and daemon processes; it does not prove independence from host-wide
kernel, clock, hardware, or power failure.

Each machine is limited to one CPU, 1 GiB of memory, and 256 PIDs and runs as a
fixed non-root UID. The staged package and CA are shared read-only mounts with the
shared SELinux `:z` label, never the private `:Z` label. Each machine home and
evidence directory is private and uses a private `:Z` relabel.

## Lanes and profiles

The `local` lane uses the digest-pinned PostgreSQL 18.4 image. It proves the exact
server version, the local ownership and cleanup model, negative TLS checks, the
steady workload, a machine-A partition, and a database restart.

The `managed` lane creates one DigitalOcean PostgreSQL 18 Standard single-node
cluster. It records the exact observed patch version and provider endpoint, runs
the shared readiness and workload checks, and injects only the machine-A network
partition. Provider restart, failover, credential rotation, backup, PITR, reverse
migration, and observability drills belong to their separate certification issues.

`smoke` is a bounded, non-certifying readiness exercise. It uses a 20-second
warmup, 120-second steady phase, and 660-second drain with no faults. It must not
be reported as a production percentile result. `full` runs the frozen 6000-second
steady schedule, fault phases, recovery checks, and final 900-second drain.
For both profiles, the coordinator starts warmup only after both machines are
ready, waits for both warmup-complete witnesses, and then publishes one shared
steady-state T0. The database-growth baseline is collected after that barrier and
before the first scheduled steady operation.

Fresh machine homes enter through the supported SQLite migration path in both
lanes. The coordinator writes `migration-start.json` for machine A and waits for
its public plan/apply/verify receipt before starting machine B's migration; it
then waits for B's verification receipt. After granting the ordinary runtime
profile, the coordinator publishes `activation-start.json` for A and then B so
their activations run serially against the shared project. Once both activation
receipts are recorded, it revokes the transfer profile, proves ordinary runtime
schema/ACL readiness, and publishes `runtime-ready.json` for each machine. Each
agent then records daemon readiness after its doctor, store, and search checks.
The coordinator starts warmup only after both `ready.json` witnesses exist, waits
for both `warmup-complete.json` witnesses, and publishes the shared steady-state
T0. These setup steps and receipts must fit within the 600-second setup budget
and are written to private setup evidence.

## Prepare the staged package

The harness consumes an already-built `dist/` tree. It never invokes `build` or
`postbuild`. Before a real run, use a separately reviewed build whose output has
all of these assets:

- `dist/lcm.mjs`
- `dist/src/prompts/`
- `dist/src/connectors/templates/`
- `dist/src/storage/postgresql/migrations/`
- `package.json`

Staging rejects missing assets, symbolic links, and non-file entries and hashes
the complete staged tree. Build and certification remain separate reviewed steps;
the certification commands never invoke `build` or `postbuild`.

## Run the local lane

Choose a new private evidence directory outside the repository. The command below
does not build the package:

```bash
LCM_TEST_CONTAINER_CLI=podman \
  pnpm run test:certification:local -- \
  --profile full \
  --evidence-dir /absolute/private/lcm-certification/local
```

The local whole-run deadline is 10,800 seconds. The harness creates and labels the
database, network, volume, and two machine containers under one run identity. The
enclosing PostgreSQL harness owns machine-container teardown and verifies that
all owned resources and private roots are gone after the test exits.

## Run the managed lane

Managed execution is authorized separately because it creates a billable provider
resource. Supply the token only through a regular mode-0600 file outside the
repository that is owned by the current user. The file can contain only the bare
token or can be a `doctl` `config.yaml` with exactly one top-level
`access-token:` scalar, either plain or quoted. Supply a canonical public IPv4
address for the single firewall rule and private paths for the created-ID receipt
and evidence:

```bash
LCM_CERT_DIGITALOCEAN_TOKEN_FILE=/absolute/private/do-token-or-config.yaml \
LCM_CERT_TRUSTED_IPV4=203.0.113.8 \
LCM_CERT_RUN_ID=run12345 \
LCM_CERT_CREATED_ID_RECEIPT=/absolute/private/created-cluster.json \
  pnpm run test:certification:managed -- \
  --profile full \
  --evidence-dir /absolute/private/lcm-certification/managed
```

The API client uses only `https://api.digitalocean.com`, refuses redirects, and
places a finite deadline on every request. The token, returned passwords, and
credential-bearing URIs are registered with the redactor before diagnostics.
Provider responses are reduced to an explicit evidence allowlist.

Before creation, the client requires an empty `lcm-cert` family tag. It creates
one cluster with both family and run tags, writes its exact ID to the private
receipt immediately, and never retries an ambiguous create blindly. It reconciles
only one exact name-and-run-tag match. The firewall readback must equal exactly the
one supplied IPv4 rule before database access begins.

A mode-0600 exclusive family lock beside the created-ID receipt serializes local
operators. If the host is killed while the lock is held, reconcile the provider
resource from the receipt and family tag first, then remove the stale lock only
after proving its recorded PID is gone.

The modeled price is recorded as a model, not observed billing. The default guard
stops new work at 20,700 seconds, has a 21,600-second absolute deadline, reserves
900 seconds for cleanup, and stops on a $5 modeled ceiling. Cleanup rereads and
verifies the exact ID, name, and tags, deletes only that cluster, then requires an
HTTP 404 for the ID and an empty family-tag list.

## Recovery after interruption

Normal errors and catchable termination signals enter single-flight owned cleanup.
`SIGKILL`, host loss, or a lost network cannot guarantee that in-process cleanup
ran. Use the private created-ID
receipt, list clusters with the `lcm-cert` family tag, compare the exact ID, name,
and both tags, and then delete that exact ID with an authenticated operator tool.
Do not delete a name-only or tag-only match. A future run refuses to start while
any family-tagged cluster remains.

For the local lane, rerun the PostgreSQL harness orphan discovery. It reclaims
only resources whose owner PID, birth identity, host scope, resource kind, labels,
and database sentinel prove stale ownership. Ambiguous resources are preserved for
manual reconciliation.

## Evidence and non-claims

Raw NDJSON stays in the private evidence directory. The public gate records only
counts, formulas, thresholds, observed values, verdicts, sample-file SHA-256
digests, machine identity hashes, fault timestamps, and cleanup witnesses. Generate
`production-certification-gate.json` and `.md` only from a complete evidence
directory and copy the reviewed outputs into `docs/` in the evidence commit:

```bash
pnpm run test:certification:gate -- \
  --repository-root "$PWD" \
  --evidence-dir /absolute/private/lcm-certification/local \
  --contract "$PWD/test/certification/contract-v3.json" \
  --output-dir /absolute/private/lcm-certification/gate
```

The gate writer rechecks the execution-time repository digest with the same
provenance calculation, reuses the cutover rehearsal schema validator, always
derives every population from raw machine records, and refuses missing readiness,
observer, drain, lane fault, cleanup, contract, provenance or sample evidence. A
supplied manifest cannot define or override the SLO universe. Non-gating raw
diagnostics retain relation-size deltas, submitted payload and envelope bytes,
stored truncation counts, final doctor output hashes, and remote-prune sweep
timestamps.

Execution provenance also carries an execution-host witness captured once at run
start by both lanes: OS release ID and version, kernel release, architecture, CPU
model and logical CPU count, total memory, container engine name and version, and
the SHA-256 of the hostname (the hostname itself is never recorded). When the run
executes on a CI runner, `RUNNER_NAME`, `RUNNER_OS` and `RUNNER_ARCH` are copied
from the environment; absent values are recorded as `null`, never treated as a
failure. Self-hosted runners are named after their machine by default, so a
`RUNNER_NAME` whose first DNS label matches the hostname's (ignoring case) is also
recorded as `null`; any other runner value is recorded as provided. An operator
may declare the runner SKU through `LCM_CERT_RUNNER_SKU` (1-128 characters of
letters, digits, `.`, `_`, `:`, `/` and `-`); when set it is validated and
recorded, when unset it is `null`. The witness is copied as recorded into the
public gate JSON and summarized in the gate Markdown, so a reviewer can see whether
the evidence came from a laptop or a testbox VM. Gate assembly recomputes code
provenance from its own checkout but never captures a second host witness: it
validates the recorded witness against the closed evidence schema, runs no
container engine named in the evidence, and ignores the assembling machine's
`LCM_CERT_RUNNER_SKU`, so a gate can be assembled on another machine. Provenance
capture requires a Git checkout: a copy that arrived without `.git` (for example
through `rsync`) is refused with an explicit message rather than attributed to a
commit that cannot be proven.

The non-injected error rate follows the contract formula `nonInjected failed
attempts / scheduled steady attempts` over the complete expected steady schedule
of both machines: hooks, searches, stores, session snapshots, and explicit
compacts (5,040 attempts for the full profile, 102 for smoke). A scheduled
operation that failed, was cancelled, or is missing counts as a failure, so a run
whose scheduled maintenance never succeeds cannot certify. The contract's
`expectedPooledSteadyAttemptsPerLane` table lists only the latency populations.
Latency percentiles still use successful hook, search, and store samples.

When an operation fails, each machine appends a bounded, redacted record to its
private `failures.ndjson`: exit code or signal, error message, stdout and stderr
summaries, and process timing. Redaction masks whole secret-bearing environment
values, the bare and URL-decoded password of any credential URL, credential query
parameters, and the file-backed daemon token, longest value first, then truncates
the text. Whole environment values shorter than eight characters are left alone;
derived components are masked at any length. Admission overflow, a deadline that
elapsed before admission, and an operation that returned only after its absolute
deadline also get one record each, without fabricated exit scalars or process
timing. A fatal schedule abort reaches waiting attempts in two ways: an attempt
still waiting for its scheduled offset returns a `cancelled` sample with
`AdmissionAborted` and no failure record, because it never entered admission; an
attempt already queued inside admission observes the abort as a `failed` sample with
`AdmissionAborted` plus one private record whose exit scalars and process timing
are null. Only the error class, exit code, and signal reach `samples.ndjson`; the
gate never reads `failures.ndjson`.

The acknowledgment metric is a conservative upper bound from successful public
hook-command exit to the first one-second observer sighting of a terminal local
acknowledgment. It does not claim the exact PostgreSQL `applied_at` time. The
duplicate gate covers only distinct acknowledged inbox IDs observed for the same
captured event ID. It does not prove historical exactly-once logical effects.
Hook timing uses the public CLI process spawn-to-exit boundary. Search and store
timing use the elapsed authenticated daemon HTTP request to `/search` or `/store`,
including its request/response transport; both use the same daemon routes as the
public commands, not a private in-process storage seam. Queue delay, schedule
delay, SQLite capture, and observer delay are recorded separately.
The synthetic `TaskCreate` fixture proves the compatibility-tool extraction path;
it is not evidence of native Codex task-tool integration.

Each machine's observer reads its local events database once per second with a
bounded read-only query. A poll is incomplete only when the read fails, the gap
since the previous poll exceeds two seconds, or the database file or its parent
directory is replaced. Whether the `-wal` and `-shm` siblings exist is recorded
as a diagnostic only, because SQLite removes them when its last connection closes
cleanly.

One local and one managed repetition provide a bounded baseline. They do not
certify provider reliability, independent host clocks, multi-host hardware
failure, long-term capacity, provider failover, backup/PITR, or every downstream
drill. Measured latencies describe the execution host (laptop or testbox VM)
recorded in the host witness, not any other hardware class. A failed threshold is a
valid `fail`; missing or insufficient evidence is
`incomplete`. A definite failure takes precedence when both are present.
