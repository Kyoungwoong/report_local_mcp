# Local DevLog MCP

**Status: Milestone 3 complete / Apple Calendar is not implemented.** A macOS-first, open-source MCP that records Git push attempts, stores versioned human-approved drafts, and explicitly publishes approved work to Notion.

## What works
- Multiple local Git repositories can be registered with `pnpm run setup`.
- A fail-open `pre-push` hook records push attempts without requiring the MCP server to be running.
- JSON event storage uses deterministic event IDs, a writer lock, and atomic replacement.
- `get_daily_activity` returns dated commit metadata and current remote-state verification.
- Daily drafts can be saved, listed, edited, rejected, reopened, and explicitly approved through MCP Tools.
- Draft revisions and approval evidence are stored atomically in local JSON.
- MCP Apps-capable hosts receive an interactive draft review UI; other hosts receive the same structured JSON plus text fallback.
- Approval uses native form Elicitation when the host supports it, with an exact confirmation phrase fallback otherwise.
- Notion Database/Data Source configuration can be validated read-only against API version `2026-03-11`.
- Approved Work Items can be published to Work Logs and explicitly selected Next Actions to Tasks.
- Notion publication uses deterministic Local IDs and per-item local state for duplicate prevention and partial-failure retry.

## Planned MVP (not yet implemented)
Apple Calendar EventKit bridge and cross-target partial-failure recovery. Only approved drafts will be eligible for Calendar publication.

## Requirements
macOS, Node.js >=20, pnpm, Git. Calendar bridge will additionally require Xcode Command Line Tools and calendar permission.

## Start
```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm run setup -- add /absolute/path/to/repository
pnpm start
```

The MCP server uses `stdio` and is normally launched by a compatible MCP client rather than run continuously. Example client command after build: `node /absolute/path/to/local-devlog-mcp/dist/index.js`.

## Connect from Codex

Build the server, then register it with Codex using the absolute path to this checkout:

```bash
pnpm build
codex mcp add local-devlog -- node /absolute/path/to/local-devlog-mcp/dist/index.js
codex mcp list
```

Restart Codex after registration. In the Codex terminal UI, run `/mcp` to confirm that `local-devlog` is connected, then ask Codex to call the `ping` tool. A healthy server returns `pong`.

Codex CLI, the Codex IDE extension, and the ChatGPT desktop app share MCP configuration on the same host. For project-scoped configuration, trusted projects can instead add the following to `.codex/config.toml`:

```toml
[mcp_servers.local-devlog]
command = "node"
args = ["/absolute/path/to/local-devlog-mcp/dist/index.js"]
cwd = "/absolute/path/to/local-devlog-mcp"
```

The configured path points to build output, so run `pnpm build` again after changing the server source.

Native MCP form Elicitation is preferred for draft approval. With a Codex version that exposes the granular setting, ensure Elicitation is not disabled in `~/.codex/config.toml`:

```toml
approval_policy.granular.mcp_elicitations = true
```

See the official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Host support varies: when an MCP client does not render MCP Apps, the draft Tools still work through structured JSON; when it does not support form Elicitation, approval requires the exact phrase returned by the failed approval attempt.

## Daily draft workflow

1. Call `get_daily_activity` with a local date and use only its Git evidence to prepare `summary`, `workItems`, and `nextActions`.
2. Pass the returned `sourceFingerprint` and referenced event IDs to `save_daily_draft`. Saving never approves a draft.
3. Review with `get_daily_draft` or `list_daily_drafts`. Use `update_daily_draft` with the current `expectedVersion`; stale edits return `VERSION_CONFLICT`.
4. Reject or reopen through `update_daily_draft` using `REJECTED` or `PENDING`.
5. Call `approve_daily_draft` for one exact `draftId` and `version`. Native Elicitation requires a human to accept and type the displayed phrase.

The available draft Tools are `save_daily_draft`, `get_daily_draft`, `list_daily_drafts`, `update_daily_draft`, and `approve_daily_draft`. Approved drafts are immutable. If new Git activity appears between saving and approval, approval remains possible but records `SOURCE_CHANGED_AFTER_DRAFT`.

The interactive view is served as a self-contained `ui://` resource following the [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). It has no external network or asset permissions. Approval always goes back through the server Tool; clicking an in-app button alone is not approval.

Fallback confirmation is weaker than native Elicitation because an AI client can reproduce a displayed phrase. The persisted `approvalMethod` distinguishes `MCP_ELICITATION` from `EXPLICIT_CONFIRMATION_FALLBACK`; review that audit field before future publication.

## Notion setup and publication

Keep the integration token only in the ignored `.env` file or the process environment:

```dotenv
NOTION_TOKEN=secret_...
NOTION_TASKS_DATABASE_ID=<parent-database-id>
NOTION_TASKS_DATA_SOURCE_ID=<tasks-data-source-id>
NOTION_WORKLOGS_DATABASE_ID=<parent-database-id>
NOTION_WORKLOGS_DATA_SOURCE_ID=<work-logs-data-source-id>
```

For compatibility, an existing `*_DATABASE_ID` value that is actually a Data Source ID is detected read-only and reported as a warning. The application never rewrites `.env` or modifies a Notion schema.

Required Tasks properties:

| Property | Type | Required option |
| --- | --- | --- |
| Name | title | — |
| Due Date | date | — |
| Local Id | rich_text | — |
| Status | select | TODO |
| Priority | select | MEDIUM |

Required Work Logs properties:

| Property | Type |
| --- | --- |
| Name | title |
| Date | date |
| Repository | url |
| Summary | rich_text |
| Local ID | rich_text |

Run the read-only check with `pnpm notion:validate`. It authenticates, resolves Database and Data Source IDs, and compares property names, types, and required select options. It never creates or updates a page.

Publication is deliberately two-phase:

1. Call `preview_notion_publication` with an approved `draftId`, exact approved `version`, and zero-based `selectedNextActionIndexes`.
2. Review the Work Logs, selected Tasks, and `previewFingerprint` returned by the preview.
3. Call `publish_to_notion` with the same selection and fingerprint. Native Elicitation or the exact returned fallback phrase is required before any write.
4. Call `get_notion_publication_status` to inspect each item and retry failures safely.

Approval alone never publishes. Every Work Item becomes one Work Log, while only explicitly selected Next Actions become Tasks. Work Log details are written in the page body. The local status is stored in `notion-publications.json`; if a remote create succeeds before local persistence, retry queries the Local ID before creating anything else.

## Repository setup

Configuration, events, drafts, and publication state are stored outside this checkout at `~/Library/Application Support/local-devlog-mcp/`. The Notion token remains in `.env` or the process environment and is never copied into local JSON. No diff content is stored.

```bash
# Build first because installed hooks call dist/git/hook-runner.js.
pnpm build

# Add one or more repositories and install their hooks.
pnpm run setup -- add ~/Projects/one ~/Projects/two

# Show registered repositories and the active data directory.
pnpm run setup -- list

# Change the calendar timezone used by get_daily_activity.
pnpm run setup -- timezone America/Los_Angeles

# Remove only the matching Local DevLog hook and registration.
pnpm run setup -- remove ~/Projects/one
```

Use `pnpm run setup`, including `run`: pnpm 10 reserves `pnpm setup` for configuring pnpm itself and does not dispatch the project script.

For isolated testing, `LOCAL_DEVLOG_DATA_DIR` overrides the data directory. `config.example.json` documents the persisted configuration version but repository entries should be created through `pnpm run setup`.

## Security and Git behavior
`pre-push` executes before a push succeeds. Captured events are attempts, not proof of remote publication. `REMOTE_MATCH` means only that the requested commit or deletion agrees with the currently observed remote state; it does not prove which command produced that state.

Hook collection failures print a diagnostic to stderr and allow the push to continue. Setup refuses to overwrite an existing `pre-push` hook because automatically combining arbitrary hook scripts can change stdin and exit-code behavior. Removal checks the exact installed hook hash and never deletes a modified or third-party hook. Repository-local `core.hooksPath` settings are respected; external paths are refused because a shared hook cannot safely embed one repository identity.

## Manual macOS check

1. Run `pnpm build`, then register a temporary repository with `pnpm run setup -- add <path>`.
2. Push to a local bare repository while the MCP server is stopped.
3. Confirm `events.json` appears under `~/Library/Application Support/local-devlog-mcp/`.
4. Start Codex, call `get_daily_activity` for the local date, and confirm the event is labeled as a push attempt.
5. Run `pnpm run setup -- remove <path>` and confirm unrelated hook files are untouched.

## Roadmap
See `docs/roadmap.md`. Slack and KakaoTalk are future ideas only (`docs/future-extensions.md`).

## License
MIT (see LICENSE).
