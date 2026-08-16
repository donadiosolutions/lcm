## Summary

<!-- What changed? Be specific. -->

## Motivation / Why

<!-- Why is this change needed? What problem does it solve? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring (no behavior change)
- [ ] Chore / infra / config
- [ ] Documentation

## Release-note title

<!--
Use a conventional PR title to select the generated release-note category:
- fix: ... -> Fixes
- feat: ... or feature: ... -> Features
- feat!: ... or type(scope)!: ... -> Breaking changes
- every other title -> Extra notes
A major package Changeset also selects Breaking changes.
-->

## Testing done

<!-- Describe how you tested. New routes should have tests in test/daemon/routes/. -->

## Related issues

<!-- Closes #N -->

## Checklist

- [ ] DB access only via `getLcmConnection()`/`closeLcmConnection()` — no direct `DatabaseSync`
- [ ] New connections set `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`
- [ ] No `implicit any` — all types explicit
- [ ] `collectStats()` not called in request handlers or hot paths
- [ ] New routes have tests in `test/daemon/routes/`
- [ ] Multi-step writes use transactions
- [ ] Schema migrations are additive only
- [ ] Test suite passes: `npm test`
