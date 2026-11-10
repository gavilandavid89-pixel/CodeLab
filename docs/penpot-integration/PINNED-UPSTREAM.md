# Penpot upstream source pin

- Repository: https://github.com/penpot/penpot
- Release tag: 2.19.0
- Immutable commit: `f66e5afa70e7d5e039b79cee758bf8e03510ad3e`
- License: Mozilla Public License 2.0 (MPL-2.0)
- Vendored location: `vendor/penpot/`

The vendored directory is a complete source snapshot of this upstream commit.
Runtime CodeLab processes must not clone or download Penpot source. Source
updates are explicit, pinned changes reviewed in this repository.

The frontend build uses Penpot's official `penpotapp/devenv` build environment
and the pinned upstream `frontend/scripts/build` pipeline. The workflow checks
Node, pnpm, Java, Rust and Emscripten versions against the vendored Dockerfile
and records the resolved build-image digest for each run. The Penpot source snapshot and its build
outputs are distinct from the CodeLab Node.js host and must not change the
production Render start/build configuration until the integrated application
has passed end-to-end validation.
