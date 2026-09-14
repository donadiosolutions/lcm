"""Structural checks only; these do not execute agents or certify a live runtime.

Run: python3 -m unittest discover -s .agents/skills/tests -p test_workflow_contracts.py -v
Run the separate runtime-scenarios.md acceptance cases in the actual harness.
"""
from pathlib import Path
import re
import unittest

SKILLS = Path(__file__).resolve().parents[1]


class WorkflowDocumentationTests(unittest.TestCase):
    def read(self, relative):
        path = SKILLS / relative
        self.assertTrue(path.is_file(), f"Missing contract: {relative}")
        return path.read_text(encoding="utf-8")

    def assert_link(self, source, href):
        text = self.read(source)
        self.assertIn(f"]({href})", text)
        relative, _, fragment = href.partition("#")
        target = (SKILLS / source).parent / relative
        self.assertTrue(target.is_file(), f"Broken link: {source} -> {href}")
        if fragment:
            headings = re.findall(r"^#{1,6} (.+)$", target.read_text(encoding="utf-8"), re.M)
            anchors = {re.sub(r"[^\w\- ]", "", h.lower()).replace(" ", "-") for h in headings}
            self.assertIn(fragment, anchors, f"Missing heading: {href}")

    def test_both_callers_link_shared_admission(self):
        for entry in ("implement-epic/SKILL.md", "triage-fix-all-bugs/SKILL.md"):
            with self.subTest(entry=entry):
                self.assert_link(entry, "../procedural-development/SKILL.md#coordination-admission")

    def test_dispatch_contract_includes_execution_and_completion(self):
        text = self.read("procedural-development/SKILL.md")
        self.assertIn("### Dispatch brief", text)
        self.assertIn("| Execution |", text)
        self.assertIn("| Completion evidence |", text)
        self.assert_link("procedural-development/SKILL.md", "references/execution-lifecycle.md")
        self.assert_link("procedural-development/SKILL.md", "references/runtime-controls.md")

    def test_runtime_reference_has_binding_and_evidence_contracts(self):
        text = self.read("procedural-development/references/runtime-controls.md")
        for heading in ("## Bind the exposed controls", "## Root periodic-check admission",
                        "## Evidence and failure handling", "## Active wait and scheduled delivery"):
            with self.subTest(heading=heading):
                self.assertIn(heading, text)

    def test_recovery_distinguishes_evidence_and_successor(self):
        text = self.read("procedural-development/references/coordination.md")
        self.assertIn("### Evidence authority", text)
        self.assertIn("### Authorized coordinator replacement", text)
        self.assert_link("procedural-development/references/coordination.md", "runtime-controls.md")

    def test_all_terminal_paths_link_execution_contract(self):
        for source, href in (
            ("procedural-development/references/delivery.md", "execution-lifecycle.md"),
            ("procedural-development/references/coordination.md", "execution-lifecycle.md"),
            ("triage-fix-all-bugs/references/triage.md",
             "../../procedural-development/references/execution-lifecycle.md"),
        ):
            with self.subTest(source=source):
                self.assert_link(source, href)
        text = self.read("procedural-development/references/execution-lifecycle.md")
        self.assertIn("## Resource envelope", text)
        self.assertIn("## Command lifecycle", text)
        self.assertIn("## Completion evidence", text)

    def test_manual_cases_remain_explicitly_unautomated(self):
        text = self.read("tests/runtime-scenarios.md")
        self.assertIn("not automated by test_workflow_contracts.py", text)
        expected = {
            "paused-record", "wrong-target", "lost-reply", "already-enabled",
            "wait-delivery", "missing-control", "successor-root", "yielded-command",
            "owned-cleanup", "fresh-brief", "aggregate-budget", "environment-boundary",
        }
        actual = set(re.findall(r"^## Case: ([a-z-]+)$", text, re.M))
        self.assertEqual(actual, expected)
        self.assert_link("tests/runtime-scenarios.md",
                         "../procedural-development/references/runtime-controls.md")

    def test_environment_policy_uses_dependency_boundary(self):
        path = SKILLS.parents[1] / "AGENTS.md"
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("fix it before starting the next feature", text)
        self.assertIn("Independent work in isolated fixtures may continue", text)
        self.assertIn("pnpm run test --maxWorkers=1", text)


if __name__ == "__main__":
    unittest.main()
