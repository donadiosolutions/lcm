#!/usr/bin/env bash
set -Eeuo pipefail

HEAD_SHA="${EVENT_HEAD_SHA,,}"
if [[ ! "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid pull request head SHA." >&2
  exit 1
fi

resolve_eligible_pr_number() {
  jq -r --arg sha "$HEAD_SHA" '
    [.[]
      | select(.state == "open")
      | select(.draft == false)
      | select(.base.ref == "main")
      | select(.head.sha == $sha)]
    | if length == 1 then .[0].number else empty end
  '
}

pull_request_is_eligible() {
  jq -e --arg sha "$HEAD_SHA" '
    .state == "open" and
    .draft == false and
    .base.ref == "main" and
    .head.sha == $sha
  ' >/dev/null
}

post_admission_status() {
  local state="$1"
  local description="$2"
  gh api --method POST \
    "repos/$REPOSITORY/statuses/$HEAD_SHA" \
    -f state="$state" \
    -f context="external-admission" \
    -f description="$description" \
    -f target_url="$RUN_URL" >/dev/null
}

fetch_associated_pull_requests() {
  gh api --paginate --slurp \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/commits/$HEAD_SHA/pulls?per_page=100" \
    | jq -c 'flatten(1)'
}

fetch_pull_request() {
  local pull_request_number="$1"
  gh api \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/pulls/$pull_request_number"
}

evaluate_check_runs() {
  node .github/scripts/external-admission-policy.mjs evaluate-checks \
    "$HEAD_SHA" "$REPOSITORY" "$SERVER_URL"
}

evaluate_ci_run() {
  local run_id="$1"
  node .github/scripts/external-admission-policy.mjs evaluate-ci-run \
    "$run_id" "$HEAD_SHA" "$REPOSITORY"
}

# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
admission_failed() {
  local exit_code=$?
  trap - EXIT
  if (( exit_code != 0 )); then
    post_admission_status failure \
      "External admission failed; inspect the workflow run" || true
  fi
  trap - INT TERM
  exit "$exit_code"
}

# GitHub cancels an obsolete concurrency-group run with INT, followed by TERM.
# Do not let its EXIT trap overwrite a newer exact-head admission result.
# shellcheck disable=SC2329
admission_cancelled() {
  local signal_name="$1"
  local exit_code="$2"
  trap - EXIT INT TERM
  echo "Run cancelled by $signal_name; leaving admission status unchanged."
  exit "$exit_code"
}
trap admission_failed EXIT
trap 'admission_cancelled INT 130' INT
trap 'admission_cancelled TERM 143' TERM

snapshot_incomplete() {
  if ! post_admission_status pending "$1"; then
    echo "Failed to publish pending external admission status." >&2
    return 2
  fi
  echo "$2"
  return 1
}

VALIDATED_ADMISSION_FINGERPRINT=""
validate_required_snapshot() {
  local phase="$1"
  local check_run_pages evaluation terminal_failure ci_check_run_id dco_check_run_id ci_run_id
  local ci_run ci_evaluation
  local ci_terminal_failure

  check_run_pages="$(gh api --paginate --slurp \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100")"
  evaluation="$(evaluate_check_runs <<<"$check_run_pages")"
  echo "$phase check states: $(jq -c '.states' <<<"$evaluation")"

  terminal_failure="$(jq -r '.terminalFailure // empty' <<<"$evaluation")"
  if [[ -n "$terminal_failure" ]]; then
    echo "$phase required check reported an invalid or terminal state: $terminal_failure" >&2
    return 2
  fi
  if [[ "$(jq -r '.ready' <<<"$evaluation")" != true ]]; then
    snapshot_incomplete \
      "Waiting for trusted CI and DCO" \
      "$phase required checks are incomplete; admission remains pending." || return $?
  fi

  ci_check_run_id="$(jq -r '.ciCheckRunId' <<<"$evaluation")"
  dco_check_run_id="$(jq -r '.dcoCheckRunId' <<<"$evaluation")"
  ci_run_id="$(jq -r '.ciRunId' <<<"$evaluation")"
  if [[ "$EVENT_SOURCE" == workflow_run && "$EVENT_WORKFLOW_RUN_ID" != "$ci_run_id" ]]; then
    snapshot_incomplete \
      "Completed CI event does not match the latest aggregate check" \
      "$phase CI event run $EVENT_WORKFLOW_RUN_ID does not match latest run $ci_run_id; admission remains pending." || return $?
  fi

  ci_run="$(gh api \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/actions/runs/$ci_run_id")"
  ci_evaluation="$(evaluate_ci_run "$ci_run_id" <<<"$ci_run")"
  ci_terminal_failure="$(jq -r '.terminalFailure // empty' <<<"$ci_evaluation")"
  if [[ -n "$ci_terminal_failure" ]]; then
    echo "$phase CI run $ci_run_id is not a successful canonical pull-request run: $ci_terminal_failure" >&2
    return 2
  fi
  if [[ "$(jq -r '.ready' <<<"$ci_evaluation")" != true ]]; then
    snapshot_incomplete \
      "Backing CI workflow is not terminally successful" \
      "$phase CI workflow run is $(jq -r '.state' <<<"$ci_evaluation"); admission remains pending." || return $?
  fi

  VALIDATED_ADMISSION_FINGERPRINT="$ci_check_run_id:$dco_check_run_id:$ci_run_id"
  return 0
}

validate_or_exit() {
  local phase="$1"
  local result=0
  validate_required_snapshot "$phase" || result=$?
  if (( result == 1 )); then
    trap - EXIT INT TERM
    exit 0
  fi
  if (( result != 0 )); then
    exit 1
  fi
}

snapshot_incomplete_or_exit() {
  local result=0
  snapshot_incomplete "$@" || result=$?
  if (( result == 1 )); then
    trap - EXIT INT TERM
    exit 0
  fi
  return "$result"
}

matching_prs="$(fetch_associated_pull_requests)"
PR_NUMBER="$(resolve_eligible_pr_number <<<"$matching_prs")"
if [[ -z "$PR_NUMBER" ]]; then
  echo "Provider result does not identify exactly one eligible pull request; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi

pull_request="$(fetch_pull_request "$PR_NUMBER")"
if ! pull_request_is_eligible <<<"$pull_request"; then
  echo "Pull request is no longer an eligible main-branch admission candidate; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi

post_admission_status pending "Waiting for trusted CI and DCO"
validate_or_exit "Initial"
initial_admission_fingerprint="$VALIDATED_ADMISSION_FINGERPRINT"

current_matching_prs="$(fetch_associated_pull_requests)"
current_pr_number="$(resolve_eligible_pr_number <<<"$current_matching_prs")"
if [[ "$current_pr_number" != "$PR_NUMBER" ]]; then
  snapshot_incomplete_or_exit \
    "Pull request is no longer uniquely eligible for admission" \
    "Pull request eligibility changed during evaluation; admission remains pending."
fi
current_pull_request="$(fetch_pull_request "$current_pr_number")"
if ! pull_request_is_eligible <<<"$current_pull_request"; then
  snapshot_incomplete_or_exit \
    "Pull request is no longer eligible for admission" \
    "Pull request eligibility changed during evaluation; admission remains pending."
fi
validate_or_exit "Current"
if [[ "$VALIDATED_ADMISSION_FINGERPRINT" != "$initial_admission_fingerprint" ]]; then
  snapshot_incomplete_or_exit \
    "Latest trusted check changed during admission" \
    "Trusted CI or DCO check changed during evaluation; admission remains pending."
fi

validate_or_exit "Final"
if [[ "$VALIDATED_ADMISSION_FINGERPRINT" != "$initial_admission_fingerprint" ]]; then
  snapshot_incomplete_or_exit \
    "Latest trusted check changed during final validation" \
    "Final trusted CI or DCO check changed during evaluation; admission remains pending."
fi

final_matching_prs="$(fetch_associated_pull_requests)"
final_pr_number="$(resolve_eligible_pr_number <<<"$final_matching_prs")"
if [[ "$final_pr_number" != "$PR_NUMBER" ]]; then
  snapshot_incomplete_or_exit \
    "Pull request is no longer uniquely eligible for admission" \
    "Final pull request association changed; admission remains pending."
fi
final_pull_request="$(fetch_pull_request "$final_pr_number")"
if ! pull_request_is_eligible <<<"$final_pull_request"; then
  snapshot_incomplete_or_exit \
    "Pull request is no longer eligible for admission" \
    "Final pull request eligibility changed; admission remains pending."
fi

post_admission_status success "CI and DCO passed"
trap - EXIT INT TERM
