#!/usr/bin/env bash
# Real launchd integration for the macos-launchd CI job. Every input arrives
# through LCM_LAUNCHD_* environment variables set by the workflow.
set -Eeuo pipefail
resource_root="$LCM_LAUNCHD_RESOURCE_ROOT"
label="$LCM_LAUNCHD_LABEL"
ready_file="$resource_root/launchd.label"
out_file="$resource_root/launchd.out"
# Current-run evidence binds every launchd artifact to this workflow
# run and to nothing else. A fresh unpredictable UUID is generated
# here and passed to the integration worker exclusively through the
# environment, never logged or echoed. The worker must prove current
# run ownership by writing one 0600 marker whose content is exactly
# "<uuid> <derived-product-label>". A stale or planted marker cannot
# know this fresh token, so it cannot satisfy the trap or the
# post-run validation.
evidence_token="$(uuidgen)"
export LCM_LAUNCHD_EVIDENCE_TOKEN="$evidence_token"
# No current-run evidence is trusted until it is validated below.
validated_ready_label=""
cleanup() {
  set +e
  if [[ -f "$ready_file" ]]; then
    ready_line="$(<"$ready_file")"
    ready_token="${ready_line%% *}"
    ready_label="${ready_line#* }"
    # Bootout is authorized only when the marker was written by this
    # current workflow run (fresh token match) and carries the exact
    # validated derived product label admitted below. Any stale,
    # replanted, malformed, or manifest-mismatched marker refuses to
    # bootout and never falls back to a broad label sweep or a
    # native/PID kill.
    if [[ -z "$ready_token" || -z "$ready_label" || "$ready_line" != "$ready_token $ready_label" ]]; then
      echo "Refusing cleanup for malformed launchd evidence marker" >&2
    elif [[ "$ready_token" == "$evidence_token" \
      && "$ready_line" == "$evidence_token $validated_ready_label" \
      && "$ready_label" == "$validated_ready_label" \
      && "$ready_label" =~ ^com\.donadiosolutions\.lcm\.daemon\.[0-9a-f]{20}$ \
      && "$(stat -f '%Lp' "$ready_file" 2>/dev/null)" == "600" ]]; then
      launchctl bootout "gui/$(id -u)/$ready_label" || true
    else
      echo "Refusing cleanup for unexpected launchd label: $ready_label" >&2
    fi
  fi
  rm -rf -- "$resource_root"
}
trap cleanup EXIT
# Fail closed on any pre-existing launchd evidence. The run-scoped
# root must start empty so a leftover marker or trapped output from an
# earlier retry cannot be inherited as this run's proof.
rm -rf -- "$resource_root"
mkdir -p -- "$resource_root"
chmod 0700 "$resource_root"
pnpm exec vitest run test/daemon/lifecycle-launchd.integration.test.ts 2>&1 \
  | tee "$out_file"
# After the worker exits, the marker must hold the exact current-run
# evidence and the single derived product label, or nothing is
# trusted for cleanup and the job fails hard.
if [[ ! -f "$ready_file" ]]; then
  echo "launchd integration produced no fresh current-run marker (missing: $ready_file)" >&2
  exit 1
fi
ready_line="$(<"$ready_file")"
ready_token="${ready_line%% *}"
ready_label="${ready_line#* }"
if [[ -z "$ready_token" || -z "$ready_label" || "$ready_line" != "$ready_token $ready_label" ]]; then
  echo "launchd integration marker must contain exactly one current-run token and one derived product label" >&2
  exit 1
fi
if [[ "$ready_token" != "$evidence_token" ]]; then
  echo "launchd integration marker does not carry the current run evidence token" >&2
  exit 1
fi
if [[ ! "$ready_label" =~ ^com\.donadiosolutions\.lcm\.[A-Za-z0-9.-]+$ ]]; then
  echo "launchd integration did not derive a validated scoped product label: $ready_label" >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$ready_file" 2>/dev/null)" != "600" ]]; then
  echo "launchd integration marker does not have mode 0600" >&2
  exit 1
fi
if [[ "$ready_label" == "$label" ]]; then
  # The derived product label can never be this run's static CI
  # manifest label; an equality gate here would make cleanup dead by
  # construction, so we reject it instead.
  echo "launchd integration derived product label must not equal the CI manifest label" >&2
  exit 1
fi
if [[ ! "$ready_label" =~ ^com\.donadiosolutions\.lcm\.daemon\.[0-9a-f]{20}$ ]]; then
  echo "launchd integration derived product label must match the exact run-owned daemon identity" >&2
  exit 1
fi
# Ownership proven by the token plus the derived product label; only
# now may the EXIT trap consider a bootout on failure teardown.
validated_ready_label="$ready_label"
# Parse only a fresh normalized copy. Strip only CSI SGR sequences;
# any other escape or C0 control byte remains evidence corruption.
normalized_out_file="$resource_root/launchd.normalized.out"
LC_ALL=C sed $'s/\033\\[[0-9;]*m//g' "$out_file" > "$normalized_out_file"
if LC_ALL=C od -An -v -tu1 "$normalized_out_file" | awk '
  {
    for (i = 1; i <= NF; i++) {
      if ($i <= 8 || ($i >= 11 && $i <= 31) || $i == 127) {
        found = 1
      }
    }
  }
  END {
    if (found) {
      exit 0
    }
    exit 1
  }
'
then
  echo "launchd integration output contains residual ESC/C0 control bytes" >&2
  exit 1
fi
# Fail hard when the fresh output does not contain exactly one
# unambiguous Vitest Tests summary. Never select a first match from
# duplicate or ambiguous evidence.
tests_summary_count="$(LC_ALL=C grep -Ec '^[[:space:]]*Tests([[:space:]]|$)' "$normalized_out_file" || true)"
if [[ "$tests_summary_count" != "1" ]]; then
  echo "launchd integration requires exactly one Tests summary (count=$tests_summary_count)" >&2
  exit 1
fi
tests_summary="$(LC_ALL=C grep -E '^[[:space:]]*Tests([[:space:]]|$)' "$normalized_out_file")"
tests_summary_pattern='^[[:space:]]*Tests[[:space:]]+[[:digit:]]+[[:space:]]+(passed|skipped)([[:space:]]*\|[[:space:]]+[[:digit:]]+[[:space:]]+(passed|skipped))*[[:space:]]+\([[:digit:]]+\)[[:space:]]*$'
if [[ ! "$tests_summary" =~ $tests_summary_pattern ]]; then
  echo "launchd integration produced an ambiguous Tests summary" >&2
  exit 1
fi
passed_match_count="$(printf '%s\n' "$tests_summary" | LC_ALL=C grep -oE '[[:digit:]]+[[:space:]]+passed' | awk 'END { print NR + 0 }' || true)"
skipped_match_count="$(printf '%s\n' "$tests_summary" | LC_ALL=C grep -oE '[[:digit:]]+[[:space:]]+skipped' | awk 'END { print NR + 0 }' || true)"
if [[ "$passed_match_count" != "1" || "$skipped_match_count" -gt 1 ]]; then
  echo "launchd integration produced ambiguous passed/skipped counts" >&2
  exit 1
fi
if [[ "$tests_summary" =~ ([[:digit:]]+)[[:space:]]+passed ]]; then
  passed_count="${BASH_REMATCH[1]}"
else
  passed_count=""
fi
skipped_count=0
if [[ "$tests_summary" =~ ([[:digit:]]+)[[:space:]]+skipped ]]; then
  skipped_count="${BASH_REMATCH[1]}"
fi
if [[ "${skipped_count:-0}" != "0" || "${passed_count:-0}" == "0" || -z "${passed_count:-}" ]]; then
  echo "launchd integration produced no current-run passed evidence (skipped=${skipped_count:-0} passed=${passed_count:-0})" >&2
  exit 1
fi
# The integration emits exactly one fixed, bounded sentinel only
# after a child has answered exact health through launchd. This is
# fresh manager activity evidence, not a test-name or credential
# echo, and duplicate/missing sentinels fail closed.
sentinel_count="$(LC_ALL=C grep -c '^launchd-user$' "$normalized_out_file" || true)"
if [[ "$sentinel_count" != "1" ]]; then
  echo "launchd integration produced no single manager-activity sentinel (count=$sentinel_count)" >&2
  exit 1
fi
