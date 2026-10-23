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
DRAFT -> APPROVED -> (Notion SYNCED/FAILED, Calendar SYNCED/FAILED). A draft edit invalidates prior approval. Approval must be explicit from the human, not inferred from model text.
