---
"@donadiosolutions/lcm": patch
---

Fix release maintenance edge cases: publish release notes now extract Changesets changelog entries written as either `## 1.2.3` or `## [1.2.3]`, doctor no longer suggests the unsupported `lcm daemon restart` command, the manual release workflow now follows the repository's main-only branch layout and creates a changelog block before tagging, and automated release metadata stays on the Changesets path.
