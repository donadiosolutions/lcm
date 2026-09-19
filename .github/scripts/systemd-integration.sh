#!/usr/bin/env bash
# Real user-systemd integration for the linux-systemd CI job. Every input
# arrives through LCM_* environment variables set by the workflow.
set -Eeuo pipefail
barrier_dir="$LCM_LIFECYCLE_SYSTEMD_BARRIER_DIR"
runtime_root="$LCM_RUNTIME_PATHS_SYSTEMD_RUN_ROOT"
sudo install -d -o root -g root -m 1777 -- "$runtime_root"
cleanup() {
  set +e
  if [[ -d "$barrier_dir" ]]; then
    while IFS= read -r marker; do
      [[ -f "$marker" ]] || continue
      unit_name="$(node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.unitName ?? "");' "$marker" 2>/dev/null)"
      if [[ "$unit_name" =~ ^lcm-daemon-[0-9a-f]{20}\.service$ ]]; then
        systemctl --user stop "$unit_name" || true
        systemctl --user reset-failed "$unit_name" || true
      else
        echo "Refusing cleanup for unexpected systemd unit: $unit_name" >&2
      fi
    done < <(find "$barrier_dir" -maxdepth 1 -type f -name '*.ready' -print)
    rm -rf -- "$barrier_dir"
  fi
  if [[ -d "$runtime_root" ]]; then
    sudo rm -rf -- "$runtime_root"
  fi
}
trap cleanup EXIT
systemd_state="$(systemctl --user is-system-running || true)"
case "$systemd_state" in
  running|degraded) ;;
  *) echo "Unexpected user-systemd state: $systemd_state" >&2; exit 1 ;;
esac
pnpm exec vitest run \
  test/daemon/lifecycle-isolation.test.ts \
  test/daemon/lifecycle-systemd.integration.test.ts \
  test/daemon/systemd-credential-loader.test.ts \
  --testNamePattern "uses and removes one exact run-owned transient unit|starts and admits a healthy managed unit with exact identity and cleanup|restarts a wedged registered unit through systemd without legacy signal fallback|recreates a terminal clean-exit unit after a registered-not-running observation|refuses stale manager identity before mutation and never falls back to legacy signals|refuses clean-environment drift before admitting an existing unit"
pnpm exec vitest run test/runtime-paths-systemd.integration.test.ts
pnpm exec vitest run \
  test/daemon/systemd-credential-loader.test.ts \
  --testNamePattern "observes the real user-systemd LoadCredential modes"
