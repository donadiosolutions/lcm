"""Dependency-free Linux helper regressions: python3 -m unittest discover -s .agents/skills/tests -v.

Release tests execute the real admission stages with a fake GitHub boundary;
no PR, tag, registry, or installed application is modified.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SKILLS = Path(__file__).resolve().parents[1]
LOCK = SKILLS / "flock/scripts/lock.sh"
RELEASE = SKILLS / "lcm-release/scripts/release.sh"
THREAD = "0199b4ef-dfde-7a81-b33e-c439d91932d8"
OTHER = "0199b4ef-dfde-7a81-b33e-c439d91932d9"


class LockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, XDG_RUNTIME_DIR=str(self.root))
        for key in ("AGENT_THREAD_ID", "CODEX_THREAD_ID"):
            self.env.pop(key, None)

    def run_lock(self, resource="resource", env=None, prefix=""):
        return subprocess.run(
            ["bash", "-c", prefix + 'source "$1"; lock "$2"', "test", str(LOCK), resource],
            env=self.env | (env or {}), text=True, capture_output=True, timeout=5,
        )

    def metadata_path(self, resource="resource"):
        digest = hashlib.sha256(resource.encode()).hexdigest()
        return self.root / "codex-locks" / (digest + ".lock")

    def test_generic_identity(self):
        result = self.run_lock(env={"AGENT_THREAD_ID": THREAD})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.metadata_path().read_text().startswith("thread=" + THREAD + "\n"))

    def test_legacy_identity(self):
        result = self.run_lock(env={"CODEX_THREAD_ID": THREAD})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_generic_identity_has_precedence(self):
        result = self.run_lock(env={"AGENT_THREAD_ID": THREAD, "CODEX_THREAD_ID": OTHER})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.metadata_path().read_text().startswith("thread=" + THREAD + "\n"))

    def test_invalid_generic_identity_cannot_fall_back(self):
        result = self.run_lock(env={"AGENT_THREAD_ID": "not-a-thread", "CODEX_THREAD_ID": THREAD})
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.metadata_path().exists())

    def test_missing_identity_does_not_acquire(self):
        self.assertEqual(self.run_lock().returncode, 2)
        self.assertFalse(self.metadata_path().exists())

    def test_exact_resource_and_permissions(self):
        resource = "spaces / and\nthread=not-an-extra-field"
        result = self.run_lock(resource, {"CODEX_THREAD_ID": THREAD})
        self.assertEqual(result.returncode, 0, result.stderr)
        path = self.metadata_path(resource)
        self.assertTrue(path.read_text().endswith("resource=" + resource + "\n"))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_unsafe_runtime_mode(self):
        self.root.chmod(0o755)
        self.assertEqual(self.run_lock(env={"CODEX_THREAD_ID": THREAD}).returncode, 2)

    def test_symlink_rejected_without_modifying_target(self):
        path = self.metadata_path()
        path.parent.mkdir(mode=0o700)
        target = self.root / "target"
        target.write_text("unchanged")
        path.symlink_to(target)
        self.assertEqual(self.run_lock(env={"CODEX_THREAD_ID": THREAD}).returncode, 2)
        self.assertEqual(target.read_text(), "unchanged")

    def test_existing_descriptor_rejected(self):
        result = self.run_lock(env={"CODEX_THREAD_ID": THREAD}, prefix="exec 9</dev/null; ")
        self.assertEqual(result.returncode, 2)

    def test_sole_argument(self):
        for args in ([], ["one", "two"]):
            with self.subTest(args=args):
                result = subprocess.run(
                    ["bash", "-c", 'source "$1"; shift; lock "$@"', "test", str(LOCK), *args],
                    env=self.env | {"CODEX_THREAD_ID": THREAD}, capture_output=True, timeout=5,
                )
                self.assertEqual(result.returncode, 2)

    def test_legacy_and_generic_contend_without_rewriting_metadata(self):
        # A pipe handshake keeps the owning shell alive; no timing-based sleeps.
        holder = subprocess.Popen(
            ["bash", "-c", 'source "$1"; lock resource || exit; read -r release; exec 9>&-',
             "test", str(LOCK)],
            env=self.env | {"CODEX_THREAD_ID": THREAD}, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            self.assertEqual(holder.stdout.readline().strip(), "Acquired: resource")
            before = self.metadata_path().read_bytes()
            contender = self.run_lock(env={"AGENT_THREAD_ID": OTHER})
            self.assertEqual(contender.returncode, 75, contender.stderr)
            self.assertEqual(self.metadata_path().read_bytes(), before)
            self.assertIn(THREAD, contender.stderr)
            holder.communicate("release\n", timeout=5)
            self.assertEqual(holder.returncode, 0)
            self.assertEqual(self.run_lock(env={"AGENT_THREAD_ID": OTHER}).returncode, 0)
        finally:
            if holder.poll() is None:
                holder.kill()
                holder.communicate()
            for pipe in (holder.stdin, holder.stdout, holder.stderr):
                pipe.close()


class ReleaseAdmissionTests(unittest.TestCase):
    def run_gates(self, step=7, **options):
        text = RELEASE.read_text()
        start = text.index("# ─── STEP 6:")
        end = text.index("# ─── STEP 8:")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = dict(os.environ, TEST_ROOT=directory, FROM_STEP=str(step), CHECKED_HEAD="",
                       HEAD="a" * 40, WATCH_STATUS="0", REQUIRED="true", QUERY_STATUS="0",
                       MOVE_HEAD="false", MERGED_STATE="MERGED", MERGE_STATUS="0") | options
            harness = r'''
set -euo pipefail
REPO=fixture/repository
PR_NUMBER=1
MERGE_SHA=""
err() { printf '%s\n' "$*" >&2; exit 1; }
step() { :; }
ok() { :; }
skip() { :; }
run_step() { [[ "$1" -ge "$FROM_STEP" ]]; }
gh() {
  printf '%s\n' "$*" >> "$TEST_ROOT/calls"
  case "$1 $2" in
    'pr checks')
      if [[ " $* " == *" --watch "* ]]; then
        [[ "$MOVE_HEAD" != true ]] || touch "$TEST_ROOT/head-moved"
        return "$WATCH_STATUS"
      fi
      [[ " $* " == *" --required "* ]] || return 90
      [[ " $* " == *" --json bucket "* ]] || return 90
      [[ " $* " == *'length > 0 and all(.[]; .bucket == "pass")'* ]] || return 90
      printf '%s\n' "$REQUIRED"
      return "$QUERY_STATUS"
      ;;
    'pr view')
      case "$*" in
        *statusCheckRollup*) printf '0\n';;
        *headRefOid*)
          [[ "$QUERY_STATUS" == 0 ]] || return "$QUERY_STATUS"
          if [[ -f "$TEST_ROOT/head-moved" ]]; then printf '%040d\n' 2; else printf '%s\n' "$HEAD"; fi;;
        *mergeCommit*) printf '%040d\n' 3;;
        *'--json state'*) printf '%s\n' "$MERGED_STATE";;
        *) return 90;;
      esac
      ;;
    'pr merge') return "$MERGE_STATUS";;
    *) return 90;;
  esac
}
'''
            result = subprocess.run(["bash", "-c", harness + text[start:end]],
                                    env=env, text=True, capture_output=True, timeout=5)
            log = root / "calls"
            return result, log.read_text() if log.exists() else ""

    def assert_no_merge(self, **options):
        result, calls = self.run_gates(**options)
        self.assertNotEqual(result.returncode, 0, calls)
        self.assertNotIn("pr merge", calls)

    def test_absent_checks_fail_closed(self):
        self.assert_no_merge(step=6, WATCH_STATUS="1", REQUIRED="false")

    def test_resume_seven_cannot_skip_failed_checks(self):
        self.assert_no_merge(WATCH_STATUS="1")

    def test_required_checks_must_be_nonempty_and_passed(self):
        self.assert_no_merge(REQUIRED="false")

    def test_query_failure_blocks_merge(self):
        self.assert_no_merge(QUERY_STATUS="1")

    def test_invalid_head_blocks_merge(self):
        self.assert_no_merge(HEAD="null")

    def test_head_advance_during_checks_blocks_merge(self):
        self.assert_no_merge(MOVE_HEAD="true")

    def test_guarded_merge_for_both_entrypoints(self):
        for step in (6, 7):
            with self.subTest(step=step):
                result, calls = self.run_gates(step=step)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("--match-head-commit " + "a" * 40, calls)
                self.assertIn("--json state", calls)
                self.assertNotIn("--admin", calls)

    def test_merge_must_be_confirmed(self):
        result, _ = self.run_gates(MERGED_STATE="OPEN")
        self.assertNotEqual(result.returncode, 0)

    def test_server_merge_failure_is_not_success(self):
        result, _ = self.run_gates(MERGE_STATUS="1")
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
