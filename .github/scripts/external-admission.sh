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

fetch_pull_request_files() {
  local pull_request_number="$1"
  gh api --paginate --slurp \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/pulls/$pull_request_number/files?per_page=100"
}

classify_pull_request_files() {
  local expected_count="$1"
  node .github/scripts/external-admission-policy.mjs classify-files "$expected_count"
}

select_admission_requirement() {
  local sensitive_diff="$1"
  local changes_greptile_exclusion_policy="$2"
  node .github/scripts/external-admission-policy.mjs select-admission \
    "$sensitive_diff" "$changes_greptile_exclusion_policy" greptile.json
}

evaluate_check_runs() {
  local greptile_required="$1"
  node .github/scripts/external-admission-policy.mjs evaluate-checks \
    "$HEAD_SHA" "$greptile_required" "$REPOSITORY" "$SERVER_URL"
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

# GitHub cancels an obsolete concurrency-group run with INT, followed
# by TERM if needed. Do not let its EXIT trap publish a failure after
# the replacement run has published a newer status for the same SHA.
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

matching_prs="$(fetch_associated_pull_requests)"
PR_NUMBER="$(resolve_eligible_pr_number <<<"$matching_prs")"

if [[ -z "$PR_NUMBER" ]]; then
  echo "Provider result does not identify exactly one eligible pull request; admission remains pending."
  exit 0
fi

pull_request="$(gh api \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "repos/$REPOSITORY/pulls/$PR_NUMBER")"
if ! pull_request_is_eligible <<<"$pull_request"; then
  echo "Pull request is no longer an eligible main-branch admission candidate; admission remains pending."
  exit 0
fi

changed_file_count="$(jq -r '.changed_files' <<<"$pull_request")"
file_pages="$(fetch_pull_request_files "$PR_NUMBER")"
classification="$(classify_pull_request_files "$changed_file_count" <<<"$file_pages")"
sensitive_diff="$(jq -r '.greptileRequired' <<<"$classification")"
changes_greptile_exclusion_policy="$(
  jq -r '.matchedPaths | index("greptile.json") != null' <<<"$classification"
)"
admission_requirement="$(
  select_admission_requirement \
    "$sensitive_diff" "$changes_greptile_exclusion_policy" <<<"$pull_request"
)"
trusted_automation="$(jq -r '.trustedAutomation' <<<"$admission_requirement")"
greptile_required="$(jq -r '.greptileRequired' <<<"$admission_requirement")"
excluded_author_pattern="$(jq -r '.excludedAuthorPattern // empty' <<<"$admission_requirement")"
file_classification_name="$(jq -r '.classification' <<<"$classification")"
classification_name="$(jq -r '.classification' <<<"$admission_requirement")"
echo "Admission classification=$classification_name sensitive_diff=$sensitive_diff trusted_automation=$trusted_automation greptile_required=$greptile_required"

if [[ "$greptile_required" == true ]]; then
  waiting_description="Waiting for Greptile review and DCO"
  success_description="Greptile review and DCO passed"
elif [[ "$sensitive_diff" == true && "$trusted_automation" == true ]]; then
  waiting_description="Waiting for trusted CI and DCO for automated PR"
  success_description="CI and DCO passed for trusted automated PR"
else
  waiting_description="Waiting for trusted CI and DCO"
  success_description="CI and DCO passed for coverage-neutral diff"
fi
post_admission_status pending "$waiting_description"

check_run_pages="$(gh api --paginate --slurp \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "repos/$REPOSITORY/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100")"
evaluation="$(evaluate_check_runs "$greptile_required" <<<"$check_run_pages")"
echo "Check states: $(jq -c '.states' <<<"$evaluation")"

terminal_failure="$(jq -r '.terminalFailure // empty' <<<"$evaluation")"
if [[ -n "$terminal_failure" ]]; then
  echo "Required check reported an invalid or terminal state: $terminal_failure" >&2
  exit 1
fi
if [[ "$(jq -r '.ready' <<<"$evaluation")" != true ]]; then
  echo "Required checks are incomplete; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi

if [[ "$greptile_required" == false ]]; then
  ci_run_id="$(jq -r '.ciRunId' <<<"$evaluation")"
  if [[ "$EVENT_SOURCE" == workflow_run && "$EVENT_WORKFLOW_RUN_ID" != "$ci_run_id" ]]; then
    post_admission_status pending \
      "Completed CI event does not match the latest aggregate check"
    echo "Completed CI event run $EVENT_WORKFLOW_RUN_ID does not match latest run $ci_run_id; admission remains pending."
    trap - EXIT INT TERM
    exit 0
  fi
  ci_run="$(gh api \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/actions/runs/$ci_run_id")"
  ci_run_evaluation="$(evaluate_ci_run "$ci_run_id" <<<"$ci_run")"
  ci_run_terminal_failure="$(jq -r '.terminalFailure // empty' <<<"$ci_run_evaluation")"
  if [[ -n "$ci_run_terminal_failure" ]]; then
    echo "Successful CI check is not backed by a successful required pull-request workflow run; run $ci_run_id evaluated as $(jq -r '.state' <<<"$ci_run_evaluation"): $ci_run_terminal_failure" >&2
    exit 1
  fi
  if [[ "$(jq -r '.ready' <<<"$ci_run_evaluation")" != true ]]; then
    echo "Backing CI workflow run is $(jq -r '.state' <<<"$ci_run_evaluation"); admission remains pending."
    trap - EXIT INT TERM
    exit 0
  fi
fi

current_matching_prs="$(fetch_associated_pull_requests)"
current_pr_number="$(resolve_eligible_pr_number <<<"$current_matching_prs")"
if [[ "$current_pr_number" != "$PR_NUMBER" ]]; then
  post_admission_status pending \
    "Pull request is no longer uniquely eligible for admission"
  echo "Pull request eligibility changed during evaluation; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi

current_pull_request="$(gh api \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "repos/$REPOSITORY/pulls/$current_pr_number")"
if ! pull_request_is_eligible <<<"$current_pull_request"; then
  post_admission_status pending \
    "Pull request is no longer eligible for admission"
  echo "Pull request eligibility changed during evaluation; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi

current_changed_file_count="$(jq -r '.changed_files' <<<"$current_pull_request")"
current_file_pages="$(fetch_pull_request_files "$current_pr_number")"
current_classification="$(
  classify_pull_request_files "$current_changed_file_count" <<<"$current_file_pages"
)"
if [[ "$(jq -r '.classification' <<<"$current_classification")" != "$file_classification_name" ]]; then
  post_admission_status pending \
    "Pull request file classification changed during admission"
  echo "Pull request file classification changed; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi
current_sensitive_diff="$(jq -r '.greptileRequired' <<<"$current_classification")"
current_changes_greptile_exclusion_policy="$(
  jq -r '.matchedPaths | index("greptile.json") != null' <<<"$current_classification"
)"
current_admission_requirement="$(
  select_admission_requirement \
    "$current_sensitive_diff" "$current_changes_greptile_exclusion_policy" \
    <<<"$current_pull_request"
)"
current_trusted_automation="$(
  jq -r '.trustedAutomation' <<<"$current_admission_requirement"
)"
current_greptile_required="$(
  jq -r '.greptileRequired' <<<"$current_admission_requirement"
)"
current_classification_name="$(
  jq -r '.classification' <<<"$current_admission_requirement"
)"
current_excluded_author_pattern="$(
  jq -r '.excludedAuthorPattern // empty' <<<"$current_admission_requirement"
)"
if [[ "$current_trusted_automation" != "$trusted_automation" ||
      "$current_greptile_required" != "$greptile_required" ||
      "$current_classification_name" != "$classification_name" ||
      "$current_excluded_author_pattern" != "$excluded_author_pattern" ]]; then
  post_admission_status pending \
    "Pull request admission identity changed during evaluation"
  echo "Pull request admission identity changed; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi

current_check_run_pages="$(gh api --paginate --slurp \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "repos/$REPOSITORY/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100")"
current_evaluation="$(evaluate_check_runs "$greptile_required" <<<"$current_check_run_pages")"
current_terminal_failure="$(jq -r '.terminalFailure // empty' <<<"$current_evaluation")"
if [[ -n "$current_terminal_failure" ]]; then
  echo "Required check changed to an invalid or terminal state: $current_terminal_failure" >&2
  exit 1
fi
if [[ "$(jq -r '.ready' <<<"$current_evaluation")" != true ]]; then
  post_admission_status pending \
    "Required checks changed during final admission validation"
  echo "Required checks changed; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi
if [[ "$greptile_required" == false ]]; then
  current_ci_run_id="$(jq -r '.ciRunId' <<<"$current_evaluation")"
  if [[ "$EVENT_SOURCE" == workflow_run && "$EVENT_WORKFLOW_RUN_ID" != "$current_ci_run_id" ]]; then
    post_admission_status pending \
      "Completed CI event no longer matches the latest aggregate check"
    echo "Latest CI run changed to $current_ci_run_id during evaluation; admission remains pending."
    trap - EXIT INT TERM
    exit 0
  fi
  current_ci_run="$(gh api \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/actions/runs/$current_ci_run_id")"
  current_ci_run_evaluation="$(
    evaluate_ci_run "$current_ci_run_id" <<<"$current_ci_run"
  )"
  current_ci_run_terminal_failure="$(
    jq -r '.terminalFailure // empty' <<<"$current_ci_run_evaluation"
  )"
  if [[ -n "$current_ci_run_terminal_failure" ]]; then
    echo "CI run $current_ci_run_id evaluated as $(jq -r '.state' <<<"$current_ci_run_evaluation") and became invalid or terminal during final admission validation: $current_ci_run_terminal_failure" >&2
    exit 1
  fi
  if [[ "$(jq -r '.ready' <<<"$current_ci_run_evaluation")" != true ]]; then
    post_admission_status pending \
      "Backing CI workflow changed during final admission validation"
    echo "Backing CI workflow run returned to $(jq -r '.state' <<<"$current_ci_run_evaluation"); admission remains pending."
    trap - EXIT INT TERM
    exit 0
  fi
fi

final_matching_prs="$(fetch_associated_pull_requests)"
final_pr_number="$(resolve_eligible_pr_number <<<"$final_matching_prs")"
if [[ "$final_pr_number" != "$PR_NUMBER" ]]; then
  post_admission_status pending \
    "Pull request is no longer uniquely eligible for admission"
  echo "Final pull request association changed; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi
final_pull_request="$(gh api \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "repos/$REPOSITORY/pulls/$final_pr_number")"
if ! pull_request_is_eligible <<<"$final_pull_request"; then
  post_admission_status pending \
    "Pull request is no longer eligible for admission"
  echo "Final pull request eligibility changed; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi
final_changed_file_count="$(jq -r '.changed_files' <<<"$final_pull_request")"
final_file_pages="$(fetch_pull_request_files "$final_pr_number")"
final_classification="$(
  classify_pull_request_files "$final_changed_file_count" <<<"$final_file_pages"
)"
if [[ "$(jq -r '.classification' <<<"$final_classification")" != "$file_classification_name" ]]; then
  post_admission_status pending \
    "Pull request file classification changed during final validation"
  echo "Final pull request file classification changed; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi
final_sensitive_diff="$(jq -r '.greptileRequired' <<<"$final_classification")"
final_changes_greptile_exclusion_policy="$(
  jq -r '.matchedPaths | index("greptile.json") != null' <<<"$final_classification"
)"
final_admission_requirement="$(
  select_admission_requirement \
    "$final_sensitive_diff" "$final_changes_greptile_exclusion_policy" \
    <<<"$final_pull_request"
)"
final_trusted_automation="$(
  jq -r '.trustedAutomation' <<<"$final_admission_requirement"
)"
final_greptile_required="$(
  jq -r '.greptileRequired' <<<"$final_admission_requirement"
)"
final_classification_name="$(
  jq -r '.classification' <<<"$final_admission_requirement"
)"
final_excluded_author_pattern="$(
  jq -r '.excludedAuthorPattern // empty' <<<"$final_admission_requirement"
)"
if [[ "$final_trusted_automation" != "$trusted_automation" ||
      "$final_greptile_required" != "$greptile_required" ||
      "$final_classification_name" != "$classification_name" ||
      "$final_excluded_author_pattern" != "$excluded_author_pattern" ]]; then
  post_admission_status pending \
    "Pull request admission identity changed during final validation"
  echo "Final pull request admission identity changed; admission remains pending."
  trap - EXIT INT TERM
  exit 0
fi

post_admission_status success "$success_description"
trap - EXIT INT TERM
