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
- `web.code.write`: replace selected HTML/CSS/JS fields on the main project or an existing copy branch.
- `design.batch`: apply the design-engine operations to a saved design project and return an SVG preview.

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

The tests cover legacy/editor canvas compatibility, custom dimensions, layer operations, text alignment and rotation, optimistic design/workspace revision conflicts, project creation/duplication/rename, web code writes, atomic rollback, idempotent retries, generated IDs, bounded receipts, safe SVG colors/URLs, and escaping.
