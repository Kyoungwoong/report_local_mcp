---
name: testing-review
description: Review tests, security, release readiness and GitHub onboarding for the two-week MVP.
---
# Testing and review
1. Run `pnpm typecheck`, `pnpm test`, `pnpm build`.
2. Test empty repositories, failed pushes, hook reinstall/uninstall, timezones, duplicate events and partially failed output adapters.
3. Mock Notion/EventKit in automated tests; provide a manual macOS integration checklist.
4. Check secrets, documentation accuracy, install/uninstall instructions and non-destructive setup.
5. Report failures and unimplemented features explicitly.
