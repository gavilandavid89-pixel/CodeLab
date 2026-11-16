# CodeLab Native Penpot Runtime (Headless #1 component)

This directory contains the full native Penpot editor runtime used by **Headless #1**, the assistant's local CodeLab workbench. It is not Headless #2 and does not connect to the deployed CodeLab instance.

The parent `headless-local/` package combines this full editor with the actual CodeLab application source. The design surface is the compiled Penpot editor, not a reduced custom command API. The normal Penpot workspace and toolset remain available: pages, layers, vectors, text, fills/strokes, gradients, typography, layout, components/variants, assets, libraries, prototyping, inspect/export and the normal canvas.

## Commands

These commands can be invoked through the unified local launcher:

```bash
bin/codelab-local-headless.sh check
bin/codelab-local-headless.sh design
bin/codelab-local-headless.sh web --url http://127.0.0.1:3000 --capture
bin/codelab-local-headless.sh capture --url http://127.0.0.1:4310 --output artifacts/design.png
bin/codelab-local-headless.sh export --workspace ./workspace
```

The editor bundle is built from the pinned `vendor/penpot` source. The offline package includes the compiled editor and runtime dependencies; it does not fetch editor assets at runtime.
