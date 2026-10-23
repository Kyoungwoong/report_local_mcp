---
name: mcp-development
description: Build and review MCP tools, input schemas, approval boundaries and stdio protocol behavior.
---
# MCP development
1. Use official TypeScript MCP SDK and schema validation.
2. Expose read-only activity before implementing draft writes.
3. Draft workflow: read activity -> client LLM proposes -> save draft -> human confirms -> approve -> publish.
4. Approval requires an explicit user confirmation in the client; validate draft version and approval status on server. Do not interpret a model-generated yes as sufficient.
5. Never print debug logs to stdout. Test malformed inputs and unauthorized publication.
