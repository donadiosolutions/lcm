"""Static contracts for the triage-security-issues orchestration skill.

These tests validate the skill boundary and its delegation contracts. They do
not execute GitHub, Codex Security, browser authentication, or a remediation
campaign. The companion security-campaign-scenarios.md document is the
simulation/live-runtime acceptance protocol.
"""

from pathlib import Path
import re
import unittest


SKILLS = Path(__file__).resolve().parents[1]
SECURITY = SKILLS / "triage-security-issues"


class SecurityCampaignContractTests(unittest.TestCase):
    def read(self, relative: str) -> str:
        path = SECURITY / relative
        self.assertTrue(path.is_file(), f"required security skill file is missing: {relative}")
        return path.read_text(encoding="utf-8")

    def test_skill_has_focused_entrypoint_and_references(self):
        self.read("SKILL.md")
        for reference in ("references/sources.md", "references/authentication.md",
                          "references/triage.md", "references/coordination.md"):
            self.read(reference)

    def test_local_links_resolve(self):
        for path in SECURITY.rglob("*.md"):
            text = path.read_text(encoding="utf-8")
            for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
                if "://" in target or target.startswith("#"):
                    continue
                filename, _, fragment = target.partition("#")
                destination = (path.parent / filename).resolve()
                self.assertTrue(destination.is_file(), f"broken link {path.name}: {target}")
                if fragment:
                    headings = re.findall(r"^#+ (.+)$", destination.read_text(encoding="utf-8"), re.MULTILINE)
                    anchors = {
                        re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")
                        for heading in headings
                    }
                    self.assertIn(fragment, anchors, f"broken anchor {path.name}: {target}")

    def test_invocation_interface_and_private_followup_defaults(self):
        text = self.read("SKILL.md")
        for parameter in ("REPOSITORY", "CODEX_CSV", "RESUME_RUN"):
            self.assertRegex(text, rf"(?i)\b{parameter}\b")
        delivery = (SKILLS / "procedural-development" / "references" / "delivery.md").read_text(encoding="utf-8")
        self.assertRegex(text, r"(?i)followup_channel[ =`]*private-record")
        self.assertIn("github-issue", delivery)
        self.assertIn("private-record", delivery)
        for marker in ("acceptance criteria", "source", "candidate", "review", "PR"):
            self.assertIn(marker.lower(), delivery.lower())

    def test_required_daybreak_roles_and_configurable_slots(self):
        text = self.read("SKILL.md").lower()
        for role in ("TRIAGE", "IMPLEMENTER", "SECURITY_IMPLEMENTER", "ESCALATED_IMPLEMENTER"):
            self.assertRegex(text, rf"(?m)^\|\s*`?{role.lower()}`?\s*\|[^\n]*gpt-daybreak-blue-latest")
        for role in ("OWNER", "REVIEWER_A", "REVIEWER_B", "SYNTHESIS_REVIEWER"):
            self.assertIn(role.lower(), text)
        self.assertIn("configurable", text)

    def test_delegation_table_is_explicit_and_reuse_is_mandatory(self):
        text = self.read("SKILL.md")
        lower = text.lower()
        for phrase in ("invoke existing skills", "do not duplicate", "natural-language",
                       "copy their scripts", "skill invocation boundaries"):
            self.assertIn(phrase, lower)
        self.assertIn("procedural-development", lower)
        self.assertIn("lcm-memory", lower)
        self.assertIn("flock", lower)
        self.assertRegex(lower, r"playwright|browser")
        self.assertRegex(lower, r"do not invoke `triage-fix-all-bugs`")
        self.assertRegex(lower, r"\|\s*invoke\s*\|\s*input\s*\|\s*required evidence")

    def test_source_contract_covers_all_four_inventories(self):
        text = self.read("references/sources.md").lower()
        for marker in ("dependabot", "malware", "code scanning",
                       "secret scanning", "codex security", "pagination", "source availability",
                       "404", "partial"):
            self.assertIn(marker, text)
        self.assertRegex(text, r"gh\s+api|github.*api")
        self.assertRegex(text, r"gh\s+auth\s+login|already authenticated")
        self.assertIn("classification=general", text)
        self.assertIn("classification=malware", text)
        self.assertRegex(text, r"csv|export")
        self.assertIn("snapshot", text)

    def test_authentication_contract_limits_login_and_protects_state(self):
        text = self.read("references/authentication.md").lower()
        for marker in ("reuse", "headed", "headless", "github", "codex",
                       "once", "storage state", "outside every git checkout", "private",
                       "credentials", "redact", "expire", "cleanup"):
            self.assertIn(marker, text)
        self.assertRegex(text, r"at most|maximum|no more than")

    def test_secret_inventory_includes_generic_patterns_or_blocks_freeze(self):
        text = self.read("references/sources.md").lower()
        for marker in ("generic patterns", "secret_type", "enabled", "paginate",
                       "coverage gap", "block s0 freeze"):
            self.assertIn(marker, text)

    def test_triage_contract_enforces_freeze_group_barrier_and_safe_resolution(self):
        text = self.read("references/triage.md").lower()
        for marker in ("freeze", "s0", "every", "group", "root cause", "blocks implementation",
                       "obsolete", "uncertain", "sanitized", "claim",
                       "dismiss", "readback", "unreconciled"):
            self.assertIn(marker, text)
        source_text = self.read("references/sources.md").lower()
        self.assertRegex(source_text, r"scanner-confirmed|verify scanner")
        self.assertRegex(source_text, r"risk acceptance|won't-fix needs explicit user direction")

    def test_coordination_preserves_run_budgets_and_private_accounting(self):
        text = self.read("references/coordination.md").lower()
        for marker in ("run", "resume", "checkpoint", "spent rounds", "private", "owner",
                       "candidate", "procedural-development", "source-resolved"):
            self.assertIn(marker, text)
        self.assertRegex(text, r"same logical run|run\s+id")
        delivery = (SKILLS / "procedural-development" / "references" / "delivery.md").read_text(encoding="utf-8").lower()
        self.assertRegex(delivery, r"candidate budget|completed candidate|three")

    def test_scenario_protocol_is_present_and_marks_simulation_vs_live(self):
        text = (SKILLS / "tests" / "security-campaign-scenarios.md").read_text(encoding="utf-8")
        for marker in ("simulation", "live", "not executed", "no live campaign", "external mutation"):
            self.assertIn(marker, text.lower())
        for source in ("Dependabot", "Code Scanning", "Secret Scanning", "Codex Security"):
            self.assertIn(source, text)
        for marker in ("cross-source", "group", "dismiss", "readback", "stale",
                       "authentication", "scanner", "reuse"):
            self.assertIn(marker, text.lower())
        self.assertGreaterEqual(len(re.findall(r"\|\s*SEC\d{2}\s*\|", text)), 8)


if __name__ == "__main__":
    unittest.main()
