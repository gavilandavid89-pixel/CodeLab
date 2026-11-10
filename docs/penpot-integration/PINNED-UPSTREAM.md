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

## Build verification

The pinned Penpot 2.19.0 frontend source was successfully built on 2026-11-10 in CodeLab GitHub Actions run [42758280222](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/42758280222).

The run passed:
- immutable upstream source-pin verification;
- official `penpotapp/devenv` toolchain verification;
- shared JVM class compilation;
- frontend, worker, plugin and WASM compilation;
- compiled artifact verification and upload.

Uploaded artifact:
- Name: `codelab-penpot-2.19.0-frontend`
- Artifact ID: `13737275293`
- Size: 133,607,725 bytes
- Retention expiry: 2026-11-24

This is a successful source build artifact, not yet a deployed or mounted CodeLab editor. It is a temporary GitHub Actions artifact with a 14-day retention period; the production build/mount strategy and native RPC backend integration remain open.
