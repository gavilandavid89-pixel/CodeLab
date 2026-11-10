# Penpot RPC and CodeLab persistence adapter analysis

Status: source-backed integration analysis; adapter implementation is not yet complete.

## Evidence pinned to Penpot 2.19.0

The vendored sources are pinned to upstream commit `f66e5afa70e7d5e039b79cee758bf8e03510ad3e`.

- `vendor/penpot/frontend/src/app/main/repo.cljs` implements the frontend repository transport.
- Commands are sent to `/api/main/methods/<method-name>`.
- The transport includes browser credentials and Penpot-specific session/origin headers, and encodes request/response payloads with Transit.
- The repository layer maps read commands to GET and mutations to POST, with command-specific query/form/stream options.
- `vendor/penpot/frontend/src/app/main/data/dashboard.cljs` calls repository commands for projects, files, teams and libraries.
- `vendor/penpot/frontend/src/app/main/data/workspace/interactions.cljs` stores prototype flows and interactions as document changes, not as an independent navigation table.
- The upstream frontend opens a per-file WebSocket for presence and collaborative updates (see Penpot frontend architecture documentation).

## Existing CodeLab persistence boundary (main branch inspection)

CodeLab already has the correct system-of-record primitives:

- `POST /api/workspace/init` binds a signed-in account to its deterministic workspace and returns the existing user/workspace context.
- `GET /api/workspace/:id` reads the authorized workspace.
- `PUT /api/workspace/:id` validates the project list, checks `baseRevision`, and atomically increments the workspace revision.
- PostgreSQL persistence uses `codelab_workspace_states`; the file fallback is local-only.
- The project model currently validates CodeLab's existing project shape and design data. It is not a Penpot Transit document store.
- Existing authorization is workspace-token/session based and must remain the authority for every editor operation.

## Required adapter design

Do not point Penpot at an unrelated Penpot backend or silently create a second user/project database. Add a CodeLab-native adapter boundary:

1. **Identity/context bridge** — derive the active CodeLab account, workspace, project, and permissions from the authenticated CodeLab session. Never accept a client-supplied owner/workspace binding as authority.
2. **RPC compatibility layer** — expose the Penpot frontend's expected RPC envelope at the CodeLab origin. Build an explicit allowlisted method registry for the minimum vertical slice (open/create file, load document, apply changes, save/revision, list pages, assets, prototype flows). Do not proxy arbitrary method names.
3. **Document persistence** — store the native Penpot document as a versioned field/record inside the existing CodeLab project/workspace persistence boundary, with optimistic concurrency tied to CodeLab revision. Preserve CodeLab metadata and existing project data.
4. **Transit codec** — implement or vendor the compatible Transit encoding/decoding required by the frontend. Plain JSON substitution is not equivalent.
5. **Collaboration** — implement a CodeLab-authorized WebSocket channel for per-project presence and ordered document updates. Until this exists, do not advertise real-time collaboration as supported.
6. **Asset lifecycle** — map image/font/library assets to CodeLab's existing storage ownership and quotas. No second durable bucket or independent cleanup policy.
7. **Generator bridge** — derive screens from Penpot pages/frames, links from prototype interactions/flows, and design resources from components/tokens/assets. Preserve the source document; generator output is derived and must be reproducible.
8. **Migration and compatibility** — existing CodeLab projects without a Penpot document remain valid. Creating/opening the editor must not rewrite or discard their existing `design.elements`, code, Pixelforge data, or workspace revision history.

## Important incompatibilities and guardrails

- The current CodeLab workspace REST API is not Penpot's RPC API. A frontend URL rewrite alone cannot make the two protocols compatible.
- Penpot's Transit payloads and document-change semantics must be handled deliberately; do not serialize them as arbitrary JSON and assume equivalence.
- Prototype interactions are embedded in Penpot page/shape changes. Preserve IDs and references when projecting them into CodeLab navigation.
- Pixelforge remains a separate existing CodeLab capability and its animation/rendering pipeline must not be replaced by Penpot prototype interactions.
- Keep the native Penpot workbench layout. Integrate CodeLab actions into existing menus/panels; do not overlay a competing toolbar over the canvas.
- No production deployment until the vendored frontend dependency closure builds, the adapter passes authenticated multi-page save/reopen tests, and mobile touch workflows are verified.

## Verification checklist

- [ ] Complete pinned upstream frontend/common/resources/plugin/WASM dependency closure is present.
- [ ] Reproducible build runs in CodeLab CI and produces the Penpot workbench bundle.
- [ ] Existing CodeLab session opens the editor without a second login.
- [ ] Create/open/rename/delete project and multi-page document operations persist to existing PostgreSQL storage.
- [ ] Edit, reload, and reopen preserve document contents and revision ordering.
- [ ] Prototype flow and frame-to-frame navigation survive save/reopen and generator projection.
- [ ] Asset upload/download honors existing CodeLab ownership and quotas.
- [ ] Pixelforge regression suite remains green.
- [ ] Android: pan, zoom, select, draw, layer navigation, inspector drawers and save work with touch.
