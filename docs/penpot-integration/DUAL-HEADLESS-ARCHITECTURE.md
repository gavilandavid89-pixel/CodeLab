# CodeLab dual-headless architecture

This repository intentionally contains **two independent headless systems**. They have different owners, execution locations, security boundaries and jobs. They must never be collapsed into one package or described as interchangeable.

## Headless #1 — assistant-local CodeLab workbench

**Location:** `headless-local/` + the packaged CodeLab app source + `headless-penpot/` + the compiled Penpot distribution.

**Purpose:** give the assistant a complete, isolated CodeLab working environment in which to build, modify, run and validate the product before proposing or transferring changes to the real deployment.

It packages the actual CodeLab application source (not a mock) and the full pinned Penpot editor. The CodeLab capabilities available in the packaged revision include workspaces/projects, code editors/live preview, imports/exports, branches/version history, agent and AI-provider settings, mailbox/approval workflows and native Penpot design. The package's `runtime/capabilities.json` is the machine-readable inventory.

Commands:

```bash
bin/codelab-local-headless.sh check
bin/codelab-local-headless.sh app
bin/codelab-local-headless.sh design
bin/codelab-local-headless.sh web --url http://127.0.0.1:3000 --commands commands.json --capture
bin/codelab-local-headless.sh export --workspace ./workspace
```

The app source and browser/editor runtime are bundled. Capabilities requiring PostgreSQL, external AI providers, OAuth identity providers, hosted storage or collaboration services remain dependent on explicit configuration. No production credentials, user sessions or production database are included. This is an offline-capable workbench, not a claim that every network-backed CodeLab integration can work without its service.

## Headless #2 — repository remote connector

**Location:** `headless-codelab/` + `public/codelab-headless-agent.js`.

**Purpose:** connect directly to the real CodeLab web origin (normally the Render deployment), authenticate using an operator-supplied browser session, and execute allowlisted semantic commands against that running application. It does not host a second local CodeLab copy and does not use coordinate-based mouse automation.

Commands:

```bash
headless-codelab/bin/codelab-headless.sh check
headless-codelab/bin/codelab-headless.sh remote \
  --url https://YOUR-CODELAB-RENDER.example.com/ \
  --session-dir .codelab-headless-session \
  --commands commands.json \
  --screenshot
```

A Playwright storage-state file can be supplied with `--auth-state state.json`; never commit it. The persistent session directory also contains authentication state and must be treated as a secret. The page bridge exposes a versioned allowlisted protocol; navigation is same-origin and arbitrary JavaScript evaluation is not a supported command.

The worker captures final application state, screenshot, console messages, uncaught JavaScript exceptions, failed requests, HTTP failures and WebSocket errors. A successful page load is not proof that a mutation persisted: after each write, inspect the resulting state or reload and verify it.

## Ownership and data flow

1. Headless #1 performs implementation and local validation against its own packaged CodeLab instance.
2. Changes are prepared in the CodeLab repository/branch.
3. Headless #2 connects to the real deployed CodeLab origin and runs semantic checks against the actual application.
4. The remote worker records evidence and diagnostics. Render remains the visual and persisted-state truth.
5. GitHub Actions builds, tests and stores artifacts. Actions is CI/evidence infrastructure, not the remote semantic controller.

## Hard boundaries

- Never point Headless #1 at production data by inheriting an environment variable. Its launcher ignores `DATABASE_URL` unless the operator explicitly opts in.
- Never package production credentials, OAuth secrets, provider API keys or browser session files.
- Headless #2 must not silently fall back to a local app when the remote target is unavailable.
- A command returning `ok: true` is not proof of persistence; verify the resulting application state.
- Keep the two package names, launchers, artifact names, documentation and CI jobs distinct.
- Do not merge this branch into `main` or deploy to Render without explicit authorization.
