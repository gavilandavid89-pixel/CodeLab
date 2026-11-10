# Penpot native editor integration — architecture decision

Status: accepted direction, implementation in progress  
Upstream baseline: Penpot 2.19.0  
Upstream commit: f66e5afa70e7d5e039b79cee758bf8e03510ad3e  
License: MPL-2.0

## Product decision

CodeLab adopts Penpot's own professional workspace interface and information architecture. The Penpot workspace is the reference implementation, not a visual mood board and not a reason to redesign the editor chrome from scratch.

Preserve the established Penpot workbench:
- top-level application/navigation chrome and contextual actions in their native hierarchy;
- left-side tool rail and page/layer navigation;
- central infinite canvas/viewport as the dominant work area;
- right-side contextual properties, design controls and inspector;
- native selection, zoom, pan, rulers/guides, layers, pages, assets, components and prototyping affordances;
- contextual menus and panels that open from their expected controls rather than being permanently stacked over the canvas.

Do not transplant CodeLab's current experimental design toolbar/layers overlay on top of the Penpot workspace. Do not add a second competing toolbar. CodeLab-specific actions should be integrated into Penpot's existing navigation, menus, panels or contextual actions.

## Mobile behavior

Keep the same information architecture on small screens; adapt presentation, not product semantics:
- canvas remains the primary surface;
- tool rail may collapse to a compact reachable strip;
- pages/layers and inspector become switchable drawers/sheets, never permanent canvas overlays;
- panels must be dismissible and restore the previous canvas viewport/selection;
- touch targets must be at least 44 CSS px; support pinch zoom, two-finger pan and safe-area insets;
- no horizontal page overflow and no controls trapped beneath browser/system bars.

Desktop remains the canonical full-workbench arrangement. Mobile is a deliberate responsive adaptation of the same workspace, not a separate simplified editor.

## Integration boundary

Penpot source and the required build chain must live in this CodeLab repository at a pinned upstream revision. No git submodule, runtime clone, external Penpot deployment, Penpot Cloud iframe, uploaded .penpot archive importer, or external repository read at runtime.

CodeLab remains the system of record:
- existing CodeLab account identity, authentication, workspace membership and permissions;
- existing project/workspace identity and navigation;
- existing PostgreSQL connection and persistence conventions;
- existing durable asset storage and project history.

The editor integration must map Penpot's document/page/component/prototype state into CodeLab-owned project records and APIs. Do not introduce a second user directory, independent project database, or separate durable asset store.

## CodeLab-specific connections

- Penpot pages/boards map to CodeLab design screens.
- Penpot prototype links, triggers and transitions map to CodeLab navigation and interaction definitions.
- Penpot components, variants, styles and design tokens map to the CodeLab visual system and generated application assets.
- A design change must be saved through CodeLab's existing project persistence and be available to the CodeLab generator without exporting/importing a file.
- Keep the existing web editor, preview/run, AI agents, provider/API settings, project history and deployment workflows available through CodeLab's existing application navigation.
- Preserve PixelForge and its complete animation pipeline. Penpot prototype transitions may be an additional source of interaction/animation specification; they must not replace PixelForge.

## Technical constraints discovered

Penpot 2.19.0 is not a standalone React widget. Its workspace is ClojureScript/Rumext and depends on the shared `common` Clojure modules, generated frontend assets, Shadow CLJS, JVM/Clojure tooling, JavaScript package workspaces and the `render-wasm` renderer. The upstream frontend build also invokes plugin-runtime and UI package builds.

CodeLab currently deploys as a Node application (`npm install`, `node server.js`) and its existing browser UI is plain HTML/JavaScript. Therefore the integration must explicitly provide a reproducible build stage for Penpot's source and WASM outputs, then serve the resulting first-party assets from the CodeLab application. Merely copying `workspace.cljs`, embedding a prebuilt opaque bundle, or adding an iframe is not an acceptable integration.

Before changing the Render build/start commands, verify the complete build in CI and retain the current Node server as the CodeLab application host. Do not alter the production Render service until end-to-end checks pass.

## Acceptance gates

1. Penpot source is present in this repository at the pinned revision, with MPL-2.0 notices and attribution preserved.
2. A clean CI environment can reproduce the editor and WASM build without fetching source code at runtime.
3. The editor opens inside an authenticated CodeLab workspace using CodeLab identity and project permissions.
4. Multiple pages/boards can be created, renamed, reordered, saved and reopened.
5. Layers, selection, transforms, text, shapes, assets, components and contextual inspector work in the integrated editor.
6. Prototype connections can be created and followed across multiple screens; those connections are persisted as CodeLab project data.
7. CodeLab's generator consumes the saved design and interaction graph directly.
8. PixelForge, web editor, preview/run, agents, APIs, history and deploy workflows continue to work.
9. Mobile QA on Android verifies navigation, panel switching, canvas pan/zoom, selection, save/reopen and prototype linking.
10. Production Render is untouched until all preceding gates pass.

## Explicit non-goals

- Importing or parsing user-uploaded .penpot ZIP files.
- Reading another repository to construct the editor.
- Running a separate Penpot server or iframe.
- Replacing Penpot's established workbench with a custom CodeLab toolbar layout.
- Replacing PixelForge.
