# CodeLab Agent Space — GitHub bridge

## Purpose

Use GitHub as an auditable mailbox between an external operator and CodeLab Agent Space. This is not a GitHub Actions test runner and must not execute arbitrary repository code.

## Important boundary

A GitHub issue or comment is only a message. It does not itself grant ChatGPT access to a browser. The CodeLab service and an authorized browser client must be running, and the ChatGPT side must have an available GitHub connection to write commands and read replies.

## Proposed protocol (v1)

- Repository: `gavilandavid89-pixel/CodeLab`
- Commands are GitHub issues labeled `agent-bridge:command`.
- Replies are comments from the CodeLab bridge bot, with a machine-readable JSON block.
- Each command has a unique `command_id`, an allowlisted `action`, and bounded arguments.
- Supported action names should be limited to `status`, `read_page`, `list_controls`, `click`, `read_element`, `fill`, and `select`.
- Every command must be validated against a strict schema; unknown actions, oversized input, malformed selectors, and expired commands must be rejected.
- Commands that submit forms, delete data, purchase items, publish content, or otherwise cause consequential external changes require explicit per-command human approval.
- Replies must include `command_id`, `status` (`accepted`, `running`, `succeeded`, `failed`, or `rejected`), timestamps, and a concise result/error.
- Never put secrets, session cookies, access tokens, or full page contents into issues/comments. Redact personal data from snapshots.

## Example command body

```json
{
  "protocol": "codelab-agent-bridge/v1",
  "command_id": "replace-with-unique-id",
  "action": "status",
  "args": {},
  "expires_at": "2026-10-30T23:00:00Z",
  "approval": "not-required"
}
```

## Deployment plan

1. Add the server-side GitHub mailbox adapter using a dedicated least-privilege credential stored only as a Render environment variable.
2. Add a browser-client relay that receives validated commands and runs only the allowlisted DOM actions inside the same-origin Agent Space iframe.
3. Add status/reply reporting back to the originating GitHub issue.
4. Add a health endpoint that reports configuration state without exposing credentials.
5. Deploy only the CodeLab Render service after reviewing the code diff. Do not trigger CI or browser tests unless explicitly requested.

## Current status

This document defines the protocol only. The operational mailbox adapter, browser relay, credentials, and end-to-end connectivity are not implemented yet. Do not describe the bridge as connected until a real command has been executed and its reply verified.
