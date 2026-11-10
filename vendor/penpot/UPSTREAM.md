# Vendored Penpot source

Upstream: https://github.com/penpot/penpot
Pin: tag 2.19.0
Commit: f66e5afa70e7d5e039b79cee758bf8e03510ad3e
License: MPL-2.0 (see LICENSE)

## Source files currently staged

- frontend/src/app/main.cljs
- frontend/src/app/main/ui.cljs
- frontend/src/app/main/ui/workspace.cljs
- frontend/src/app/main/ui/workspace/sidebar.cljs
- frontend/src/app/main/ui/workspace/viewport.cljs
- frontend/package.json
- frontend/deps.edn
- frontend/shadow-cljs.edn
- common/package.json
- common/deps.edn
- root package.json
- root deps.edn
- LICENSE

## Important status

This is the first source-level vendor slice, not a complete Penpot source import and not a buildable editor yet. The workspace entry points depend on the rest of Penpot's frontend, common source tree, resources, package workspace, plugin runtime, translations and render-WASM artifacts. Those dependency closures still need to be brought into this repository before enabling a build.

Do not add a runtime clone, git submodule, external iframe or .penpot upload/import workflow as a shortcut. Do not switch Render's production build command or deploy this partial source slice.

The next source-vendoring stage must include the complete dependency closure for the pinned workspace module and renderer, preserve upstream file headers/notices, then run a reproducible build in CI. Only after that should CodeLab API integration and the editor mount be enabled.


## Expanded source staging — 2026-11-10

The pinned source staging has been expanded beyond the initial workspace slice. The current CodeLab branch contains 205 files under `vendor/penpot`, including:
- 124 ClojureScript/Clojure shared source files across the workspace, drawing, selection, path editing, layers, pages, tokens, worker and UI areas;
- 20 Rust renderer source files plus Cargo manifest, lockfile and build entrypoint;
- 26 SCSS files for the base workbench, viewport, toolbar, sidebar, palettes, themes and typography;
- the upstream UI package and rich-text editor entrypoints and selected implementation modules;
- pinned pnpm workspace and lockfiles, frontend build scripts, and a small initial set of font assets.

**This is still a partial vendoring stage, not a complete Penpot source import or a buildable editor.** The upstream dependency closure still includes many additional ClojureScript namespaces, common geometry/types, frontend resources, translations, plugins, text-editor modules, Rust/WASM source files, generated artifacts and build tooling. The CodeLab branch must not be merged or deployed until that closure is complete, the upstream build runs reproducibly inside the CodeLab repository, and the native document/RPC/WebSocket adapters are tested end to end.
