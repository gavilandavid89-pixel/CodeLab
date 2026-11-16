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
bin/codelab-local-headless.sh db-up
bin/codelab-local-headless.sh app
bin/codelab-local-headless.sh db-down
bin/codelab-local-headless.sh design
bin/codelab-local-headless.sh web --url http://127.0.0.1:3000 --commands commands.json --capture
bin/codelab-local-headless.sh capture --url http://127.0.0.1:3000
bin/codelab-local-headless.sh export --workspace ./workspace
```

- `db-up`: starts an isolated PostgreSQL 16 container bound only to `127.0.0.1:55432`, with a persistent Docker volume.
- `app`: starts the packaged CodeLab server and, by default, starts/waits for that local PostgreSQL service. This enables real local accounts, workspace persistence, agent command storage and other database-backed CodeLab features. It never connects to production unless the operator explicitly sets `CODELAB_LOCAL_ALLOW_DATABASE=1` with a chosen `DATABASE_URL`.
- `db-down`: stops the local database but keeps its data volume.
- `design`: starts the full native Penpot editor.
- `web`: opens a CodeLab page in Chromium, executes an optional semantic command file (`--commands`) and records console, JS, HTTP, request and WebSocket diagnostics.
- `check`: validates the bundled app, Penpot editor and runtime dependencies.

The app uses local configuration only. The launcher creates a local database URL automatically for the isolated container. Set `PORT`, provider API variables and OAuth settings only when the corresponding capability is needed. AI providers and OAuth still require the user's own credentials and network access. Never put production secrets in this package. For frontend-only inspection without Docker, set `CODELAB_LOCAL_NO_DATABASE=1`; authentication and database-backed workflows will then be unavailable.

## Offline boundary

The source, editor, local browser runtime and a persistent local PostgreSQL service definition are packaged. Local accounts and database-backed CodeLab workflows can run against the isolated container. Features that depend on external APIs, OAuth identity providers, hosted storage, collaboration services or remote model providers still require those services and credentials; no production service or secret is silently substituted.

## Separation contract

- This package is Headless #1 and works against its own local CodeLab instance.
- `headless-codelab/` is Headless #2 and connects to the real deployed CodeLab origin.
- GitHub Actions builds and validates packages/evidence; it is not either headless runtime.
- Render remains the visual truth for the deployed application.

See [`docs/penpot-integration/DUAL-HEADLESS-ARCHITECTURE.md`](../docs/penpot-integration/DUAL-HEADLESS-ARCHITECTURE.md) for the binding separation contract and responsibilities of both headless systems.
