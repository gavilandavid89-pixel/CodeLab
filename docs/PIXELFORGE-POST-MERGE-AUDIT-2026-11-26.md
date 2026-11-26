# PixelForge post-merge audit — 2026-11-26

**Audited baseline revision:** `f8f85467849eec25dc3dba50c1bbd126f3c90777` (merge of PR #523). This document also records the follow-up implementation and verification from PR #526.  
**Scope:** editor modes, mixed-style ownership, tiled raster/animation, Headless, persistence, package interchange and Video Composer.  
**Status:** post-merge source and CI audit. This is not a production deployment or a claim of exhaustive manual QA.

## Executive result

The merge is healthy at the repository/CI level, but PixelForge is **not yet feature-complete for every tiled/high-resolution editor workflow**. The tiled document is the active model for canvases at or above 1,048,576 pixels, while several tools and interchange actions still show explicit “not available / migrating” guards in the editor.

The correct status is therefore:
- Illustration/Pixel Art mode metadata and mixed-style ownership: implemented across the verified dense/tiled, animation, Headless and structured-package paths, with a documented legacy RGBA limitation.
- Sparse tiled editing and animation: integrated into the editor for a defined tool set; not full parity with the dense editor.
- Video composition: aspect-preserving contain/cover and per-layer Illustration/Pixel Art sampling exist in the native layered composition path.
- End-to-end export from a tiled editor project into the Video Composer: blocked by the editor's current ZIP-export guard for tiled documents.

## Post-merge CI evidence

All entries below refer to merge commit `f8f8546...` unless noted.

| Workflow | Run | Result |
|---|---:|---|
| Validate CodeLab, including chained full-system E2E | [45771268887](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45771268887) | Success |
| PixelForge PostgreSQL integration | [45771268887](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45771268887) | Success |
| PixelForge Validation | [45771268815](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45771268815) | Success |
| Agent Headless Package | [45771268897](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45771268897) | Success |
| CodeLab QA and command mailbox | [45771268970](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45771268970) | Success |
| Agent Space Browser Runner | [45771268859](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45771268859) | Success |
| Inline bridge end-to-end import | [45771268884](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45771268884) | Success |
| Real ADMIN A/B Video Composer export | [45771268843](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45771268843) | Success |
| CodeLab 5s soldier animation | [45771268865](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45771268865) | Failed only at stale duration gate |

The 5-second animation browser test itself passed: it exposed 60 frames, observed a changed rendered frame during playback, waited for the full 5-second playback window and captured a WebM. The separate workflow assertion incorrectly required a 12–14 second recording; the actual capture was 9.625 seconds because the E2E test now starts playback explicitly after page navigation. The assertion, not the animation playback, caused the failure.

A focused follow-up is tracked in [PR #524](https://github.com/gavilandavid89-pixel/CodeLab/pull/524). Its pull-request run of the same animation workflow passed with a 9.459-second recording and the same 60-frame/full-playback evidence. Do not treat PR #524 as merged until its remaining checks complete.

## Current implementation map

### Drawing modes and ownership

- Modes are `illustration` and `pixel-art`; project configuration stores enabled, initial and active modes.
- New blank projects default to Illustration with both modes enabled; legacy projects without mode metadata retain Pixel Art compatibility behavior.
- Mode changes are metadata/presentation changes, not pixel resampling, canvas resizing or layer flattening.
- Mode resolution prefers cel/frame/layer authoring metadata before project defaults.
- Mixed-style ownership is a separate sparse per-pixel plane: `0` unowned/legacy, `1` Illustration, `2` Pixel Art. A style cannot paint or erase pixels owned by the other style.
- Dense and tiled write guards, stroke history, animation cloning, Headless writes, remote cel patches and structured-package round trips have corresponding tests/documentation.

Relevant code and tests:
- `public/pixelforge/src/drawing-mode-config.mjs`
- `public/pixelforge/src/raster-style-ownership.mjs`
- `public/pixelforge/src/editor.js`
- `public/pixelforge/src/headless.js`
- `tests/pixelforge-drawing-mode-config.test.mjs`
- `tests/pixelforge-headless-runtime.test.mjs`
- `tests/pixelforge-codelab-package.test.mjs`
- `tests/pixelforge-editor-visual-modes.e2e.test.mjs`

**Format limitation:** legacy RGBA-only exports have no ownership channel. Re-importing them cannot reconstruct which style owned each pixel. Use native tiled manifests or CodeLab structured ZIP packages for ownership-preserving interchange.

### Tiled editor boundary

`editor.js` creates `TiledRasterProjectDocument` for new canvases at or above `1,048,576` pixels; smaller documents continue to use the dense `RasterDocument` path. Large imports are migrated into tiled documents.

Integrated tiled editing includes:
- brush and eraser strokes with per-pixel ownership;
- transactional flood fill and linear gradients;
- line, rectangle-outline and ellipse-outline gestures;
- rectangular, elliptical and lasso selection masks;
- pan and eyedropper;
- tiled layer add/duplicate/delete/rename, visibility, lock, opacity and reorder;
- bounded sparse thumbnails/onion skin and tiled animation frame operations;
- per-frame stroke history, playback, autosave and restore.

The following operations remain explicitly unavailable or blocked in the tiled editor path at this revision:
- magic-wand / color-based selection;
- dense transform workflows;
- selection clipboard copy/cut/paste;
- outline generation;
- horizontal/vertical flip;
- color replacement;
- AI vision snapshots;
- scene workspaces;
- sprite-sheet export;

These are concrete parity gaps, not merely documentation caveats. In particular, the editor's `#export-project` handler returns early for tiled documents even though the structured package modules and package tests cover tiled manifests. This blocks the normal editor-to-ZIP handoff for high-resolution tiled projects.

### Tiled animation

`TiledAnimationDocument` is used by the editor for tiled projects. The project and timeline share sparse tile resources with copy-on-write references. Frame operations preserve stable IDs, durations, mode metadata and cel ownership. The editor keeps history per frame, restores it when switching frames, uses bounded thumbnails/onion skin, plays the timeline and persists/restores the tiled animation manifest.

Relevant code/tests:
- `public/pixelforge/src/animation-tiles.mjs`
- `public/pixelforge/src/animation-tiled-adapter.mjs`
- `public/pixelforge/src/raster-tiled-history.mjs`
- `tests/pixelforge-animation-tiled-adapter.test.mjs`
- `tests/pixelforge-raster-tiled-history.test.mjs`
- `tests/pixelforge-editor-visual-modes.e2e.test.mjs`

### Headless and persistence

The Headless API exposes `drawing.mode.get/set`; raster actions accept an optional `authoringMode`, and accepted edits stamp/synchronize mode metadata. Headless remains the agent's isolated creative runtime, not CodeLab's persistence worker and not a holder of Neon/storage credentials.

For tiled animation persistence:
- full project snapshots remain the compatibility path for structural or multi-cel changes;
- the editor creates a cel patch only for an eligible one-cel animation change when project/frame/layer metadata is stable;
- the server validates project/frame/layer identity, tile geometry, base64/SHA-256 and ownership values;
- PostgreSQL applies the patch with revision checks and idempotent `operationId` receipts in the same transaction as the project revision update;
- uncertain retries replay the exact patch payload and operation ID.

The post-merge PostgreSQL integration and full-system validation workflows passed. This verifies the tested CI contracts, not production deployment.

### Video Composer

The native layered composition path resolves each layer/cel's authoring mode and uses smooth sampling for Illustration and nearest-neighbor for Pixel Art. `drawLayeredFrameToCanvas()` applies one uniform global scale for contain/cover; contain adds free space, cover crops, and neither stretches the source non-uniformly. Source project geometry and timing remain unchanged.

**Follow-up completed in PR #526:** the editor now exposes its existing structured CodeLab v2 package exporter for tiled projects. The Video Composer native-package path now reconstructs `pixelforge-tiled-cel` manifests by drawing sparse RGBA tiles into each layer surface rather than expecting a dense `cel.pixels` buffer. A Chromium E2E test creates a 1024×1024 tiled animation, exports it from the editor UI, imports it back and verifies mode/ownership/pixel persistence, then imports the same package into the real Video Composer UI, checks the rendered source pixel and Pixel Art sampling, and exports a WebM VP8 video. Workflow `45774472214` passed (1 test, 0 failures); the artifact includes the round-trip evidence and final WebM.

**Remaining package scope:** tiled CodeLab packages preserve sparse project/animation manifests and declared resources, but the current tiled package branch does not include the five scene-workspace manifests or Reference Center data. Those workspaces are not yet available in the tiled editor, so the package exporter reports zero scene sections and references for tiled projects rather than silently flattening them.

## Next implementation order

1. Implement tiled sprite-sheet export using bounded row/tile batches; general tiled project sprite-sheet export remains disabled.
2. Implement tiled clipboard copy/cut/paste with ownership-preserving atomic history.
3. Implement tiled flip and color replacement through guarded write boundaries.
4. Implement tiled magic-wand/color selection and transform operations, or keep their UI explicitly disabled until parity is complete.
5. Decide and document whether scene workspaces and AI vision snapshots will support tiled projects; do not silently imply parity.
6. Extend the passing package → Video Composer → WebM browser acceptance workflow to exercise a larger sparse canvas and both Illustration and Pixel Art layers in the same output.
7. Continue parity work for remaining tiled tools before calling the full Illustration/tiled integration complete.

## Acceptance rule

Do not call the Illustration/tiled integration complete until the high-resolution editor path can create, edit with the supported and required tool families, animate, save/reopen, export/import a native editable package, and compose video without changing source pixels, ownership, dimensions or timing. Every unavailable tool must either be implemented or explicitly approved as a product limitation.

## Tiled layer sprite-sheet export — 2026-11-26

The editor's **Export sprite sheet** action now supports sparse tiled projects. It reads each layer through `TiledRasterProjectDocument.readRegion()` in bounded 16-row strips and writes those strips directly into the PNG sheet. It does not call `layer.pixels`, `composite()`, or allocate a full-canvas RGBA buffer per layer. The export ZIP retains the existing `spritesheet-manifest.json` structure and adds `storageMode: "tiled"` plus each layer's `authoringMode` metadata. Dense projects keep their existing export path.

The browser E2E now downloads and inspects the tiled sprite-sheet ZIP, checks manifest geometry/mode, decodes the PNG, and verifies an exact source pixel at its original layer coordinate. The shared export-surface guard is 16 megapixels / 16384 px per side; larger sheets fail with a clear error rather than risking an uncontrolled canvas allocation.

This closes the basic tiled *layer* sprite-sheet export gap. It does not claim that every other layer operation (copy/cut/paste, transforms, magic selection, color replacement, outline generation) has tiled parity.
