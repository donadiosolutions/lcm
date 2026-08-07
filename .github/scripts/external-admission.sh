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

pull_request_eligibility() {
  jq -r --arg sha "$HEAD_SHA" '
    if (
      .state == "open" and
      .draft == false and
      .base.ref == "main" and
      .head.sha == $sha
    ) then "true" else "false" end
  '
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

exit_pending() {
  if ! post_admission_status pending "$1"; then
    echo "Failed to publish pending external admission status." >&2
    exit 1
  fi
  echo "$2"
  trap - EXIT INT TERM
  exit 0
}

validate_required_snapshot() {
  local phase="$1"
  local fingerprint_variable="$2"
  local check_run_pages evaluation check_states terminal_failure checks_ready ci_check_run_id dco_check_run_id ci_run_id
  local ci_run ci_evaluation
  local ci_terminal_failure ci_ready ci_state

  check_run_pages="$(gh api --paginate --slurp \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100")"
  evaluation="$(evaluate_check_runs <<<"$check_run_pages")"
  check_states="$(jq -c '.states' <<<"$evaluation")"
  echo "$phase check states: $check_states"

  terminal_failure="$(jq -r '.terminalFailure // empty' <<<"$evaluation")"
  if [[ -n "$terminal_failure" ]]; then
    echo "$phase required check reported an invalid or terminal state: $terminal_failure" >&2
    return 2
  fi
  checks_ready="$(jq -r '.ready' <<<"$evaluation")"
  if [[ "$checks_ready" != true ]]; then
    exit_pending \
      "Waiting for trusted CI and DCO" \
      "$phase required checks are incomplete; admission remains pending."
  fi

  ci_check_run_id="$(jq -r '.ciCheckRunId' <<<"$evaluation")"
  dco_check_run_id="$(jq -r '.dcoCheckRunId' <<<"$evaluation")"
  ci_run_id="$(jq -r '.ciRunId' <<<"$evaluation")"
  if [[ "$EVENT_SOURCE" == workflow_run && "$EVENT_WORKFLOW_RUN_ID" != "$ci_run_id" ]]; then
    exit_pending \
      "Completed CI event does not match the latest aggregate check" \
      "$phase CI event run $EVENT_WORKFLOW_RUN_ID does not match latest run $ci_run_id; admission remains pending."
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
  ci_ready="$(jq -r '.ready' <<<"$ci_evaluation")"
  if [[ "$ci_ready" != true ]]; then
    ci_state="$(jq -r '.state' <<<"$ci_evaluation")"
    exit_pending \
      "Backing CI workflow is not terminally successful" \
      "$phase CI workflow run is $ci_state; admission remains pending."
  fi

  printf -v "$fingerprint_variable" '%s' "$ci_check_run_id:$dco_check_run_id:$ci_run_id"
  return 0
}

matching_prs="$(fetch_associated_pull_requests)"
PR_NUMBER="$(resolve_eligible_pr_number <<<"$matching_prs")"
if [[ -z "$PR_NUMBER" ]]; then
  echo "CI/DCO admission result does not identify exactly one eligible pull request; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi

pull_request="$(fetch_pull_request "$PR_NUMBER")"
pull_request_eligible="$(pull_request_eligibility <<<"$pull_request")"
if [[ "$pull_request_eligible" != true ]]; then
  exit_pending \
    "Pull request is no longer eligible for admission" \
    "Pull request is no longer an eligible main-branch admission candidate; admission remains pending."
fi

post_admission_status pending "Waiting for trusted CI and DCO"
initial_admission_fingerprint=""
validate_required_snapshot "Initial" initial_admission_fingerprint

current_matching_prs="$(fetch_associated_pull_requests)"
current_pr_number="$(resolve_eligible_pr_number <<<"$current_matching_prs")"
if [[ "$current_pr_number" != "$PR_NUMBER" ]]; then
  exit_pending \
    "Pull request is no longer uniquely eligible for admission" \
    "Pull request eligibility changed during evaluation; admission remains pending."
fi
current_pull_request="$(fetch_pull_request "$current_pr_number")"
current_pull_request_eligible="$(pull_request_eligibility <<<"$current_pull_request")"
if [[ "$current_pull_request_eligible" != true ]]; then
  exit_pending \
    "Pull request is no longer eligible for admission" \
    "Pull request eligibility changed during evaluation; admission remains pending."
fi
current_admission_fingerprint=""
validate_required_snapshot "Current" current_admission_fingerprint
if [[ "$current_admission_fingerprint" != "$initial_admission_fingerprint" ]]; then
  exit_pending \
    "Latest trusted check changed during admission" \
    "Trusted CI or DCO check changed during evaluation; admission remains pending."
fi

final_admission_fingerprint=""
validate_required_snapshot "Final" final_admission_fingerprint
if [[ "$final_admission_fingerprint" != "$initial_admission_fingerprint" ]]; then
  exit_pending \
    "Latest trusted check changed during final validation" \
    "Final trusted CI or DCO check changed during evaluation; admission remains pending."
fi

final_matching_prs="$(fetch_associated_pull_requests)"
final_pr_number="$(resolve_eligible_pr_number <<<"$final_matching_prs")"
if [[ "$final_pr_number" != "$PR_NUMBER" ]]; then
  exit_pending \
    "Pull request is no longer uniquely eligible for admission" \
    "Final pull request association changed; admission remains pending."
fi
final_pull_request="$(fetch_pull_request "$final_pr_number")"
final_pull_request_eligible="$(pull_request_eligibility <<<"$final_pull_request")"
if [[ "$final_pull_request_eligible" != true ]]; then
  exit_pending \
    "Pull request is no longer eligible for admission" \
    "Final pull request eligibility changed; admission remains pending."
fi

post_admission_status success "CI and DCO passed"
trap - EXIT INT TERM
