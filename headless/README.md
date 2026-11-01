# CodeLab Headless Design Engine

## Purpose

This module is the first isolated step toward a real headless design editor. It operates directly on CodeLab's saved design-project JSON model. It does **not** open a browser, click UI controls, depend on the DOM, or automate the existing editor.

The browser-based Agent Space / Playwright runner remains a separate visual-inspection and screenshot mechanism. It is not the headless engine.

## Compatibility

The engine accepts existing CodeLab projects with `type: "design"` and the existing `design.elements` layer array. Existing projects that only have the legacy `frame` preset are normalized to a canvas size:

- desktop: 1440 × 900
- tablet: 768 × 1024
- mobile: 390 × 844

Custom canvas dimensions use CodeLab's existing `design.canvasWidth` and `design.canvasHeight` fields (the same fields consumed by the editor and capture pipeline). The engine also returns a structured `design.canvas` view for its own inspection API; the scalar fields remain synchronized for compatibility. Canvas width is capped at 4,000 px and height at 10,000 px. These dimensions are independent of individual layer geometry and do not overwrite the legacy `frame` preset.

## API

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

The current first cut caps designs at 200 layers, batches at 500 operations, canvas width at 4,000 px, and height at 10,000 px. The SVG renderer escapes text/attributes, validates paint colors and URL schemes, preserves text alignment/rotation/image fit, and skips hidden layers.

## Important integration boundary

This module deliberately does not write directly to disk, bypass workspace ownership, or create its own storage format. The next integration step is to call it from the existing authenticated server/assistant action layer, then persist the returned project using CodeLab's existing workspace revision and account-isolation mechanisms. Do not expose an unauthenticated HTTP endpoint that accepts arbitrary project JSON.

## Concurrency and multiple chats

The revision check is a first guard against lost updates, not a complete multi-session lock manager. Before enabling concurrent agents against the same project, the integration layer must add per-project/per-resource leases or compare-and-swap persistence, operation IDs for idempotency, and explicit conflict results. Independent projects can be processed concurrently.

## Verification

Run:

```sh
node --check headless/design-engine.js
node --test headless/design-engine.test.js
```

The tests cover legacy and editor-schema canvas compatibility, custom 720 × 1600 dimensions, add/update/delete, text alignment and rotation, optimistic revision conflicts, atomic rollback, property allowlisting, size limits, safe image/link/color handling, and SVG escaping.
