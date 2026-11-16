# CodeLab dual-headless architecture

Status: implementation contract for the two independent headless runtimes.

## Headless #1 — assistant local workbench

Location/package: `headless-local/` plus the packaged CodeLab app and `headless-penpot/` runtime.

Purpose: give the assistant a self-contained local copy of the CodeLab revision being developed, with the real CodeLab application capabilities and the complete native Penpot editor. It is used to build, edit, execute and test locally before changes are sent to the repository/deployed app.

It must not be confused with a reduced Penpot-only CLI. The downloadable artifact includes the CodeLab app source, its declared runtime dependencies, the Penpot editor bundle, and the local browser worker. External integrations remain credential/service dependent and are explicitly identified as such.

## Headless #2 — repo-hosted remote connector

Location: `headless-codelab/` and `public/codelab-headless-agent.js`.

Purpose: connect to the real CodeLab origin (normally the Render deployment), authenticate through a user-provided browser session, and execute an explicit semantic command protocol against that live application. It gathers screenshots, page state, console messages, JavaScript exceptions, failed requests, HTTP errors and WebSocket diagnostics.

It does not host the assistant's working copy, and it does not replace the local workbench.

## Data flow

```text
Assistant environment
  Headless #1: local CodeLab app + full Penpot + local browser
             | validated changes / test artifacts
             v
CodeLab Git repository (feature branch)
             |
             v
  Headless #2: remote semantic browser connector
             | authenticated semantic commands + diagnostics
             v
       Real CodeLab / Render
       visual and persisted-state truth
```

## Safety and deployment

- Keep the two packages separately named, versioned and downloadable.
- Do not merge to `main` or deploy Render as part of package validation.
- Remote browser actions use an allowlisted semantic protocol, never arbitrary page JavaScript.
- Remote session state and credentials are user supplied; never package or log secrets.
- GitHub Actions is CI/evidence infrastructure, not a headless runtime.
- A successful local build does not prove remote persistence; a successful remote page load does not prove all CodeLab workflows. Both suites are required.
