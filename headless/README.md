# CodeLab Headless Design Engine

## Purpose

This is the first implementation of a **headless CodeLab runtime**: it operates on the same saved workspace and project model as the website, but applies changes without opening the editor UI or depending on the DOM. The browser-based GitHub bridge is a separate delivery and verification layer: it submits authenticated headless batches to the server, refreshes the actual web workspace, and can open the changed project for visual evidence.

## Compatibility

The engine accepts existing CodeLab projects with `type: "design"` and the existing `design.elements` layer array. Existing projects that only have the legacy `frame` preset are normalized to a canvas size:

- desktop: 1440 × 900
- tablet: 768 × 900
- mobile: 390 × 900

Custom canvas dimensions use CodeLab's existing `design.canvasWidth` and `design.canvasHeight` fields (the same fields consumed by the editor and capture pipeline). The engine also returns a structured `design.canvas` view for its own inspection API; the scalar fields remain synchronized for compatibility. Canvas dimensions are integer pixel values and follow the editor's 100 px minimum, 4,000 px maximum width, and 10,000 px maximum height. These dimensions are independent of individual layer geometry and do not overwrite the legacy `frame` preset.

## Design engine API

```js
const { createDesignEngine } = require('./headless/design-engine');
const engine = createDesignEngine();

const result = engine.transact(project, [
  { type: 'canvas.set', width: 720, height: 1600 },
  { type: 'element.add', elementType: 'rectangle', id: 'hero-bg' },
  {
    type: 'element.update',
    id: 'hero-bg',
    properties: { x: 0, y: 0, width: 720, height: 420, background: '#172554' }
  }
], { expectedRevision: 0 });

// Persist result.project through the authenticated workspace persistence layer.
// result.svg is a deterministic visual representation for preview/testing.
```

Supported operations:
- `canvas.set`: set arbitrary canvas width and height in pixels.
- `element.add`: add a supported layer type with an optional stable ID and properties.
- `element.update`: update allowlisted properties on one stable layer ID.
- `element.delete`: delete exactly one stable layer ID.

`transact` is immutable from the caller's perspective: it works on a cloned project and returns a new project. A failed batch returns no partial project. Optional `expectedRevision` provides optimistic concurrency protection; stale writes fail with `REVISION_CONFLICT`. Each successful batch increments `design.revision` once.

The current first cut caps designs at 500 layers, batches at 500 operations, canvas width at 4,000 px, and height at 10,000 px. The SVG renderer escapes text/attributes, validates paint colors and URL schemes, preserves text backgrounds, alignment/rotation, and image fit, and skips hidden layers.

## Workspace runtime API

`headless/workspace-runtime.js` applies atomic batches against a workspace snapshot. It supports:

- `project.create`: create a `web` or `design` project; the server can generate the stable project ID.
- `project.rename`: rename without changing identity or content.
- `project.duplicate`: duplicate project data into a new ID, excluding active copy-branch and merge-undo state.
- `project.delete`: delete a project only with explicit approval and remove incoming visual-flow links.
- `web.code.write`: replace, append, or prepend HTML/CSS/JS chunks on the main project or an existing copy branch; each chunk is bounded and the final field cannot exceed 500,000 characters.
- `design.batch`: apply canvas, layout, layer, alignment, distribution, duplication, reordering, and deletion operations to a saved design project and return an SVG preview.
- `design.flow.connect` / `design.flow.disconnect`: connect one design layer to another design project or remove that connection.

Each request has `baseRevision`, a stable `operationId`, and 1–100 operations. Workspace revision checks prevent stale writes; the bounded receipt log makes exact retries idempotent. Reusing an operation ID with different content is rejected. Failed batches leave the input snapshot unchanged. The authenticated `POST /api/workspace/:id/headless` endpoint uses the existing workspace token/session ownership checks and existing atomic workspace file persistence. Receipt metadata stays server-side and is not exposed in workspace reads.

The bridge action `headless_batch` calls that endpoint using the authenticated admin browser session, reads the saved workspace back, and opens the affected project in the normal web app when possible. This is the bridge from invisible/headless authoring to the visible CodeLab website. The headless runtime does not bypass account ownership or write directly to project files.

## Concurrency and multiple chats

Workspace-level compare-and-swap revisions and idempotent operation IDs are now implemented. This prevents a stale batch from silently overwriting a newer workspace save and makes exact retries safe. It is not yet a per-layer or per-resource lease manager: two agents editing the same project will conflict at workspace revision level and must refresh/rebase before retrying. Independent workspaces can proceed independently. Per-project/resource leases can be added later if parallel edits to one project become a real requirement.

## Verification

Run:

```sh
node --check headless/design-engine.js
node --test headless/design-engine.test.js headless/workspace-runtime.test.js headless/integration-contract.test.js
```

The tests cover legacy/editor canvas compatibility, custom dimensions, Auto Layout, grid settings, layer alignment/distribution/duplication/reordering/deletion, text alignment and rotation, flow connections, optimistic design/workspace revision conflicts, project creation/duplication/rename/approved deletion, chunked web-code writes, atomic rollback, idempotent retries, generated IDs, bounded receipts, safe SVG colors/URLs, and escaping.

## Shared CodeLab capabilities added to the headless runtime

The workspace runtime imports the same browser-independent modules used by the website instead of maintaining a second catalog or token implementation:

- `component.insert`: resolves the component by ID from `public/component-library.js`, inserts its actual HTML before the closing body tag (or appends it), and adds a stable marker so a retry with a new operation ID does not duplicate it.
- `design.tokens.apply`: calls `public/design-tools.js` for settings sanitization, CSS variable generation, and managed token-block replacement. Existing unmanaged CSS is preserved, and the canonical 500,000-character field limit is enforced.

These operations are part of the same atomic workspace batch, use the existing project code fields, and are persisted by the authenticated headless endpoint. They do not open the editor or require a DOM. Workspace-level settings are handled separately through the authenticated design-system API documented below; applying tokens to project CSS does not by itself change the saved workspace design-system settings.

## Read-only headless query API

The authenticated `POST /api/workspace/:id/headless/query` endpoint reads the current saved workspace without changing its revision or writing any project state. It supports:

- `component.search` and `component.inspect` against the actual website catalog, with bounded standalone HTML output.
- `design.tokens.generate` through the website's existing design-tools module.
- `project.inspect`, `project.code.read`, and `design.read` for saved project state, with explicit field/layer limits and truncation metadata.
- `accessibility.audit` against saved web-project HTML using the existing static audit.

The endpoint requires the same workspace token/session ownership checks as normal workspace operations. An optional `expectedRevision` detects stale reads and returns HTTP 409. Query operations are read-only and do not create idempotency receipts or increment the workspace revision. The bridge action `headless_query` exposes these reads to the assistant without opening a project or simulating editor clicks.

## Workspace-level design-system settings

The separate workspace design-system store is now available without the editor through authenticated `POST /api/workspace/:id/headless/design-system`:

- `read` returns saved settings and their independent revision.
- `write` saves sanitized settings against a required `baseRevision`.
- `import` parses the same `codelab-design-system` JSON format used by the website and validates colors, typography, spacing, and radius before saving.
- `export` returns the canonical JSON token object and generated CSS variables.

Design-system settings have their own monotonic revision, separate from the project workspace revision, so changing tokens does not pretend that project code changed. Stale writes return HTTP 409. The bridge action `headless_design_system` exposes read/export directly and requires explicit approval for write/import; it reads the saved settings back after a mutation before reporting success. The UI import handler now calls the same pure `parseDesignSystemImport` function, avoiding divergent validation logic.

## Branch lifecycle and design undo/redo

Headless batches now support the website's isolated web-project branch model:

- `branch.create` snapshots the current main HTML/CSS/JS into `baseCode` and a working `code` copy.
- Existing branch code can be edited through `web.code.write` with `source: "branch"`.
- `branch.merge` applies the same three-way per-file merge rule as the website. Non-overlapping main/branch changes merge; conflicting edits return HTTP 409 and leave both sides untouched. Merge writes a bounded backup containing main code and branch state.
- `branch.undo_merge` restores the previous main code and the saved branch. Merge and undo require explicit approval.
- `branch.inspect` reports branch metadata and backup count without returning large code bodies.

Design batches now save the prior design snapshot into the same `designUndoStack` / `designRedoStack` fields used by CodeLab. `design.history.undo` and `design.history.redo` restore those snapshots while keeping design revisions monotonic, preventing an undo from making stale revision numbers valid again. `design.history.inspect` reports available history without changing state.

## Responsive design templates

The browser-independent `headless/design-templates.js` module implements the same three website templates: `landing`, `dashboard`, and `portfolio`. It uses the saved custom canvas width to choose compact (<=768px) or desktop geometry, and returns normal CodeLab design elements.

- `design.template.list` returns available templates without mutation.
- `design.template.apply` replaces the design layers, updates the canvas background, increments the design revision, and records an undo snapshot.
- Applying a template to a non-empty design requires `replaceExisting:true` and `approved:true`; the bridge additionally requires outer command approval. The previous design can be restored through `design.history.undo`.

## Design import, export, and conversion

The headless runtime now supports the CodeLab design-project backup format and the existing SVG renderer:

- Read-only `design.export.json` returns the `codelab-design-project` version-1 backup, including project metadata, design layers, and code.
- Read-only `design.export.svg` and `design.export.html` produce an SVG and a responsive HTML wrapper using the same normalized design renderer.
- `design.import.json` validates a CodeLab JSON backup, enforces the 5 MB / 500-layer / 500,000-character code limits, sanitizes image and link sources, remaps layer IDs and internal prototype links, and creates a new project.
- `design.convert.toWeb` changes the project to web mode, stores a responsive HTML export in its code field, and preserves the original design source.

The HTML conversion currently embeds the SVG renderer output rather than reproducing every DOM-level behavior of the website's richer converter; interactive prototype navigation and semantic per-layer HTML remain a parity item.

## Headless AI code generation and provider feedback

The bridge action `headless_ai_generate` performs AI generation without opening the editor or clicking UI controls:

1. Reads the saved main/branch code through the authenticated headless query API and checks the workspace revision before any provider call.
2. Uses the same `/api/ai/complete` proxy and the user's saved `aiSettings` (or the configured server key). The user's API key is never returned in the bridge result.
3. Splits generated HTML/CSS/JS into bounded 50,000-character writes and saves them through the authenticated headless batch API.
4. Reads the saved code back and verifies the result.

The action requires explicit approval because it changes code and consumes provider quota. It supports a caller-supplied operation ID and a SHA-256 request fingerprint stored in the private workspace receipt. A retry after a lost response checks that receipt first, so it does not call the provider again; reusing the ID for a different prompt/configuration is rejected.

The AI proxy now returns provider-reported token usage and recognized rate-limit headers when the provider supplies them. CodeLab's own default rate limit is 20 requests per minute per client IP and returns a 60-second retry hint. Provider daily quotas are not universally queryable; when the provider sends no quota headers, Headless reports them as unavailable rather than inventing a remaining quota. No automatic retry is made after a 429.
