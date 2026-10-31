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
- After `click`, `fill`, or `select`, the bridge captures a viewport screenshot after hiding text, inputs, code editors, frames, canvases, and images. The screenshot is uploaded as a GitHub Actions artifact with a one-day retention period so layout can be inspected without exposing readable project content.
- The bridge is intentionally allowlisted. Commands that click elements require `approval: "approved"`; avoid irreversible actions without explicit confirmation.
- Command payloads require protocol `codelab-agent-bridge/v1`, a unique `command_id`, and a valid future `expires_at`.

## Supported actions

- `status`: concise page/API readiness signals.
- `connections_status`: API health, OAuth configured booleans, and AI provider configuration.
- `ai_ping`: one low-token request through the existing AI provider endpoint; reports success/failure and model without returning model output.
- `read_page`: bounded page text snapshot. Use only when the resulting text is safe to expose in the issue thread.
- `list_controls`: visible DOM control metadata. In comment mailbox mode, labels/text are omitted to reduce accidental disclosure.
- `read_element`, `fill`, `select`, `click`: bounded DOM interactions using a CSS selector; `click` requires explicit approval.
- `sequence`: execute 1–8 approved `click`, `fill`, and/or `select` steps in order within the same authenticated browser page and context. Any click requires `approval: "approved"`. Each step reports success metadata only, and the final viewport screenshot is redacted. The browser context is not persisted after the workflow ends.

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

## Multi-step interaction example

Use an issue command (not a comment mailbox command) to perform a bounded sequence in one authenticated browser session:

```json
{
  "protocol": "codelab-agent-bridge/v1",
  "command_id": "replace-with-unique-id",
  "action": "sequence",
  "args": {
    "steps": [
      { "action": "click", "selector": "#openDesignTools" },
      { "action": "click", "selector": "#toggleDesignInspector" }
    ]
  },
  "use_admin_session": true,
  "expires_at": "2026-11-01T00:30:00Z",
  "approval": "approved"
}
```

## Diagnosing blocked or failed commands

Every bridge result includes structured diagnostics. Successful commands report the action, source, elapsed time, GitHub Actions run ID/attempt, and issue number. Failed commands additionally report a stage, a bounded error code, current sequence step (when relevant), and the page URL. Error text is stripped of HTML tags before it is posted.

Use the distinction below when diagnosing a tool block:

- **A GitHub Actions run exists:** inspect that run's job steps and logs. The bridge was invoked; its diagnostics identify where it failed.
- **The command comment/issue exists but no matching workflow run exists:** the GitHub workflow was not started or its event/condition did not match. Check the event type and owner-only condition.
- **ChatGPT rejected the tool call before a comment/issue was created:** CodeLab and GitHub Actions have no record of the rejected invocation. The bridge cannot reveal ChatGPT's internal refusal reason; record the time and attempted operation and use the platform's surfaced error/support route.

Never log or return passwords, cookies, session storage, API keys, or full private workspace contents. Because this repository is public, issue comments and workflow logs must be treated as public.

## Deployment state

The issue-triggered bridge is merged into `main`; real `status`, `list_controls`, and `connections_status` commands succeeded previously. The first AI ping exposed a DNS callback compatibility bug, which was fixed; a subsequent live ping returned HTTP 200 using `openai/gpt-oss-120b` via Groq. The live health response reported GitHub OAuth and Google OAuth as not configured, while the server-side AI key was configured. The bridge starts a fresh browser per command; session persistence is a separate planned improvement.
