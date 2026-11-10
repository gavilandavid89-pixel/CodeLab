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
