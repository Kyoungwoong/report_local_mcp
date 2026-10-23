# Local DevLog MCP

**Status: starter scaffold / not a complete MVP.** A macOS-first, open-source MCP that will turn Git activity across repositories into human-approved daily logs in Notion and Apple Calendar.

## What works in this starter
- A minimal `stdio` MCP server with `ping` and `get_daily_activity` (the latter currently returns a clearly labeled placeholder).
- TypeScript strict compilation, a basic test, example config and Codex guidance.
- A non-destructive setup command that writes a local config template.

## Planned MVP (not yet implemented)
Git `pre-push` attempt collection; remote verification; daily draft review and approval; Notion Tasks/Work Logs; Apple Calendar EventKit bridge; idempotent publication.

## Requirements
macOS, Node.js >=20, pnpm, Git. Calendar bridge will additionally require Xcode Command Line Tools and calendar permission.

## Start
```bash
cp .env.example .env   # fill secrets later; do not commit
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm setup
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

## Configuration
`config.example.json` is a sample; `pnpm setup` creates `config.local.json` if missing. The setup does not install hooks or access external services yet. Do not place tokens in JSON. Set `NOTION_TOKEN`, `NOTION_TASKS_DATABASE_ID`, `NOTION_WORKLOGS_DATABASE_ID` via environment/secure configuration once integration is implemented.

## Security and Git behavior
`pre-push` executes before a push succeeds. Captured hook events are attempts, not proof of remote publication. Never let hook collection failures block the user's push. Never overwrite an existing hook silently. User approval is required before external writes.

## Roadmap
See `docs/roadmap.md`. Slack and KakaoTalk are future ideas only (`docs/future-extensions.md`).

## License
MIT (see LICENSE).
