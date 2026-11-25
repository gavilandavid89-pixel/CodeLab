# CodeLab: GitHub wake and command bridge

## Purpose

This document records the existing GitHub Actions path that wakes the Render-hosted CodeLab service and the separate path that executes browser commands against it. GitHub is the wake trigger / automation runner here; Neon remains a separate persistence and native-agent-bridge component.

Production target referenced by the current workflows: `https://codelab-pbw9.onrender.com/`.

## 1. One-shot wake: `[CodeLab Live]`

Implementation: `.github/workflows/codelab-live-wake.yml`

- Event: `issue_comment`, activity type `created`.
- Gate: issue number must be **492** and the comment body must start with `[CodeLab Live]`.
- Runner: GitHub-hosted `ubuntu-latest`.
- Runtime limit: 2 minutes.
- Action: performs a `curl` GET to the CodeLab homepage, with a 60-second request timeout and up to two retries.
- Rendezvous issue: [CodeLab issue #492](https://github.com/gavilandavid89-pixel/CodeLab/issues/492).

### Operator sequence

1. Post a new comment on issue #492 beginning with `[CodeLab Live]`.
2. GitHub emits the `issue_comment.created` event and starts the workflow.
3. The runner requests the production homepage. If Render has suspended the web service, this incoming request is the wake-up traffic.
4. Wait for the workflow run to finish and inspect its result before sending a command that depends on the web process being online.

Example wake comment:

```text
[CodeLab Live] Wake CodeLab before processing the next command.
```

This workflow only performs a one-shot HTTP touch. It does not itself execute a CodeLab command and does not prove that a Neon worker has completed a task.

## 2. Browser command execution: `[CodeLab Bridge]`

Implementation:

- Workflow: `.github/workflows/codelab-command-bridge.yml`
- Runner script: `.github/scripts/codelab-bridge.mjs`

Triggers:

- A new issue whose title starts with `[CodeLab Bridge]`, or
- A new comment on an issue whose title starts with `[CodeLab Bridge]`.

The workflow accepts these events only when the issue author (for issue creation) or comment author (for comments) is the repository owner. It checks out the trusted implementation from `main`, installs Playwright/Chromium, and runs the allowlisted command against the fixed CodeLab production origin.

### Command envelope

The issue body or comment body is JSON (optionally fenced) using protocol `codelab-agent-bridge/v1`. The script validates a unique command ID, expiry, an allowlisted action, and requires `use_admin_session: true`.

Minimal read-only example:

```json
{
  "protocol": "codelab-agent-bridge/v1",
  "command_id": "status-check-20261122",
  "action": "status",
  "use_admin_session": true,
  "expires_at": "2026-11-22T04:00:00.000Z",
  "args": {}
}
```

For an issue-body command, use a new issue titled with the `[CodeLab Bridge]` prefix. For a follow-up command, add a comment to that same issue. The script posts a `## CodeLab Bridge result` comment containing JSON with `status: succeeded` or `status: failed`, diagnostics, command ID, and the result/error.

### Authentication and safety

- The runner reads `CODELAB_ADMIN_USERNAME` and `CODELAB_ADMIN_PASSWORD` from repository Actions secrets. Never put credentials in an issue or comment.
- The username must be exactly `ADMIN`; the script verifies the local ADMIN identity and workspace through CodeLab's auth endpoints before running the action.
- The target origin is hard-allowlisted to `https://codelab-pbw9.onrender.com`.
- Actions are allowlisted by the script. Commands received through comments have an additional restricted action set.
- Comment-originated state-changing actions require `approval: "approved"`. High-impact operations such as permanent project deletion and branch merge/undo have explicit approval checks.
- Do not treat a workflow being queued or started as proof that the command succeeded; read the result comment and its status.

## 3. Relationship to the Neon native bridge

The GitHub wake workflow and the Neon native bridge solve different parts of the lifecycle:

1. When Render has suspended CodeLab, there is no running Node process to hold a PostgreSQL `LISTEN` connection. A database notification alone cannot start a suspended Render web service.
2. The `[CodeLab Live]` GitHub Actions workflow supplies the external HTTP request that wakes the Render web service.
3. During server startup, CodeLab arms its Neon `LISTEN codelab_agent_bridge_wake` listener and reconciles durable pending wake commands.
4. When the listener receives `codelab_agent_bridge_wake`, the server starts `agent-bridge-worker.mjs`.
5. The worker processes the queued native command and writes its result/status back to the command mailbox.

Important startup-race detail: the server's startup reconciliation query only considers unexpired queued commands whose JSON payload contains `"wake": true`. Therefore, when a command must survive the interval while CodeLab is asleep/restarting, insert it with `payload: { "wake": true, ... }`. A queued row without that flag can emit a notification while no listener exists and will not match that startup-reconciliation query later.

The GitHub browser command bridge is an alternate execution path: it runs Playwright in a GitHub-hosted runner and talks to CodeLab over HTTP. It is not the same as the Neon worker. Choose deliberately between:
- **GitHub + Playwright:** use `[CodeLab Bridge]` to run a browser/UI action through Actions.
- **Neon native worker:** use the command mailbox for native worker actions; if the Render process may be asleep, first issue the `[CodeLab Live]` wake comment, then enqueue a durable command with `payload.wake=true`.

## 4. Operational checklist

- [ ] Confirm the workflow files exist on the default branch (`main`); GitHub documents that `issue_comment` workflows only trigger when the workflow file exists on the default branch.
- [ ] Use issue #492 for one-shot live wake comments.
- [ ] Check the `CodeLab live wake` Actions run completed before assuming the app is awake.
- [ ] For browser commands, use an issue titled `[CodeLab Bridge] ...` and read the final result comment.
- [ ] For Neon native commands after a wake, set `payload.wake=true` and verify the command row transitions beyond `queued`.
- [ ] Keep ADMIN credentials only in GitHub Actions secrets; never include them in GitHub issue/comment bodies.
- [ ] Do not merge/deploy documentation or code changes to production without explicit approval.

## 5. Source files

- `.github/workflows/codelab-live-wake.yml`
- `.github/workflows/codelab-command-bridge.yml`
- `.github/scripts/codelab-bridge.mjs`
- `server.js` — `ensureAgentBridgeWakeListener`, `startAgentBridge`, and the PostgreSQL notification setup
- `agent-bridge-worker.mjs` — native command consumer
- `assistant-headless-client.mjs` — reference client for the native mailbox protocol
