# CodeLab Headless Design Engine

## Purpose

This is the first implementation of a **headless CodeLab runtime**: it operates on the same saved workspace and project model as the website, but applies changes without opening the editor UI or depending on the DOM. The browser-based GitHub bridge is a separate delivery and verification layer: it submits authenticated headless batches to the server, refreshes the actual web workspace, and can open the changed project for visual evidence.

## AI design capture context

The read-only headless query `design.capture.context` returns the same structured `codelab-ai-design-capture` context used by the website's AI design capture flow, including ordered visible-layer bounds, styles, rotation and opacity, image alt text, custom canvas dimensions, scale, and analysis instructions. Hidden layers are excluded from the HTML export, layout geometry, and AI context so these representations describe the same visible composition; prototype targets reachable only through hidden or missing source layers are not exported as orphan screens. The query defaults to scale 2 and accepts only scales 1–4, with a 32-million-pixel safety ceiling. It never mutates the project or workspace revision. The assistant bridge exposes it through `headless_query` with `query_action: "design.capture.context"` and a required `query_args.projectId`; callers no longer need to fall back to editor-dependent capture controls to obtain this structured context. The `design_capture_png` action reads the context, semantic HTML export, and design revision through authenticated queries pinned to one workspace revision, renders the HTML in a fresh isolated Playwright context with external network requests blocked, and writes a PNG plus a JSON manifest pairing both artifacts.

The read-only query prepares the context JSON; the bridge `design_capture_png` action performs the separate isolated-browser render. The action records the workspace and design revisions in a JSON manifest beside the PNG, rejects oversized captures, blocks external requests, and closes its isolated context in `finally`. The action contract is covered by `tests/assistant-tools-contract.test.js`; full rendered PNG fidelity still requires browser-level verification against representative design fixtures. `design.export.svg` remains available for deterministic vector output.

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

Layer positioning supports the editor's responsive `xUnit` and `yUnit` properties (`px` or `%`) in free layout. Percentage positions are resolved against the saved canvas width/height for SVG rendering, while the original numeric values and units remain persisted on the layer. Unsupported units are rejected.

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

Run the core contracts and runtime tests:

```sh
node --check headless/design-engine.js
node --check headless/workspace-runtime.js
node --check server.js
node --test headless/design-engine.test.js headless/workspace-runtime.test.js headless/integration-contract.test.js
node --test headless/preview-upload.test.js
```

With Playwright and Chromium installed, also run the browser-level checks:

```sh
node --test headless/design-capture-browser.test.js headless/preview-interaction-browser.test.js
node tests/assistant-tools-contract.test.js
```

The tests cover legacy/editor canvas compatibility, custom dimensions, Auto Layout, grid settings, layer alignment/distribution/duplication/reordering/deletion, text alignment and rotation, flow connections, optimistic design/workspace revision conflicts, project creation/duplication/rename/approved deletion, chunked web-code writes, atomic rollback, idempotent retries, generated IDs, bounded receipts, safe SVG colors/URLs, and escaping. The upload validator has direct positive and negative tests for allowed MIME signatures, malformed Base64, unsafe filenames, mismatched types, and size limits. The isolated Chromium preview test exercises text entry, checkbox state, select controls, file input, opaque-origin separation from the parent document, and CSP-blocked outbound fetches; a separate browser test verifies actual PNG capture and revision/dimension pairing.

## Shared CodeLab capabilities added to the headless runtime

The workspace runtime imports the same browser-independent modules used by the website instead of maintaining a second catalog or token implementation:

- `component.insert`: resolves the component by ID from `public/component-library.js`, inserts its actual HTML before the closing body tag (or appends it), and adds a stable marker so a retry with a new operation ID does not duplicate it.
- `design.tokens.apply`: calls `public/design-tools.js` for settings sanitization, CSS variable generation, and managed token-block replacement. Existing unmanaged CSS is preserved, and the canonical 500,000-character field limit is enforced.

These operations are part of the same atomic workspace batch, use the existing project code fields, and are persisted by the authenticated headless endpoint. They do not open the editor or require a DOM. Workspace-level settings are handled separately through the authenticated design-system API documented below; applying tokens to project CSS does not by itself change the saved workspace design-system settings.

## Read-only headless query API

The authenticated `POST /api/workspace/:id/headless/query` endpoint reads the current saved workspace without changing its revision or writing any project state. It supports:

- `component.search` and `component.inspect` against the actual website catalog, with bounded standalone HTML output.
- `design.tokens.generate` through the website's existing design-tools module.
- `project.inspect`, `project.code.read`, and `design.read` for saved project state, with explicit field/layer limits and truncation metadata. `project.code.read` supports offset-based paging (`offset`, `maxChars`, per-field `nextOffset`) so agents can read large HTML/CSS/JS files in bounded chunks instead of losing everything after the first 200,000 characters.
- `accessibility.audit` against saved web-project HTML using the existing static audit.

The endpoint requires the same workspace token/session ownership checks as normal workspace operations. An optional `expectedRevision` detects stale reads and returns HTTP 409. Query operations are read-only and do not create idempotency receipts or increment the workspace revision. The bridge action `headless_query` exposes these reads to the assistant without opening a project or simulating editor clicks. The legacy `project_code_read` bridge action also delegates to this authenticated API (rather than the editor's in-memory `projects` array), accepts `offset` and `max_chars`, and returns each field's original length, truncation state, `nextOffset`, and the workspace revision.

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

The browser-independent `headless/design-templates.js` module implements the same three website templates: `landing`, `dashboard`, and `portfolio`. It uses the saved custom canvas width to choose compact (<=768px) or desktop geometry, scales horizontal padding to narrow canvases, and returns normal CodeLab design elements without forcing a 250px minimum content width. Regression coverage checks all three templates at widths of 100, 200, 280, 390, and 768px.

- `design.template.list` returns available templates without mutation.
- `design.template.apply` replaces the design layers, updates the canvas background, increments the design revision, and records an undo snapshot.
- Applying a template to a non-empty design requires `replaceExisting:true` and `approved:true`; the bridge additionally requires outer command approval. The previous design can be restored through `design.history.undo`.

## Design import, export, and conversion

The headless runtime now supports the CodeLab design-project backup format and the existing SVG renderer:

- Read-only `design.export.json` returns the `codelab-design-project` version-1 backup, including project metadata, design layers, and code.
- Read-only `design.export.svg` and `design.export.html` produce an SVG and a responsive HTML wrapper using the same normalized design renderer.
- `design.import.json` validates a CodeLab JSON backup, enforces the 5 MB / 500-layer / 500,000-character code limits, sanitizes image and link sources, remaps layer IDs and internal prototype links, and creates a new project.
- `design.convert.toWeb` changes the project to web mode, stores a responsive HTML export in its code field, and preserves the original design source.

HTML export now reproduces semantic per-layer HTML, responsive free/auto layout, safe image and link handling (including same-origin relative image sources, validated `mailto:` actions with query parameters, `tel:` actions, and same-origin root-relative paths; protocol-relative external hosts remain blocked), and connected multi-screen prototype navigation. Hidden layers are omitted, and layer rotation/opacity are preserved with bounded CSS values. Regression tests cover these parity guarantees and rejection of unsafe link schemes. The output is generated without a browser and can be converted into web-project code while preserving the source design.

## Headless AI code generation and provider feedback

The bridge action `headless_ai_generate` performs AI generation without opening the editor or clicking UI controls:

1. Reads the saved main/branch code through the authenticated headless query API and checks the workspace revision before any provider call.
2. Uses the same `/api/ai/complete` proxy and the user's saved `aiSettings` (or the configured server key). The user's API key is never returned in the bridge result.
3. Splits generated HTML/CSS/JS into bounded 50,000-character writes and saves them through the authenticated headless batch API.
4. Reads the saved code back and verifies the result.

The action requires explicit approval because it changes code and consumes provider quota. It supports a caller-supplied operation ID and a SHA-256 request fingerprint stored in the private workspace receipt. A retry after a lost response checks that receipt first, so it does not call the provider again; reusing the ID for a different prompt, provider/key fingerprint, source, revision, or token budget is rejected. The provider key itself is never stored in the fingerprint.

The AI proxy now returns provider-reported token usage and recognized rate-limit headers when the provider supplies them. CodeLab's own default rate limit is 20 requests per minute per client IP and returns a 60-second retry hint. Provider daily quotas are not universally queryable; when the provider sends no quota headers, Headless reports them as unavailable rather than inventing a remaining quota. No automatic retry is made after a 429.

## Removing legacy UI dependencies from bridge actions

The existing bridge action names remain compatible, but their implementation now delegates to authenticated headless workspace APIs instead of clicking editor controls or file inputs:

- `design_import_json` calls the headless design import batch and refreshes the workspace from the server.
- `design_system_import_json` and `design_system_export_json` use the dedicated revisioned headless design-system endpoint.
- `project_export_html` reads the saved web-project code through `project.code.read` before composing the standalone HTML.
- `project_convert_design_to_web` calls the same atomic `design.convert.toWeb` operation used by native headless batches.

This keeps existing callers working while removing editor visibility, modal state, and browser download events as prerequisites for these operations.

## Headless web preview and interaction checks

The bridge's existing `preview_diagnostics` and `preview_interact` actions now load saved project code through the authenticated `project.code.read` API and run it in a separate browser context and sandboxed iframe with no CodeLab app cookies, localStorage, or service workers. They no longer require a project to be open in the editor or depend on the editor's `#previewIframe`.

The sandbox preserves the web editor's preview restrictions: scripts and forms are allowed, same-origin access is not granted, and the Content Security Policy blocks network connections while allowing inline CSS/JS and HTTP(S)/data images and fonts. Diagnostics collect DOM structure, accessible controls, console messages, page errors, and failed requests. Interaction steps can click (with explicit approval), fill, select, read, check/uncheck checkboxes, press a restricted set of non-submitting navigation keys, hover, focus, and assert text/visibility/enabled state. The `upload` step can attach a small in-memory fixture to an `input[type=file]` for form testing; it accepts `text/plain`, PNG, JPEG, WebP, or PDF, validates a safe filename, Base64 syntax, decoded MIME signature for binary types, and caps payloads at 24,000 bytes (32,000 Base64 characters) to fit within the issue-mailbox transport. It does not send the file to an external server. External anchor navigation remains blocked. The self-test fixtures are disposable and never mutate the saved project.


## Image-file attachment parity

The editor's image inspector imports PNG, JPEG, WebP, or GIF files up to 2 MiB as Base64 data URLs stored in the image layer's `src`. Headless design batches expose the same operation:

- `image.attach` requires an existing image layer ID, a filename, and a `data:image/...;base64,...` payload.
- MIME type, Base64 canonical encoding, and decoded 2 MiB size are validated before mutation.
- The filename stem fills alt text only when the current alt text is empty or still the editor default; custom accessibility text is preserved.
- The operation returns MIME type and decoded byte length. The surrounding `design.batch` retains atomic transaction, revision, undo, and workspace persistence behavior.

The current editor embeds image data in the project; there is no separate asset library or media-upload endpoint to mirror.


**Transport note:** the GitHub issue-mailbox bridge limits serialized `headless_batch` operations to 50,000 characters, which is too small for a full 2 MiB Base64 image. Use the authenticated headless workspace API for full-size image attachment. Large binary transport through the issue mailbox is still pending.

## Design accessibility audit

The read-only query `design.accessibility.audit` inspects saved design layers without opening the editor or changing workspace/design revisions. It reports missing image alt text, unnamed buttons and headings, very small text, and estimated WCAG AA contrast failures when both text and the layer's declared background are explicit hexadecimal colors.

The response includes the canonical query envelope, design revision, finding counts, rule IDs, element IDs, and contrast details when measurable. This is a static first pass, not a replacement for visual inspection, screen-reader testing, or contrast checks against complex backgrounds and overlapping layers. Unknown/transparent backgrounds are deliberately not assigned a guessed contrast ratio. Text layers with non-default opacity also receive a warning because their effective contrast depends on compositing over the canvas; declared values outside 0–1 are reported alongside the clamped value.

## Basic capability readiness checklist

The basic headless scope is treated as a single end-to-end capability set, not a collection of unrelated features. Before advanced automation is considered complete, verify each item against the authenticated saved workspace and the actual browser preview:

1. **Workspace and project lifecycle:** list/inspect projects, create, rename, duplicate, and approved delete; verify every mutation by reading saved state back.
2. **Web code lifecycle:** read HTML/CSS/JS with paging, write bounded chunks to main or branch, preserve the selected source, detect stale revisions, and verify final saved content.
3. **Design lifecycle:** inspect canvas/layers, add/update/delete/reorder/duplicate/align/distribute layers, configure layout/canvas, manage prototype links, use templates, and undo/redo with monotonic revisions.
4. **Design-system and reusable assets:** search/inspect/insert components, generate/apply tokens, read/write/import/export design-system settings, and import/export/convert design projects.
5. **Preview and quality checks:** run isolated preview diagnostics, exercise common controls and bounded local file-input uploads, audit accessibility, and report console/runtime/request failures without mutating the saved project.
6. **Safety and recovery:** enforce authentication/ownership, explicit approval for destructive or main-branch changes, input and size limits, atomic rollback, idempotent retries, revision conflict handling, and honest provider quota/error reporting.
7. **Capture and evidence:** implemented PNG rendering from saved semantic HTML in an isolated browser, a JSON manifest pairing the image with the structured context, and matching workspace/design revision checks. Contract tests verify the pairing and the bridge workflow uploads both artifacts. The integral Chromium journey also captures a real PNG from the exact design project/revision before conversion replaces the project type or later code edits occur; it verifies PNG signature, dimensions against the structured context, and non-empty rendered content. A live capture against a separately deployed production workspace still requires an explicitly designated fixture project; SVG export is not a substitute for PNG evidence.

A capability is only marked complete when its contract tests and relevant end-to-end checks pass. A bridge action that still reads or writes through the editor's in-memory project model is considered a basic parity gap even if a parallel headless API operation exists. The bridge parity audit has migrated `project_list`, project lifecycle operations, `project_code_write`, legacy `ai_generate` normalized to `headless_ai_generate`, `component_insert`, core design-layer add/update/delete/duplicate/reorder/align/distribute, prototype targets, layout, and persisted canvas changes through atomic `design.batch` transactions, `design_read`, `branch_status`, branch create/merge/undo, `accessibility_audit`, `design_export`, `design_flow_read`, design history undo/redo, and template application to authenticated saved-workspace APIs. `workspace_inspect` now combines live editor/session diagnostics with the authoritative saved project list and workspace revision. Remaining basic parity boundaries are `workspace_inspect` (a deliberate mix of authoritative saved-workspace data and live session diagnostics), `project_save`, `branch_resume`, and `branch_save` (these still operate on the currently open editor session and must not be silently redefined as saved-state API calls). The `project_save` bridge response explicitly reports `serverConfirmed` and `persistenceScope` (`server-confirmed` or `local-snapshot-only`), while `branch_save` reports `serverSynced` and `localSnapshotVerified`; callers must inspect these fields rather than infer server persistence from a generic success. For headless use, prefer the explicit project-code write and branch create/merge APIs; keep session-only actions clearly marked until a compatible API contract exists.