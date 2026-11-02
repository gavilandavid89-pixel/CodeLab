# CodeLab assistant tool catalog — incremental implementation

This document records assistant-facing operations that are backed by CodeLab's existing application state and are added in independently verifiable sections. The UI remains the source of truth; tools must call the same application functions and persistence path rather than maintain a parallel project model.

## Section 1 — Project lifecycle and resumable copy branches

**Branch:** `feat/assistant-tooling-project-lifecycle`

### Existing application behavior confirmed in source

- Projects have stable IDs, names, type, timestamps, web code, design state and optional copy-branch/merge-history state.
- Project names can already be changed from the editor. The normal save path writes to the authenticated workspace and maintains a local recovery snapshot.
- The copy branch is stored on the project as `branch: { id, baseCode, code, baseMainUpdatedAt, updatedAt }`. It is not just a temporary editor buffer.
- Opening a project loads its saved branch into memory. The user can enter the branch, save it independently, compare/merge it into the main version, and undo a merge.
- Workspace persistence is revision-checked. A conflict is not supposed to silently overwrite the newer server state.

### New bridge operations

All operations below require `use_admin_session: true`, which means credentials are read from GitHub Actions secrets, never from the issue body. Each command also requires the normal bridge protocol, a unique command ID and an expiry timestamp. Mutating commands are rejected from the read-only comment mailbox.

| Action | Required arguments | Behavior / evidence returned |
|---|---|---|
| `project_list` | none | Lists project IDs, names, type, update timestamp, branch presence/ID/update time, and merge-undo availability. |
| `project_rename` | `project_id`, `name` | Renames a project, persists through CodeLab's workspace save path, checks the local durable snapshot if server sync is unavailable, and reports sync/local verification separately. |
| `project_save` | `project_id` | Opens the requested project if needed, saves the active editor state through the existing save function, and fails unless server or local persistence can be verified. |
| `branch_status` | `project_id` | Reports whether a branch exists, its ID/base timestamp/update timestamp, code lengths, and whether the editor currently displays it. |
| `branch_resume` | `project_id` | Reopens the project, activates its persisted branch, then verifies the editor's HTML/CSS/JS exactly match the saved branch contents. Does not create a new branch or copy the main code over the branch. |
| `branch_save` | `project_id` | Reopens the selected branch if needed, saves through the existing branch persistence path, and verifies saved branch data in the local snapshot if server sync is not confirmed. |

### Example command envelopes

Use a fresh, unique `command_id` and an expiry in the near future for every command. Do not reuse command IDs.

```json
{
  "protocol": "codelab-agent-bridge/v1",
  "command_id": "projectlist_20261031_01",
  "action": "project_list",
  "use_admin_session": true,
  "expires_at": "2026-10-31T23:59:00-03:00",
  "args": {}
}
```

```json
{
  "protocol": "codelab-agent-bridge/v1",
  "command_id": "branchresume_20261031_01",
  "action": "branch_resume",
  "use_admin_session": true,
  "expires_at": "2026-10-31T23:59:00-03:00",
  "args": { "project_id": "proj_REPLACE_WITH_REAL_ID" }
}
```

### Safety and durability rules

1. Never infer a project ID from its name; list projects first and use the exact returned ID.
2. Renaming must not recreate a project or replace its code/design/branch.
3. Resuming a branch must not initialize a fresh branch from the main version.
4. A local snapshot is reported as local-only, not as server-synced.
5. A failed save must not be reported as successful unless durable local state was actually checked.
6. The bridge runs in a fresh isolated browser context for each command. This is a remote automation session, not the user's current browser tab.
7. Live validation is still required after CI: verify the deployed bridge supports these actions, the admin session can access the intended workspace, and a test branch can be resumed without altering the main code. Do not use a real project for destructive tests.

### Section 1 status

- [x] Tool actions added to the bridge allowlist.
- [x] Admin-session gate and project ID/name validation added.
- [x] Rename persistence verification tightened.
- [x] Branch resume verifies editor contents against the saved branch.
- [ ] CI syntax/workflow validation.
- [ ] Live authenticated read-only inventory.
- [ ] Safe end-to-end test using a disposable project and copy branch.
- [ ] Confirm Render is serving the commit after merge/deploy.

Do not mark this section fully verified until the unchecked tests pass. Continue the next capability section only after this section's validation is complete.

\n## Section 2 — Read-only workspace, code, and design inspection\n\nNew authenticated read tools: `workspace_inspect` (workspace/editor/sync summary), `project_inspect` (project metadata, code lengths, design summary, branch metadata), `project_code_read` (main or saved-branch HTML/CSS/JS with explicit truncation metadata), and `design_read` (saved design frame and layer geometry/content). These operations do not change project state. Code reads cap each language at 20,000 characters; design layer reads cap at 200 elements and report truncation. All require `use_admin_session: true` and exact project IDs from `project_list`. CI and live checks remain separate evidence.\n
\n## Section 3 — Controlled code editing\n\nAdded `project_code_write` for HTML/CSS/JavaScript changes on an existing web project. It accepts one or more language fields, caps each supplied field at 50,000 characters, preserves omitted fields, supports `source: "main"` or `source: "branch"`, and verifies the resulting saved code against the requested values. It rejects design-only projects and branch writes without a saved branch. This is a mutating tool: use only after confirming the exact project ID and target source; live mutation testing must use a disposable project. Server sync and local snapshot evidence are reported separately.\n
\n## Section 4 — Component library and design-layer editing\n\nAdded `component_search` (read-only search over the app's actual component catalog) and `component_insert` (insert a chosen component into a web project's HTML, with an idempotency marker and persistence verification). Added `design_element_add`, `design_element_update`, and `design_element_delete` for saved design projects. Updates use a property allowlist and record design history; delete is scoped to one exact element ID. All actions require admin session and project ID; writes require a disposable project for live tests. CI contract coverage is not proof of live UI success.\n
\n## Section 5 — Project creation and duplication\n\nAdded `project_create` (uses CodeLab's existing create flow, supports web/design types, returns the generated stable project ID, and verifies the local snapshot) and `project_duplicate` (uses the existing duplication path, verifies the source code/design remained unchanged, and checks the duplicate in the local snapshot). Both require admin session. Live tests must use a disposable workspace/project; server synchronization is not inferred from local persistence alone.\n
\n## Section 6 — Design templates, history, and project deletion\n\nAdded `design_template_apply` for the app's landing/dashboard/portfolio templates, `design_history` for undo/redo, and `project_delete` for permanent deletion. Deleting a project requires `approval: "approved"`; replacing non-empty design layers requires both `replace_existing: true` and explicit approval. Each action verifies resulting state, and deletion additionally checks the local snapshot. These destructive operations must never be live-tested on a user's real project; test only with disposable data.\n
\n## Section 7 — Design utilities, exports, and safe AI configuration inspection\n\nAdded `accessibility_audit` (runs the existing HTML audit on a specific project), `design_tokens_generate` (returns normalized design tokens and CSS variables using the existing design-tools API), `design_export` (returns SVG or project JSON content, capped at 7,000 characters with explicit truncation metadata), and `ai_settings_inspect` (reports provider/mode/model/key-presence flags but never returns API key contents). These tools are intended to make the assistant's work directly inspectable without inventing parallel implementations.\n
\n## Section 8 — Visual flow graph connections\n\nAdded `design_flow_read`, `design_flow_connect`, and `design_flow_disconnect` using the app's actual `design.flowConnections` model. Connections are validated against real design projects and source element IDs, duplicate connects are idempotent, and mutations report persistence and state verification. All require admin session and exact project IDs; mutation tests should use disposable design projects.\n
\n## Section 9 — Approved AI code generation\n\nAdded `ai_generate` to invoke CodeLab's existing copilot workflow against a named web project and main or saved copy branch. It requires `approval: "approved"` because it mutates code and may consume configured API quota. The tool captures before/after code, reports changed languages, and checks the saved project/branch plus local snapshot. This action should not be used in automated smoke tests against a user's real project or API quota.\n
\n## Section 10 — Web export and design-to-web conversion\n\nAdded `project_export_html`, which packages a web project's saved HTML/CSS/JS into a standalone HTML document and returns bounded content with explicit truncation metadata. Added `project_convert_design_to_web`, which invokes CodeLab's existing design conversion path, checks that a new web project was created, confirms the source design remained unchanged, and verifies the converted project in the local snapshot. Conversion creates a new project and must be live-tested only with disposable design data.\n
\n## Section 11 — Copy branch creation, merge, and undo\n\nAdded `branch_create`, `branch_merge`, and `branch_undo_merge` so the copy-branch lifecycle is callable directly rather than only through UI clicks. Creation is idempotent when a branch already exists, verifies the branch against the saved local snapshot, and only supports web projects. Merge and undo require `approval: "approved"`, invoke CodeLab's existing merge/undo functions, and verify code/history plus the local snapshot. A merge that encounters conflicts must fail without deleting the branch. Live mutation testing must use a disposable web project and verify exact code before/after; contract coverage alone does not establish live success.\n
\n## Section 12 — Visual design studio controls\n\nNew direct actions:\n\n- `design_element_duplicate`: duplicate one existing layer and verify the new layer in the durable local snapshot.\n- `design_layer_move`: move one layer one position forward/backward and verify the saved order.\n- `design_elements_align`: align one or more specified layer IDs using a supported alignment mode.\n- `design_layout_configure`: configure free/auto layout, row/column direction, gap, and padding.\n- `design_canvas_configure`: configure responsive frame, grid, snap-to-grid, grid size, background, and session-only zoom.\n\nAll actions require the authenticated admin session and exact project ID. Numeric inputs and enums are validated. The operations call the app's existing design functions, save the project, and report local-snapshot verification; canvas zoom is explicitly session-only. Contract tests check registration, implementation, and verification paths. Live mutation tests should use a disposable design project, because a passing contract test does not prove every browser-side operation works in production.\n

## Section 13 — Component inspection and bounded standalone export

Added read-only `component_inspect`, which resolves a component by its real catalog ID, returns its metadata and uses the library's existing `standaloneHtml` function to generate a standalone HTML preview. The output is capped at 1,000–7,000 characters (5,000 by default) and explicitly reports original length and truncation, so large components can be inspected safely before inserting them into a project. It does not mutate project state or expose arbitrary project code. CI contract tests verify registration and output bounds; live validation should query a known catalog item and an invalid ID.


## Section 14 — Manual layer distribution and prototype targets

Added two design-specific operations backed by the existing editor:
- `design_elements_distribute`: distribute 3–100 unique selected layer IDs horizontally or vertically, reject Auto Layout (which distributes automatically), and verify every final position in the durable local project snapshot.
- `design_prototype_target_set`: assign a bounded, validated target to an eligible layer using the editor's existing prototype-target handler and verify the saved `href` value.

Both require the exact design project ID and the admin session, validate IDs and arguments, and return before/after evidence. They do not call AI providers. Contract tests check registration, validation, and use of the original editor functions. Live tests should use a disposable design project and clean it up after verification.

## Section 15 — Headless workspace runtime

Added **headless_batch**, an authenticated bridge operation that applies a batch directly to the saved workspace without driving editor controls. The server uses the same workspace ownership checks, project validation, revision counter, and atomic persistence as the visible web app.

Supported runtime operations:
- **project.create**: create a web or design project; the runtime generates a stable project ID when omitted.
- **project.rename**: rename an existing project while preserving its ID and content.
- **project.duplicate**: copy an existing project into a new ID without carrying an active copy branch or merge-undo history.
- **project.delete**: permanently delete a project only with explicit approval and remove incoming visual-flow links.
- **web.code.write**: replace, append, or prepend bounded HTML/CSS/JS chunks on a web project or existing copy branch.
- **design.batch**: apply canvas, grid, Auto Layout, layer, alignment, distribution, duplication, reordering, and deletion operations through the shared headless design engine, including an SVG preview result.
- **design.flow.connect / design.flow.disconnect**: create or remove navigation links between design projects.

Every batch supplies base_revision, operation_id, and 1–100 operations. Workspace revision conflicts return HTTP 409; exact retries with the same operation ID and payload replay the prior result without applying changes twice; reusing an ID with different content is rejected. Large code fields can be written in ordered chunks, up to the same 500,000-character field limit enforced by the workspace validator. Receipt records are bounded and remain server-side. Failed batches are atomic and do not partially modify the workspace.

After the server accepts a batch, the bridge reads the workspace back through the existing authenticated web session and opens the affected project in the regular CodeLab UI for visual evidence. The bridge is therefore the delivery/verification path, not the editing engine itself. No Render deployment or production mutation is implied by CI success; live verification requires the updated server and bridge to be deployed.

## Section 15 — Headless component insertion and design-token application

The direct headless workspace runtime now exposes two operations backed by the same browser-independent modules used by the website:

- `component.insert` resolves a real component from `public/component-library.js`, inserts its HTML into a web project, and writes a stable component marker. The marker prevents duplicate insertion even if a caller retries using a different operation ID.
- `design.tokens.apply` sanitizes settings and uses `public/design-tools.js` to generate CSS variables and replace only the managed token block, preserving unmanaged CSS.

Both operations run in an atomic authenticated workspace batch, respect the canonical 500,000-character project-field limit, and persist through the existing workspace path. This does not yet expose the separate workspace-level design-system settings file for headless read/import/save; that remains explicitly pending.

## Section 16 — Read-only headless inspection and catalog queries

Added authenticated `POST /api/workspace/:id/headless/query` and the bridge action `headless_query`. These are read-only and do not increment the workspace revision:

- `component.search` and `component.inspect` use the real website catalog and return bounded results/standalone HTML.
- `design.tokens.generate` reuses the real design-tools sanitizer and token generator.
- `project.inspect`, `project.code.read`, and `design.read` inspect saved workspace data with explicit size limits and truncation metadata. Image payloads are summarized by presence/length instead of returned as large base64 strings.
- `accessibility.audit` runs the existing static HTML audit against the saved web project.

The endpoint requires workspace authorization and owner enforcement. Optional `expectedRevision` rejects stale reads with HTTP 409. The bridge reads directly through the endpoint and does not open a project or click editor controls.

## Section 17 — Workspace-level design-system persistence

Added authenticated `POST /api/workspace/:id/headless/design-system` and bridge action `headless_design_system` for the workspace-scoped settings file that lives separately from project code:

- `read` returns saved settings and the design-system revision.
- `write` saves sanitized settings with optimistic `baseRevision` checks.
- `import` uses the shared `public/design-tools.js` JSON parser, also used by the website's import button.
- `export` returns the same canonical CodeLab JSON tokens and CSS variables as the website.

The design-system store now has its own monotonic revision (legacy version-1 records migrate as revision 0); it does not increment the project workspace revision. Stale writes return HTTP 409. Bridge writes/imports require explicit approval and verify the saved settings by reading them back.

## Section 18 — Headless branches and design history

The workspace runtime now supports the saved copy-branch model and persistent design undo/redo:

- `branch.create` creates an isolated working copy with base and branch code.
- `web.code.write` can target that branch.
- `branch.merge` uses the same per-file three-way merge rule as the website. Conflicts return HTTP 409 and do not modify either side. Successful merges keep a bounded backup.
- `branch.undo_merge` restores the prior main code and branch. Both merge and undo require explicit approval.
- `branch.inspect` and `design.history.inspect` expose read-only status.
- `design.batch` records snapshots in the existing project `designUndoStack` / `designRedoStack` fields; `design.history.undo` and `design.history.redo` restore them with monotonic design revisions.

This is project-state functionality; it does not simulate the web editor's branch toggle, confirmation dialog, or undo buttons.

## Section 19 — Responsive design templates

Added a browser-independent template module for the website's `landing`, `dashboard`, and `portfolio` templates:

- `design.template.list` inspects available templates.
- `design.template.apply` generates regular design-layer records using the saved custom canvas width, selecting compact geometry at 768px or below.
- Template application updates the design revision and records an undo snapshot.
- Replacing existing layers requires explicit operation approval and bridge-level command approval; the previous design is recoverable through `design.history.undo`.

Templates use the same layer schema and SVG renderer as manually authored design elements.

## Section 20 — Design backup, SVG/HTML export, and web conversion

Added direct headless design-project export/import and conversion:

- `design.export.json` returns the existing `codelab-design-project` v1 backup format.
- `design.export.svg` and `design.export.html` use the browser-independent design engine renderer.
- `design.import.json` validates and sanitizes a backup, enforces size/layer/code limits, remaps element IDs and internal layer links, and creates a new design project.
- `design.convert.toWeb` stores a responsive HTML export in the same project while preserving its original design data.

The current HTML conversion embeds the renderer's SVG for visual fidelity. It does not yet reproduce the website's richer semantic DOM export or interactive prototype navigation; those remain explicit parity work.

## Section 21 — Headless AI generation and provider quota telemetry

Added approved bridge action `headless_ai_generate`:

- Reads the saved main or branch code through `headless_query`; it does not open a project, switch branches in the UI, or invoke the chat composer.
- Calls the same `/api/ai/complete` proxy used by CodeLab and reads the current user's saved provider settings, keeping the API key out of bridge results.
- Enforces prompt/code/output limits, supports a bounded `max_tokens` budget, chunks generated files into 50k writes, persists through `headless_batch`, and verifies server readback.
- Uses a SHA-256 request fingerprint in the private headless operation receipt. Exact retries after a lost response are detected before a second provider call; a different request under the same operation ID is rejected.
- Returns actual provider usage and recognized rate-limit headers when available. CodeLab's own 20-requests/minute per-IP limiter reports a 60-second retry hint. Providers that do not expose daily quota data are reported as unknown; no quota is fabricated and 429s are not retried automatically.

The legacy `ai_generate` UI action remains available for the browser workflow; the new `headless_ai_generate` is the direct saved-workspace path.

## Headless parity follow-through — legacy bridge actions

The legacy bridge action names for design import, design-system import/export, web-project HTML export, and design-to-web conversion now call authenticated headless APIs. They no longer open editor modals, set file inputs, wait for browser downloads, or invoke the design conversion UI. This preserves caller compatibility while making those capabilities independent of editor visibility.
