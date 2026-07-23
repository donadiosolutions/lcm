# Claude GitHub workflows

This repository has two Claude Code workflows: an on-demand assistant for
maintainer comments and an automatic pull request reviewer. Both use the
repository's `CLAUDE_CODE_OAUTH_TOKEN` Actions secret and run Anthropic's
Claude Code action on GitHub-hosted runners.

## Set up the workflows

1. Obtain a Claude Code OAuth token for the account that should run Claude.
2. In the GitHub repository, open **Settings > Secrets and variables >
   Actions**.
3. Create a repository secret named `CLAUDE_CODE_OAUTH_TOKEN` containing that
   token.
4. Ensure GitHub Actions is enabled for the repository.

The workflows use the repository `GITHUB_TOKEN` for GitHub API access. No
personal access token is required. Keep the OAuth token in Actions secrets,
limit repository administration access, and rotate the token if it may have
been exposed. Workflows triggered from forks do not receive repository
secrets.

## On-demand Claude assistant

The **Claude Code** workflow responds when an authorized user includes
`@claude` in either:

- a newly created issue or pull request conversation comment; or
- a newly created pull request review comment.

The comment author must have GitHub's `OWNER`, `MEMBER`, or `COLLABORATOR`
association with the repository. Mentions from other users do not start the
job. The triggering comment supplies Claude's instructions.

Claude can read repository contents and Actions results and can post issue or
pull request comments. It cannot push commits or create branches because the
workflow grants `contents: read`, not `contents: write`. The commented issue or
pull request and its content are sent to Claude for processing; avoid invoking
the workflow on sensitive material.

## Automatic pull request review

The **Claude Code Review** workflow runs when a non-draft pull request is
opened, reopened, marked ready for review, or updated with new commits. Draft
pull requests are skipped until they are marked ready for review. It runs only
for branches in this repository. Fork pull requests and pull requests authored
by `dependabot[bot]` are excluded so untrusted changes cannot reach the
secret-backed job.

Claude reviews the pull request with the configured code-review plugin and can
publish review comments. It maintains a sticky progress comment and excludes
existing bot comments from its review context. The workflow has read-only
access to repository contents and write access only to issue and pull request
comments; it cannot push code.

Only the newest run for a pull request continues. Pushing another commit while
a review is running cancels the older run, preventing stale reviews and
duplicate comments. Runs for different pull requests do not cancel each other.

## Limitations and troubleshooting

- Claude's findings are advisory and do not replace required human review or
  repository status checks.
- Draft pull requests are skipped and receive their first review after they
  become ready for review.
- Editing an existing comment to add `@claude` does not trigger the on-demand
  workflow; create a new comment instead.
- A missing or invalid `CLAUDE_CODE_OAUTH_TOKEN` causes the Claude action to
  fail. Check the workflow run log without printing or copying the secret.
- A `403` while posting a response usually means the workflow's issue or pull
  request write permission was removed or restricted by repository policy.
- Claude cannot implement a requested change by pushing a branch with the
  current least-privilege configuration. A separately reviewed permission and
  credential design is required before enabling write access to contents.
