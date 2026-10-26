# Production certification harness

The production certification harness runs one frozen workload from two isolated
LCM machine identities against PostgreSQL 18. It records the exact contract,
machine identities, scheduled attempts, operation samples, fault steps, cleanup
witnesses, and SLO calculations needed to reproduce a gate decision.

The committed contract starts in `draft` status. The harness refuses to collect
evidence until a maintainer changes it to `approved` and fills in `approvedBy`,
`approvedAt`, and `approvalRef`. Freeze that approval before running either lane.
Changing the contract afterward changes its SHA-256 and invalidates prior gate
evidence.

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
the complete staged tree. This candidate deliberately does not run a build because
the current `postbuild` includes a command prohibited by the repository's local
execution rules.

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
database, network, volume, and two machine containers under one run identity. A
`finally` block removes the machine containers, and the enclosing PostgreSQL
harness verifies that all owned resources and private roots are gone.

## Run the managed lane

Managed execution is authorized separately because it creates a billable provider
resource. Supply the token only through a regular mode-0600 file outside the
repository. Supply a canonical public IPv4 address for the single firewall rule
and private paths for the created-ID receipt and evidence:

```bash
LCM_CERT_DIGITALOCEAN_TOKEN_FILE=/absolute/private/do-token \
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

Normal errors and termination enter owned cleanup. `SIGKILL`, host loss, or a lost
network cannot guarantee that in-process cleanup ran. Use the private created-ID
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

The gate writer imports the cutover rehearsal's provenance capture and schema
validator, derives every population from raw machine records, and refuses missing
readiness, observer, drain, fault, cleanup, contract, or sample evidence.

The acknowledgment metric is a conservative upper bound from successful public
hook-command exit to the first one-second observer sighting of a terminal local
acknowledgment. It does not claim the exact PostgreSQL `applied_at` time. The
duplicate gate covers only distinct acknowledged inbox IDs observed for the same
captured event ID. It does not prove historical exactly-once logical effects.

One local and one managed repetition provide a bounded baseline. They do not
certify provider reliability, independent host clocks, multi-host hardware
failure, long-term capacity, provider failover, backup/PITR, or every downstream
drill. A failed threshold is a valid `fail`; missing or insufficient evidence is
`incomplete`. A definite failure takes precedence when both are present.
