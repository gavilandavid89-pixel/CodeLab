# CodeLab Agent Space — GitHub bridge

## Purpose

Use GitHub as an auditable command mailbox between ChatGPT's connected GitHub tools and the public CodeLab website. A repository-owner issue triggers a short-lived GitHub Actions job that runs a bounded browser command. This is an operational bridge, not a test suite; it does not execute arbitrary repository code.

## Current architecture and boundaries

- Repository: `gavilandavid89-pixel/CodeLab`
- Target: `https://codelab-pbw9.onrender.com/`
- Commands are new issues titled `[CodeLab Bridge] ...`. The workflow accepts only issues opened by the repository owner.
- The job uses a fresh, unauthenticated Playwright browser. It does not control the user's existing browser, inherit their login, or provide direct access to private server files.
- Results are posted as a JSON comment on the same issue. ChatGPT can create commands and read replies through the connected GitHub integration.
- The app's `/api/health` endpoint reports configuration booleans and non-secret AI metadata. The `connections_status` command returns those diagnostics without exposing API keys or profile data.
- The bridge is intentionally allowlisted. Commands that click elements require `approval: "approved"`; avoid using the bridge for irreversible actions without explicit confirmation.
- Command payloads require a valid future `expires_at`, a unique `command_id`, and protocol `codelab-agent-bridge/v1`.

## Supported actions

- `status`: concise page/API readiness signals.
- `connections_status`: API health, GitHub/Google OAuth configured booleans, and AI provider configuration.
- `ai_ping`: one low-token request through the existing AI provider endpoint; reports success/failure and model without returning model output.
- `read_page`: a bounded text snapshot of the public page.
- `list_controls`: visible DOM control metadata.
- `read_element`, `fill`, `select`, `click`: allowlisted DOM interactions using a CSS selector; `click` requires explicit approval.

Never place API keys, access tokens, cookies, or private project contents in issue bodies or comments. The browser is anonymous, but public page text may still be visible in the public issue thread; keep snapshots minimal.

## Example command

```json
{
  "protocol": "codelab-agent-bridge/v1",
  "command_id": "replace-with-unique-id",
  "action": "connections_status",
  "args": {},
  "expires_at": "2026-10-31T00:30:00Z",
  "approval": "not-required"
}
```

## Deployment state

The issue-triggered bridge is merged into `main`; real `status`, `list_controls`, and `connections_status` commands succeeded on 2026-10-30. The first AI ping exposed a DNS callback compatibility bug, which was fixed; a subsequent live ping returned HTTP 200 using `openai/gpt-oss-120b` via Groq. The live health response reports GitHub OAuth and Google OAuth as not configured, while the server-side AI key is configured. The operational browser connection still uses a fresh anonymous session; it does not inherit the user's signed-in session or expose private workspace data. Keep this distinction explicit.
