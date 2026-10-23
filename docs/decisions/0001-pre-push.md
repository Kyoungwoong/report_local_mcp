# ADR-0001 — Git pre-push as an attempt signal

Decision: use per-repository `pre-push` hook to record attempted ref updates without requiring an always-running MCP server. The hook is fast and fail-open. It does not prove success; later remote verification may mark events VERIFIED or UNVERIFIED. Preserve existing hooks. This prioritizes natural `git push` UX over exact success timestamps. Revisit a wrapper if precise post-push status becomes essential.
