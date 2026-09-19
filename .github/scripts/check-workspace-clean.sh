#!/usr/bin/env bash
# Fails when tests or the build left files in the checkout. Legacy report
# locations are rejected directly; every other untracked file is reported.
set -Eeuo pipefail
if [ -e coverage ] || [ -e test-report.junit.xml ]; then
  echo "Tests or build left legacy checkout artifacts:"
  [ ! -e coverage ] || echo "coverage"
  [ ! -e test-report.junit.xml ] || echo "test-report.junit.xml"
  exit 1
fi
git diff --exit-code
UNTRACKED=$(git status --porcelain | grep "^??" | grep -vE "^\?\? (node_modules|dist|coverage)/|^\?\? test-report\.junit\.xml$" || true)
if [ -n "$UNTRACKED" ]; then
  echo "❌ Tests or build left unexpected untracked files in the workspace:"
  echo "$UNTRACKED"
  echo ""
  echo "Ensure all temp files go to os.tmpdir(), not process.cwd(). Tests must clean up after themselves."
  exit 1
fi
echo "✅ Workspace is clean"
