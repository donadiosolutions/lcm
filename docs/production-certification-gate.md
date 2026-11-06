# Production certification gate

Overall verdict: **pass**

Contract SHA-256: `ea6ccaaa77212c3c7486cdc85af03a985dde05eeef18096a4511163d0f490839`
Lane/profile: `local` / `full`

## Execution host

OS: ubuntu 24.04; kernel 6.6.141; x64
CPU: AMD EPYC (8 logical); memory 30.9 GiB
Container engine: podman 5.8.4
Hostname SHA-256: `7b2ddfbac651b79f22d776902feb802fe2937e57dfe173c77322f0e2802ace32`
Runner: name n/a; os n/a; arch n/a; SKU blacksmith-8vcpu-ubuntu-2404

## Observer reads

Poll every 1 s; SQLite busy timeout 200 ms; per-query deadline 250 ms; maximum poll gap 2 s

SLO | Verdict | Observed | Threshold
--- | --- | ---: | ---:
hook-command.p50 | pass | 296.224492 | 600
hook-command.p95 | pass | 728.641059 | 1500
hook-command.p99 | pass | 930.481244 | 2500
daemon-search.p50 | pass | 15.576831 | 100
daemon-search.p95 | pass | 34.346574 | 500
daemon-search.p99 | pass | 108.435496 | 1500
daemon-store.p50 | pass | 50.284752 | 100
daemon-store.p95 | pass | 78.538033 | 500
daemon-store.p99 | pass | 96.533049 | 1500
profile-certifying | pass | 1 | 1
phase-barriers | pass | 2 | 2
scheduled-attempt-identity | pass | 0 | 0
readiness | pass | 1 | 1
final-drain | pass | 0 | 0
hook-command.user-prompt.p95 | pass | 922.674938 | 1500
hook-command.post-tool.p95 | pass | 397.06013 | 1500
hook-command.machine-a.p95 | pass | 740.525388 | 1500
hook-command.machine-b.p95 | pass | 717.609978 | 1500
non-injected-error-rate | pass | 0 | 0.001
acknowledgment-lag.p99 | pass | 299.148878015 | 660
acknowledgment-lag.max | pass | 300.089461253 | 900
oracle-capture-bijection | pass | 0 | 0
event-loss | pass | 0 | 0
observed-duplicate-inbox-ids | pass | 0 | 0
observer-completeness | pass | 0 | 0
clock-interval-radius | pass | 134.5 | 250
capacity | pass | 5 | 19
lane-fault-set | pass | 2 | 2
recovery.partition-a | pass | 120.265 | 180
recovery.restart-database | pass | 60.325 | 240

Cleanup: **pass** (0 residual resources)
