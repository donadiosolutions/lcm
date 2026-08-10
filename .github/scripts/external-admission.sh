#!/usr/bin/env bash
set -Eeuo pipefail

HEAD_SHA="${EVENT_HEAD_SHA,,}"
if [[ ! "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid pull request head SHA." >&2
  exit 1
fi

EVENT_SOURCE="${EVENT_SOURCE:-}"
EVENT_WORKFLOW_RUN_ACTION="${EVENT_WORKFLOW_RUN_ACTION:-}"
EVENT_WORKFLOW_RUN_ID="${EVENT_WORKFLOW_RUN_ID:-}"
EVENT_CHECK_RUN_ACTION="${EVENT_CHECK_RUN_ACTION:-}"
EVENT_CHECK_RUN_ID="${EVENT_CHECK_RUN_ID:-}"

declare -A BASE_BRANCH_CACHE=()
BASE_BRANCH_RESULT=""
PULL_REQUEST_EVALUATION=""

reset_base_branch_cache() {
  BASE_BRANCH_CACHE=()
}

fetch_base_branch() {
  local base_ref="$1"
  local encoded_ref response response_status request_status body result
  if [[ ${BASE_BRANCH_CACHE[$base_ref]+_} ]]; then
    BASE_BRANCH_RESULT="${BASE_BRANCH_CACHE[$base_ref]}"
    printf '%s\n' "${BASE_BRANCH_CACHE[$base_ref]}"
    return 0
  fi
  encoded_ref="$(jq -rn --arg value "$base_ref" '$value|@uri')"
  if response="$(gh api --include -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/branches/$encoded_ref" 2>/dev/null)"; then
    request_status=0
  else
    request_status=$?
  fi

  response_status="$(awk '$1 ~ /^HTTP\// { status = $2 } END { print status }' <<<"$response")"
  if [[ -z "$response_status" ]]; then
    if (( request_status != 0 )); then
      result='{"outcome":"transient-base-api"}'
    else
      body="$response"
      if jq -e 'type == "object" and (.protected | type == "boolean")' <<<"$body" >/dev/null 2>&1; then
        result="$(jq -c '{outcome:"branch",protected:.protected}' <<<"$body")"
      else
        result='{"outcome":"terminal-base-api"}'
      fi
    fi
  elif [[ "$response_status" == 404 ]]; then
    result='{"outcome":"deleted-base"}'
  elif (( response_status == 429 || response_status >= 500 )) \
    || [[ "$response_status" == 403 && "$response" =~ [Rr]ate[-_][Ll]imit|[Xx]-[Rr]atelimit-[Rr]emaining:[[:space:]]*0 ]]; then
    result='{"outcome":"transient-base-api"}'
  elif (( response_status >= 200 && response_status < 300 && request_status == 0 )); then
    body="$(awk 'BEGIN { body = 0 } { sub(/\r$/, ""); if (body) print; else if ($0 == "") body = 1 }' <<<"$response")"
    if jq -e 'type == "object" and (.protected | type == "boolean")' <<<"$body" >/dev/null 2>&1; then
      result="$(jq -c '{outcome:"branch",protected:.protected}' <<<"$body")"
    else
      result='{"outcome":"terminal-base-api"}'
    fi
  else
    result='{"outcome":"terminal-base-api"}'
  fi

  BASE_BRANCH_CACHE["$base_ref"]="$result"
  BASE_BRANCH_RESULT="$result"
  printf '%s\n' "$result"
}

evaluate_pull_request() {
  local pull_request="$1"
  local base_ref branch branch_outcome protected preflight_evaluation preflight_reason
  preflight_evaluation="$(node .github/scripts/external-admission-policy.mjs evaluate-pr \
    "$HEAD_SHA" "$REPOSITORY" false <<<"$pull_request")" || return $?
  preflight_reason="$(jq -r '.reason // empty' <<<"$preflight_evaluation")" || return $?
  case "$preflight_reason" in
    ineligible-pr|repository-mismatch|unsupported-base)
      PULL_REQUEST_EVALUATION="$preflight_evaluation"
      printf '%s\n' "$preflight_evaluation"
      return 0
      ;;
    unprotected-base)
      ;;
    *)
      echo "Invalid pull request preflight evaluation." >&2
      return 1
      ;;
  esac

  base_ref="$(jq -r '.base.ref // empty' <<<"$pull_request")" || return $?
  fetch_base_branch "$base_ref" >/dev/null || return $?
  branch="$BASE_BRANCH_RESULT"
  branch_outcome="$(jq -r '.outcome // empty' <<<"$branch")" || return $?
  case "$branch_outcome" in
    deleted-base)
      PULL_REQUEST_EVALUATION='{"eligible":false,"reason":"deleted-base"}'
      printf '%s\n' '{"eligible":false,"reason":"deleted-base"}'
      return 0
      ;;
    transient-base-api)
      PULL_REQUEST_EVALUATION='{"eligible":false,"reason":"transient-base-api"}'
      printf '%s\n' '{"eligible":false,"reason":"transient-base-api"}'
      return 0
      ;;
    terminal-base-api)
      PULL_REQUEST_EVALUATION='{"eligible":false,"reason":"terminal-base-api"}'
      printf '%s\n' '{"eligible":false,"reason":"terminal-base-api"}'
      return 0
      ;;
    branch)
      protected="$(jq -r '.protected == true' <<<"$branch")" || return $?
      ;;
    *)
      echo "Invalid base branch evaluation." >&2
      return 1
      ;;
  esac
  PULL_REQUEST_EVALUATION="$(node .github/scripts/external-admission-policy.mjs evaluate-pr \
    "$HEAD_SHA" "$REPOSITORY" "$protected" <<<"$pull_request")" || return $?
  printf '%s\n' "$PULL_REQUEST_EVALUATION"
}

resolve_eligible_pr_number() {
  local pull_requests="$1"
  local pull_request pull_request_number evaluation eligible reason
  local eligible_number=""
  local eligible_count=0
  local transient_count=0
  local terminal_count=0
  local pull_request_entries

  reset_base_branch_cache
  pull_request_entries="$(jq -c '.[]' <<<"$pull_requests")" || return $?
  while IFS= read -r pull_request; do
    [[ -n "$pull_request" ]] || continue
    pull_request_number="$(jq -r '.number // empty' <<<"$pull_request")" || return $?
    [[ -n "$pull_request_number" ]] || continue
    evaluate_pull_request "$pull_request" >/dev/null || return $?
    evaluation="$PULL_REQUEST_EVALUATION"
    eligible="$(jq -r '.eligible' <<<"$evaluation")" || return $?
    reason="$(jq -r '.reason // empty' <<<"$evaluation")" || return $?
    if [[ "$reason" == transient-base-api ]]; then
      transient_count=$((transient_count + 1))
      continue
    fi
    if [[ "$reason" == terminal-base-api ]]; then
      terminal_count=$((terminal_count + 1))
      continue
    fi
    if [[ "$eligible" == true ]]; then
      eligible_number="$pull_request_number"
      eligible_count=$((eligible_count + 1))
    fi
  done <<<"$pull_request_entries"

  if (( terminal_count > 0 )); then
    printf '%s\n' '{"outcome":"terminal-base-api"}'
  elif (( transient_count > 0 )); then
    printf '%s\n' '{"outcome":"transient-base-api"}'
  elif (( eligible_count == 1 )); then
    jq -cn --arg number "$eligible_number" '{outcome:"eligible",number:$number}'
  else
    printf '%s\n' '{"outcome":"none"}'
  fi
}

select_eligible_pr_number() {
  local pull_requests="$1"
  local resolution outcome
  resolution="$(resolve_eligible_pr_number "$pull_requests")"
  outcome="$(jq -r '.outcome // empty' <<<"$resolution")"
  case "$outcome" in
    eligible)
      PR_NUMBER="$(jq -r '.number' <<<"$resolution")"
      ;;
    transient-base-api)
      exit_pending \
        "Base branch protection is temporarily unavailable" \
        "Base branch protection lookup was transient; admission remains pending."
      ;;
    terminal-base-api)
      exit_failure \
        "External admission policy or API failure" \
        "Base branch protection response was invalid; admission failed."
      ;;
    none)
      exit_failure \
        "Pull request is not uniquely eligible for admission" \
        "CI/DCO admission result does not identify exactly one eligible pull request; admission failed."
      ;;
    *)
      echo "Invalid pull request resolution." >&2
      return 1
      ;;
  esac
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

evaluate_event_freshness() {
  local ci_run_id="$1"
  local dco_check_run_id="$2"
  node .github/scripts/external-admission-policy.mjs evaluate-freshness \
    "$EVENT_SOURCE" \
    "$EVENT_WORKFLOW_RUN_ACTION" \
    "$EVENT_WORKFLOW_RUN_ID" \
    "$EVENT_CHECK_RUN_ACTION" \
    "$EVENT_CHECK_RUN_ID" \
    "$ci_run_id" \
    "$dco_check_run_id" <<< '{}'
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

exit_failure() {
  local description="$1"
  local message="$2"
  if ! post_admission_status failure "$description"; then
    echo "Failed to publish terminal external admission failure." >&2
    trap - EXIT INT TERM
    exit 1
  fi
  echo "$message"
  trap - EXIT INT TERM
  exit 0
}

validate_required_snapshot() {
  local phase="$1"
  local fingerprint_variable="$2"
  local check_run_pages evaluation check_states terminal_failure checks_ready ci_check_run_id dco_check_run_id ci_run_id
  local ci_run ci_evaluation
  local ci_terminal_failure ci_ready ci_state freshness freshness_pending freshness_failure

  check_run_pages="$(gh api --paginate --slurp \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100")"
  evaluation="$(evaluate_check_runs <<<"$check_run_pages")"
  check_states="$(jq -c '.states' <<<"$evaluation")"
  echo "$phase check states: $check_states"

  ci_check_run_id="$(jq -r '.ciCheckRunId // empty' <<<"$evaluation")"
  dco_check_run_id="$(jq -r '.dcoCheckRunId // empty' <<<"$evaluation")"
  ci_run_id="$(jq -r '.ciRunId // empty' <<<"$evaluation")"
  terminal_failure="$(jq -r '.terminalFailure // empty' <<<"$evaluation")"
  if [[ -n "$terminal_failure" ]]; then
    echo "$phase required check reported an invalid or terminal state: $terminal_failure" >&2
    return 2
  fi
  if [[ "$EVENT_SOURCE" == workflow_run && -n "$EVENT_WORKFLOW_RUN_ID" ]]; then
    echo "$phase workflow event ID $EVENT_WORKFLOW_RUN_ID is wake-up context only and does not authorize state; canonical CI evidence is evaluated separately." >&2
  fi
  freshness="$(evaluate_event_freshness "$ci_run_id" "$dco_check_run_id")" || return $?
  freshness_failure="$(jq -r '.terminalFailure // empty' <<<"$freshness")"
  if [[ -n "$freshness_failure" ]]; then
    echo "$phase event freshness metadata is invalid: $freshness_failure" >&2
    return 2
  fi
  freshness_pending="$(jq -r '.pending // false' <<<"$freshness")"
  if [[ "$freshness_pending" == true ]]; then
    exit_pending \
      "Waiting for current trusted event evidence" \
      "$phase trusted event is newer than visible evidence; admission remains pending."
  fi
  checks_ready="$(jq -r '.ready' <<<"$evaluation")"
  if [[ "$checks_ready" != true ]]; then
    exit_pending \
      "Waiting for trusted CI and DCO" \
      "$phase required checks are incomplete; admission remains pending."
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
select_eligible_pr_number "$matching_prs"
admitted_pr_number="$PR_NUMBER"

reset_base_branch_cache
pull_request="$(fetch_pull_request "$PR_NUMBER")"
evaluate_pull_request "$pull_request" >/dev/null
pull_request_evaluation="$PULL_REQUEST_EVALUATION"
pull_request_eligible="$(jq -r '.eligible' <<<"$pull_request_evaluation")"
if [[ "$pull_request_eligible" != true ]]; then
  exit_failure \
    "Pull request is not uniquely eligible for admission" \
    "Pull request is no longer eligible for admission; admission failed."
fi

post_admission_status pending "Waiting for trusted CI and DCO"
initial_admission_fingerprint=""
validate_required_snapshot "Initial" initial_admission_fingerprint

current_matching_prs="$(fetch_associated_pull_requests)"
select_eligible_pr_number "$current_matching_prs"
current_pr_number="$PR_NUMBER"
if [[ "$current_pr_number" != "$admitted_pr_number" ]]; then
  exit_failure \
    "Pull request is not uniquely eligible for admission" \
    "Pull request eligibility changed during evaluation; admission failed."
fi
reset_base_branch_cache
current_pull_request="$(fetch_pull_request "$current_pr_number")"
evaluate_pull_request "$current_pull_request" >/dev/null
current_pull_request_evaluation="$PULL_REQUEST_EVALUATION"
current_pull_request_eligible="$(jq -r '.eligible' <<<"$current_pull_request_evaluation")"
if [[ "$current_pull_request_eligible" != true ]]; then
  exit_failure \
    "Pull request is not uniquely eligible for admission" \
    "Pull request eligibility changed during evaluation; admission failed."
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
select_eligible_pr_number "$final_matching_prs"
final_pr_number="$PR_NUMBER"
if [[ "$final_pr_number" != "$admitted_pr_number" ]]; then
  exit_failure \
    "Pull request is not uniquely eligible for admission" \
    "Final pull request association changed; admission failed."
fi
reset_base_branch_cache
final_pull_request="$(fetch_pull_request "$final_pr_number")"
evaluate_pull_request "$final_pull_request" >/dev/null
final_pull_request_evaluation="$PULL_REQUEST_EVALUATION"
final_pull_request_eligible="$(jq -r '.eligible' <<<"$final_pull_request_evaluation")"
if [[ "$final_pull_request_eligible" != true ]]; then
  exit_failure \
    "Pull request is not uniquely eligible for admission" \
    "Final pull request eligibility changed; admission failed."
fi

post_admission_status success "CI and DCO passed"
trap - EXIT INT TERM
