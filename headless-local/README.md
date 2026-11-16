# CodeLab Local Headless Workbench

This is Headless #1: the assistant's own local, downloadable working environment. It is deliberately separate from the repo-hosted remote connector in `headless-codelab/`.

## What it contains

The package is assembled from the **actual CodeLab application source** in this repository, not a mock interface:
- the CodeLab web application and its existing workspaces, projects, code editors, preview, branches, versioning, imports/exports and project tools;
- the existing agent, AI-provider configuration, mailbox and workflow features present in the packaged CodeLab revision;
- the full pinned Penpot editor and its native canvas/toolset (pages, layers, vectors, text, fills, strokes, gradients, typography, components, assets, libraries, prototyping, inspect/export);
- a local Chromium/Playwright runtime for semantic interaction, screenshots and diagnostics.

The package includes the CodeLab source snapshot and runtime dependencies. Capabilities that inherently require a configured external provider, OAuth credentials, network service, or PostgreSQL instance remain configuration-dependent; the package does not invent credentials or silently substitute a production service.

## Commands

```bash
bin/codelab-local-headless.sh check
bin/codelab-local-headless.sh app
bin/codelab-local-headless.sh design
bin/codelab-local-headless.sh web --url http://127.0.0.1:3000 --capture
bin/codelab-local-headless.sh capture --url http://127.0.0.1:3000
bin/codelab-local-headless.sh export --workspace ./workspace
```

- `app`: starts the packaged CodeLab server locally.
- `design`: starts the full native Penpot editor.
- `web`: opens a CodeLab page in Chromium and records console, JS, HTTP, request and WebSocket diagnostics.
- `check`: validates the bundled app, Penpot editor and runtime dependencies.

The app uses local configuration only. Set `PORT`, `DATABASE_URL`, provider API variables, and OAuth settings only when the corresponding capability is needed. Never put production secrets in this package.

## Offline boundary

The source, editor and local browser runtime are packaged. Features that depend on external APIs, OAuth identity providers, hosted storage, remote model providers or a live database cannot be made genuinely offline merely by bundling frontend code. Those integrations are reported as unavailable until configured; local project work and design remain available where supported by the application.

## Separation contract

- This package is Headless #1 and works against its own local CodeLab instance.
- `headless-codelab/` is Headless #2 and connects to the real deployed CodeLab origin.
- GitHub Actions builds and validates packages/evidence; it is not either headless runtime.
- Render remains the visual truth for the deployed application.
