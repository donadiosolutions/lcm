# Production certification harness

The production certification harness runs one frozen workload from two isolated
LCM machine identities against PostgreSQL 18. It records the exact contract,
machine identities, scheduled attempts, operation samples, fault steps, cleanup
witnesses, and SLO calculations needed to reproduce a gate decision.

The committed contract remains byte-for-byte in `draft` status. Approval lives in
`test/certification/contract-v1.approval.json`, which names the approved contract
SHA-256, approver, approval time, and approval reference. The harness refuses to
collect evidence unless that hash matches the contract bytes, and evidence must
start at or after the approval time. Changing either file invalidates the binding;
changing the contract requires a new approval record.

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
  --contract "$PWD/test/certification/contract-v1.json" \
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

One local and one managed repetition provide a bounded baseline. They do not
certify provider reliability, independent host clocks, multi-host hardware
failure, long-term capacity, provider failover, backup/PITR, or every downstream
drill. A failed threshold is a valid `fail`; missing or insufficient evidence is
`incomplete`. A definite failure takes precedence when both are present.
