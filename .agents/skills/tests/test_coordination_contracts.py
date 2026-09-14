"""Static skill-contract regressions, not proof of agent or scheduler behavior.

The executable command is already part of CI:
python3 -B -m unittest discover -s .agents/skills/tests -v
Run the separate coordination-scenarios.md protocol against the native runtime
before claiming behavioral compliance.
"""
from pathlib import Path
import re
import unittest

SKILLS = Path(__file__).resolve().parents[1]
PROCEDURAL = SKILLS / "procedural-development"


class CoordinationContractTests(unittest.TestCase):
    def read(self, relative):
        path = SKILLS / relative
        self.assertTrue(path.is_file(), f"Required contract is missing: {relative}")
        return path.read_text(encoding="utf-8")

    def table_fields(self, text, heading):
        self.assertIn(heading + "\n", text)
        section = text.split(heading + "\n", 1)[1].split("\n## ", 1)[0]
        return set(re.findall(r"^\| ([^|]+?) \|", section, re.MULTILINE))

    def test_epic_requires_shared_admission(self):
        text = self.read("implement-epic/SKILL.md")
        self.assertIn("../procedural-development/references/root-lifecycle.md", text)
        self.assertIn("before the first worker dispatch", " ".join(text.split()))

    def test_triage_requires_admission_and_execution_contract_during_triage(self):
        text = self.read("triage-fix-all-bugs/SKILL.md")
        self.assertIn("../procedural-development/references/root-lifecycle.md", text)
        self.assertIn("../procedural-development/references/worker-execution.md", text)
        self.assertIn("before triage dispatch", " ".join(text.split()))

    def test_engine_requires_both_lifecycle_contracts(self):
        text = self.read("procedural-development/SKILL.md")
        self.assertIn("references/root-lifecycle.md", text)
        self.assertIn("references/worker-execution.md", text)
        fields = self.table_fields(text, "## Procedure")
        self.assertTrue({"Coordination", "Execution"}.issubset(fields), fields)
        self.assertNotIn("stable run/root identity", text)

    def test_coordination_uses_native_lifecycle_instead_of_generic_task(self):
        text = self.read("procedural-development/references/coordination.md")
        self.assertIn("root-lifecycle.md", text)
        self.assertNotIn("Maintain one supported scheduled watchdog task", text)
        self.assertNotIn("This allows one scheduled run to be", text)
        self.assertIn('collaboration.wait_agent({"timeout_ms":3600000})', text)
        self.assertIn("worker-execution.md#completion", text)

    def test_root_record_requires_native_evidence(self):
        text = self.read("procedural-development/references/root-lifecycle.md")
        fields = self.table_fields(text, "## Evidence record")
        required = {"Run", "Root", "Binding", "Check", "Enabled", "Cadence",
                    "Observed", "Next due", "Last execution"}
        self.assertTrue(required.issubset(fields), required - fields)
        for heading in ("## Admission", "## Unavailable control",
                        "## Recovery authority", "## Coordinator replacement",
                        "## Terminal cleanup"):
            self.assertIn(heading, text)

    def test_all_roles_receive_execution_fields(self):
        text = self.read("procedural-development/references/worker-execution.md")
        fields = self.table_fields(text, "## Required dispatch brief")
        required = {"Assignment", "Instructions", "Workspace", "Budget",
                    "Execution ownership", "Completion"}
        self.assertTrue(required.issubset(fields), required - fields)
        self.assertIn('fork_turns="none"', text)
        self.assertIn("## Completion", text)

    def test_delivery_cannot_omit_execution_lifecycle(self):
        text = self.read("procedural-development/references/delivery.md")
        self.assertIn("worker-execution.md", text)
        self.assertIn("worker-execution.md#completion", text)

    def test_new_local_reference_links_resolve(self):
        for name in ("root-lifecycle.md", "worker-execution.md"):
            path = PROCEDURAL / "references" / name
            text = self.read(f"procedural-development/references/{name}")
            for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
                if "://" in target:
                    continue
                filename, _, fragment = target.partition("#")
                destination = (path.parent / filename).resolve() if filename else path
                self.assertTrue(destination.is_file(), f"Broken link: {name}: {target}")
                if fragment:
                    headings = re.findall(r"^#+ (.+)$", destination.read_text(), re.MULTILINE)
                    anchors = {re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")
                               for heading in headings}
                    self.assertIn(fragment, anchors, f"Broken anchor: {name}: {target}")

    def test_behavioral_scenarios_cover_reported_failures_and_recovery(self):
        text = self.read("tests/coordination-scenarios.md")
        for number in range(1, 13):
            self.assertIn(f"| C{number:02d} |", text)
        self.assertIn("not executed", text)
        self.assertIn("tool calls", text)

    def test_environment_failure_does_not_globally_block_isolated_work(self):
        text = (SKILLS.parents[1] / "AGENTS.md").read_text()
        self.assertNotIn("fix it before starting the next feature", text)
        self.assertIn("unrelated isolated work", text)

    def test_existing_review_and_budget_contracts_remain(self):
        engine = self.read("procedural-development/SKILL.md")
        delivery = self.read("procedural-development/references/delivery.md")
        self.assertIn("`MAX_ACTIVE_OWNERS=7`, `WATCHDOG_MINUTES=30`", engine)
        self.assertIn("three\ncompleted candidate rounds per item", engine)
        for role in ("OWNER", "IMPLEMENTER", "SECURITY_IMPLEMENTER",
                     "ESCALATED_IMPLEMENTER", "REVIEWER_A", "REVIEWER_B",
                     "SYNTHESIS_REVIEWER"):
            self.assertRegex(engine, rf"(?m)^\| `{role}` \|")
        self.assertIn("Three separate reports remain required", delivery)
        self.assertIn("An ancestor's approval does not certify its descendant.", delivery)
        self.assertIn("Do not invent file, worktree,\ntest, database, review, publication or merge reservations.", engine)


if __name__ == "__main__":
    unittest.main()
