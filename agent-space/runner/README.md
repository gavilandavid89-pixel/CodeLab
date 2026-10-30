# Agent Space browser runner

This runner launches a real Chromium browser in an isolated CI process, opens the CodeLab Agent Space route, performs a small set of UI interactions, and saves a screenshot plus a JSON report as a GitHub Actions artifact.

## Run locally

1. Install Node.js 20+.
2. Install Playwright and Chromium: `npm install --no-save playwright` and `npx playwright install chromium`.
3. Start CodeLab with a disposable data directory and a non-production secret:
   `PORT=3188 CODELAB_DATA_DIR=/tmp/codelab-agent-space-data CODELAB_WORKSPACE_SECRET=local-ci-only-secret node server.js`.
4. In another terminal run:
   `CODELAB_E2E_BASE_URL=http://127.0.0.1:3188 AGENT_SPACE_ARTIFACT_DIR=artifacts node agent-space/runner/smoke.mjs`.

## Evidence

The workflow uploads `agent-space-live.png` and `agent-space-report.json` as the `agent-space-browser-evidence` artifact. Failed runs attempt to upload `agent-space-failure.png` and include the server log.

## Important boundary

This is a browser runner for repeatable inspection, not yet a persistent, externally addressable command channel for ChatGPT. It never exposes a public endpoint that executes arbitrary commands. A later remote-control integration must authenticate every session, isolate browser profiles and test data, audit actions, restrict commands to an allowlist, and keep the browser runner separate from the production web process.
