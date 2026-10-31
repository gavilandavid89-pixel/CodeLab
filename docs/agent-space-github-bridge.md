# CodeLab Agent Space — GitHub bridge

## Purpose

Use GitHub as an auditable command mailbox between ChatGPT's connected GitHub tools and the CodeLab website. A repository-owner command triggers a short-lived GitHub Actions job that runs a bounded Playwright browser command. This is an operational bridge, not a test suite; it does not execute arbitrary repository code.

## Current architecture and boundaries

- Repository: `gavilandavid89-pixel/CodeLab`
- Target: `https://codelab-pbw9.onrender.com/`
- Commands may be sent by opening an issue titled `[CodeLab Bridge] ...` or, after the mailbox workflow is enabled, by posting a command as a new comment on an existing issue with that title.
- Only commands authored by the repository owner are executed. Bot-generated result comments do not trigger commands.
- Comment-triggered commands are restricted in the bridge script to the read-only actions `status`, `connections_status`, and `list_controls`. In comment mode, control text/labels are omitted; only structural metadata such as tag, ID, type, and disabled state is returned. Mutating actions remain on the explicit issue-command path.
- Comment mailbox commands avoid creating a new issue for each read-only query. Reuse a dedicated bridge issue rather than creating repeated issues.
- The job uses a fresh Playwright browser for each command. It does not control the user's existing browser or inherit their browser login.
- When `use_admin_session: true`, the bridge signs in through CodeLab using GitHub Actions secrets. Credentials are never read from command payloads.
- Results are posted as JSON comments on the same issue. Treat this repository's issue threads as potentially public: never send passwords, tokens, cookies, API keys, or private workspace/project contents in command results.
- The app's `/api/health` endpoint reports configuration booleans and non-secret AI metadata. The `connections_status` command returns those diagnostics without exposing API keys.
- The bridge is intentionally allowlisted. Commands that click elements require `approval: "approved"`; avoid irreversible actions without explicit confirmation.
- Command payloads require protocol `codelab-agent-bridge/v1`, a unique `command_id`, and a valid future `expires_at`.

## Supported actions

- `status`: concise page/API readiness signals.
- `connections_status`: API health, OAuth configured booleans, and AI provider configuration.
- `ai_ping`: one low-token request through the existing AI provider endpoint; reports success/failure and model without returning model output.
- `read_page`: bounded page text snapshot. Use only when the resulting text is safe to expose in the issue thread.
- `list_controls`: visible DOM control metadata. In comment mailbox mode, labels/text are omitted to reduce accidental disclosure.
- `read_element`, `fill`, `select`, `click`: bounded DOM interactions using a CSS selector; `click` requires explicit approval.

## Comment mailbox example

Post the JSON command as a new comment on an existing issue titled `[CodeLab Bridge] ...`. The workflow consumes the comment body, executes the allowlisted action, and adds a result comment to the same issue. Use a unique command ID for every request.

```json
{
  "protocol": "codelab-agent-bridge/v1",
  "command_id": "replace-with-unique-id",
  "action": "status",
  "args": {},
  "use_admin_session": true,
  "expires_at": "2026-11-01T00:30:00Z",
  "approval": "not-required"
}
```

## Deployment state

The issue-triggered bridge is merged into `main`; real `status`, `list_controls`, and `connections_status` commands succeeded previously. The first AI ping exposed a DNS callback compatibility bug, which was fixed; a subsequent live ping returned HTTP 200 using `openai/gpt-oss-120b` via Groq. The live health response reported GitHub OAuth and Google OAuth as not configured, while the server-side AI key was configured. The bridge starts a fresh browser per command; session persistence is a separate planned improvement.
