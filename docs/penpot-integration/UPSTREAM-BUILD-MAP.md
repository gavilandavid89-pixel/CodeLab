# Penpot 2.19.0 source and build map for CodeLab

This document records the upstream inspection used to plan an in-repository source integration. It is not a claim that Penpot has already been vendored or compiled.

## Immutable upstream pin

- Repository: `penpot/penpot`
- Tag: `2.19.0`
- Commit: `f66e5afa70e7d5e039b79cee758bf8e03510ad3e`
- Commit tree: `3f71bb4b15d7d58ce19980f82d7edeab443a3929`
- License: MPL-2.0
- Note: the root `package.json` at this tag reports package version `2.17.0`; do not infer source version from that package field. The Git tag and commit SHA are the pin.

## Source footprint

The recursive Git tree at the pinned commit contains 6,564 files (not truncated). Relevant groups:

| Area | Files | Purpose |
| --- | ---: | --- |
| `frontend/src` | 1,062 | ClojureScript application, workspace, UI, state and interaction logic |
| `frontend/resources` | 787 | styles, translations, icons, public assets and build resources |
| `common/src` | 184 | shared document types, geometry, serialization and render contracts |
| `render-wasm` | 238 | Rust renderer, build scripts, generated JS/WASM interface |
| `frontend` overall | 2,680 | frontend packages, scripts, tests, build configuration and resources |
| `common` overall | 325 | common Clojure/JS source and package metadata |

A handful of source files is not a viable editor import: the workspace namespaces depend on the shared common library, frontend state/store, styles, translations, UI component packages, workers and renderer contracts. The workspace itself is loaded as a lazy module from the app router.

## Required build graph

1. Node + pnpm 12.16.1 for the frontend package workspace.
2. Java/Clojure CLI for ClojureScript compilation via Shadow CLJS 3.5.3.
3. The complete `common` project as a local dependency of `frontend`.
4. Frontend package links including `@penpot/ui`, text-editor, tokenscript, draft-js, mousetrap and plugin runtime.
5. Asset/library generation and worker compilation.
6. Rust + Emscripten toolchain for `render-wasm` targeting `wasm32-unknown-emscripten`; its build script emits both JS glue and WASM artifacts.
7. A CodeLab-owned hosting shell that serves generated first-party assets and routes API calls through CodeLab authorization and persistence.

The frontend scripts at the pinned tag include `build:wasm`, `build:app:assets`, `build:app:main`, `build:app:libs`, and the package postinstall builds for plugin runtime and UI package. The Shadow CLJS main target is modular: `:main-workspace` is a distinct module entry, but depends on the shared runtime and app-level state. It is not an independently mountable React widget.

## Integration implication

CodeLab's current deployment uses `npm install` followed by `node server.js`. A valid integrated build therefore needs a separate, reproducible frontend build stage (including Java/Clojure and Emscripten) before the existing Node host starts. The Node server should remain the CodeLab host; the Penpot frontend must not introduce its own user/session/project database or durable asset service.

Do not change Render's production build/start commands until the complete vendor source, toolchain, reproducible build, CodeLab API adapter and end-to-end tests exist in this branch.

## Native workspace entry points verified

- `frontend/src/app/main.cljs`: application initialization, profile/auth bootstrap and router initialization.
- `frontend/src/app/main/ui.cljs`: lazy routing for dashboard, viewer and workspace.
- `frontend/src/app/main/ui/workspace.cljs`: canonical workspace composition; mounts the viewport, sidebar, palette and context menu.
- `frontend/src/app/main/ui/workspace/sidebar.cljs`: native left/right sidebar structure, layers, sitemap, assets and inspector modes.
- `frontend/src/app/main/ui/workspace/viewport.cljs`: canvas viewport, selection, geometry, tools and render integration.

These are source references for preserving Penpot's native workspace layout. They are not copied fragments to be compiled without their dependency closure.

## Required CodeLab adaptation (still pending)

- Replace Penpot's profile/team/file authorization boundary with CodeLab's authenticated account, workspace and project permissions.
- Replace Penpot's file persistence/websocket assumptions with CodeLab-owned project APIs and PostgreSQL/storage conventions.
- Preserve Penpot document/page/layer/component/prototype semantics so the generator can consume them without an export/import step.
- Keep PixelForge and its animation pipeline intact.
- Add a responsive mobile presentation around Penpot's native information architecture: tool rail compact/collapsible; page/layer and inspector panels switchable; canvas remains primary; touch pan/zoom and safe-area support.
- Preserve Penpot MPL-2.0 notices and upstream copyright in all copied/modified files, and include the full license text with the vendored source.
