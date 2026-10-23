# Two-week roadmap

- Days 1–2: scaffold, config validation, tests, MCP client smoke test.
- Days 3–4: Git hook installer/uninstaller, append-only attempt collection, remote verification, test fixtures.
- Days 5–6: `get_daily_activity` and `get_pending_tasks` MCP tools; redact sensitive data.
- Day 7: draft save/read/edit/approval; enforce human approval.
- Days 8–9: Notion Tasks and Work Logs adapter, schema setup guide, idempotency.
- Days 10–11: Swift EventKit bridge, dedicated calendar, permissions, all-day summary events.
- Day 12: partial-failure recovery and duplicate protection.
- Days 13–14: clean macOS install test, README, demo, GitHub release.

## Acceptance
Clone, configure, register 2 repositories, collect push attempts without a daemon, ask MCP client to draft a daily log, review/approve, publish once to Notion and Calendar, safely retry without duplicates.

## Cut line
If calendar permissions delay delivery, release Notion-first beta and label Calendar incomplete. Do not misrepresent readiness.

## Current implementation

- Milestone 0: TypeScript build and stdio MCP connectivity complete.
- Milestone 1: repository registration, fail-open pre-push collection, remote verification, and daily activity complete.
- Milestone 2: versioned daily drafts, MCP Apps review UI, Elicitation-first approval, and fallback audit trail complete.
- Notion, Calendar, and publication recovery remain unimplemented.
