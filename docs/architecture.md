# Architecture — MVP

`git push` -> `pre-push` hook (attempt only) -> local JSON -> on-demand MCP stdio -> AI client summarizes -> draft stored -> human approves -> Notion + Apple Calendar adapters.

- No always-on MCP or daemon.
- No embedded LLM API. Codex/Claude or another compatible client provides the AI.
- Pre-push cannot confirm success; verify remote refs later and mark uncertain events.
- One TypeScript package; small Swift EventKit helper for macOS Calendar.
- Store versioned JSON state under `~/Library/Application Support/local-devlog-mcp`, never inside tracked repositories.
- Per-repository hooks are fail-open. Existing or externally shared hooks paths are refused rather than overwritten or guessed at.
- Event writes use deterministic IDs, a writer lock, and atomic file replacement.
- External writes require persisted approval and per-target idempotency records.
- Future Slack/KakaoTalk are separate delivery concerns, not part of MVP.

## Draft state
PENDING <-> REJECTED -> APPROVED -> (future: Notion SYNCED/FAILED, Calendar SYNCED/FAILED).

- One logical draft exists per work date and timezone. Edits append immutable, monotonically numbered revisions using optimistic version checks.
- The MCP client LLM writes proposed text, while the server validates that every work item links to captured Git events and records whether those sources have a current remote match.
- Approval does not create a new content version. It freezes the exact version with its timestamp, method, and source-change warnings; approved content cannot be edited.
- Native MCP form Elicitation is the preferred human boundary. Clients without it must provide a draft/version-specific phrase, whose weaker trust guarantee is retained in `approvalMethod`.
- The MCP App is a self-contained optional view over the same Tools. It has no direct storage or network access, and clients without Apps support retain full JSON/text behavior.
- Approval must be explicit from the human, not inferred from model text. No external publication is permitted merely because a Tool was invoked.

## Notion publication

- Database containers and Data Sources are resolved separately using the pinned `2026-03-11` Notion API. Schema validation is read-only and never repairs user databases.
- Preview binds the approved draft version, selected Next Actions, generated Work Logs, and a fingerprint. Publishing rejects a changed or unreviewed preview.
- Publication requires a second explicit Elicitation confirmation because draft approval alone does not authorize an external write.
- Every Work Log and Task has a deterministic Local ID. Before creation, the adapter queries that ID so a crash between the remote write and local persistence remains recoverable without duplication.
- `notion-publications.json` tracks each target item independently as PENDING, SYNCED, or FAILED. Retry skips synced items and retries failed or locally uncertain items.
- Detailed Work Item text is page body content; database properties retain compact searchable metadata. Tokens, diffs, and local repository paths are never published.
