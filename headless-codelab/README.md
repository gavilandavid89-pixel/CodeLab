# CodeLab Headless Remote Connector (Headless #2)

This directory is **not** the assistant's local working environment. It is the repo-hosted remote connector that opens the real CodeLab web application (normally the Render deployment), authenticates with a user-provided browser session, and executes semantic operations against that live application.

- **Headless #1:** `headless-local/` + the CodeLab app source + `headless-penpot/`; used by the assistant to build and test locally.
- **Headless #2:** this directory + `public/codelab-headless-agent.js`; connects to the real deployed CodeLab origin.
- **Render:** visual and persisted-state truth.
- **GitHub Actions:** builds packages and captures CI evidence; it is not the remote interaction mechanism.

## Run

```bash
headless-codelab/bin/codelab-headless.sh remote \
  --url https://YOUR-CODELAB-RENDER.example.com/ \
  --allow-external \
  --commands commands.json \
  --screenshot
```

Commands:

```json
[
  {"action":"inspect","required":true},
  {"action":"navigate","args":{"path":"/design"},"required":true},
  {"action":"inspect","required":true},
  {"action":"save","required":false}
]
```

Use `--session-dir` for a persistent browser profile or `--auth-state` for a user-supplied Playwright storage-state file. Never commit that state file or embed credentials in the package.

## Protocol and evidence

The page bridge exposes `window.__codelabEditorAgent` and a versioned semantic dispatch protocol. Commands are allowlisted; navigation is same-origin; arbitrary JavaScript execution is not exposed. The worker records the final app state, screenshots, console messages, uncaught JavaScript exceptions, failed requests, HTTP errors and WebSocket socket errors. A successful connection alone does not prove that a save or workflow persisted; verify the resulting state after each mutation.

## Safety

- External requests are blocked unless `--allow-external` is explicitly supplied.
- No production database credentials are packaged.
- Browser authentication is supplied by the operator.
- This connector does not host a local CodeLab copy or replace Headless #1.
