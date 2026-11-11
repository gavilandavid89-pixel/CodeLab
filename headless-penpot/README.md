# CodeLab Headless Penpot Worker

Offline design and visual QA worker for the CodeLab agent. This is a local execution package, not a CodeLab web feature.

It uses the vendored Penpot source and its real editor bundle. The worker starts the editor under Xvfb, drives it with Playwright, captures screenshots, and exports the native Penpot workspace. It also has a separate web-preview runner for testing a generated CodeLab web app.

The design surface is the compiled Penpot editor, not a reduced custom command API. The normal Penpot workspace and toolset remain available: pages, layers, vectors, text, fills/strokes, gradients, typography, layout, components/variants, assets, libraries, prototyping, inspect/export and the normal canvas.

## Offline workflow

1. Build/download the immutable headless package.
2. Start `bin/codelab-headless.sh design`.
3. Work on the design locally.
4. Capture it repeatedly under Xvfb.
5. Run the web-preview/test mode against the generated application.
6. Export the native design workspace.
7. Only then send the artifact to CodeLab.

The browser worker blocks non-loopback HTTP(S) requests. It never installs packages or fetches fonts/assets at runtime.

## Commands

```bash
bin/codelab-headless.sh check
bin/codelab-headless.sh design
bin/codelab-headless.sh web --url http://127.0.0.1:3000 --capture
bin/codelab-headless.sh capture --url http://127.0.0.1:4310 --output artifacts/design.png
bin/codelab-headless.sh export --workspace ./workspace
```

The package is built by `.github/workflows/penpot-headless-package.yml` from the pinned `vendor/penpot` tree. The generated artifact contains the compiled editor plus this worker, so a later agent session can download one self-contained package instead of rebuilding Penpot.
