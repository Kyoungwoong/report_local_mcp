# Codex instructions — Local DevLog MCP

Read `RULES.md`, `docs/architecture.md`, and `docs/roadmap.md` before editing. Consult the relevant `.agents/skills/*/SKILL.md` when working in that area.

## Goal
Ship a usable, macOS-first, single-user, open-source MVP in 14 focused development days. Multiple repositories; Git `pre-push` attempt signals; AI client summarizes a day; explicit user approval; Notion Tasks/Work Logs and Apple Calendar output. Slack/KakaoTalk are **future only**.

## Non-negotiable
- Never call a pre-push event a confirmed successful push. Validate remote state and surface uncertainty.
- Do not run a background daemon or call an LLM API in the MVP. The MCP client provides the model.
- No Notion/Calendar writes without a persisted, explicitly approved draft; MCP tool calls are not approval by themselves.
- Never overwrite existing Git hooks without permission. Preserve hook chains and uninstall safely.
- No secrets in source, logs, Git diffs forwarded to models, or tests.
- `stdio` MCP protocol: stdout is protocol only; diagnostics go to stderr.
- Do not implement Slack/KakaoTalk, a web UI, multi-user support, or an extensible plugin framework.
- Add tests for each feature, especially failed pushes, duplicate publication, malformed config, and approval checks.
- At the end of each milestone report changes, commands run, test results, risks, and next step.

## Workflow
Implement one milestone at a time. Explain the smallest plan before coding. Prefer simple modules over premature abstractions. Do not claim an integration works until validated on macOS with required permissions.
