---
"@donadiosolutions/lcm": major
---

Resolve compact discovery source locators with one bounded project-level
lookup instead of one native-transcript query per eligible conversation, so
large projects no longer pay an N+1 query pattern or load transcript payloads
that discovery never displays. A session whose provenance cannot be read now
loses only its own source locator (#1338, source Bug #1283).

BREAKING: NativeTranscriptRepository gains the required member
listUnambiguousSourceLocators. The interface is exported from the public
@donadiosolutions/lcm/storage/native-transcripts entry point, so an external
implementation must add this operation to compile against this release.
