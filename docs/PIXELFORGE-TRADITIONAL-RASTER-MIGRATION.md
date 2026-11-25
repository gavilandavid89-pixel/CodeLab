# PixelForge: traditional raster illustration and end-to-end tiled migration

**Status:** product/architecture contract for the next implementation phase. This document does not claim that the existing editor, package format, persistence, or Headless already use sparse tiles. It defines what must be integrated before larger illustration canvases become a supported default.

## Product direction

PixelForge is evolving beyond pixel art. The canvas must support high-resolution raster illustration with the visual language of a traditional digital drawing: fine brushes, soft edges, pressure/opacity variation where the input device supports it, selections, masks, transforms, textured strokes, and smooth zoom/pan. Pixel art remains a supported mode, not the default assumption of the storage or rendering model.

The source canvas is the authoritative image. Its pixel dimensions, color data, alpha, layer structure, and animation cels must survive editing, saving, importing, exporting, and video composition. A 4K video container cannot manufacture detail absent from the source drawing.

## Non-negotiable compatibility rules

1. A project has one authoritative canvas geometry (width, height, pixel aspect ratio if introduced, and color profile if introduced). Preview scale and device pixel ratio are UI concerns, not project resolution.
2. Every raster tool works in document coordinates, not CSS/display pixels. Brush radius, selection bounds, transforms, gradients, fill tolerance, masks, and sampling must use the same coordinate system.
3. Smooth illustration rendering and pixel-perfect rendering are explicit modes. The renderer must not silently blur pixel art or quantize illustration pixels.
4. Sparse tiles are the canonical storage representation for the new format. Dense RGBA buffers are compatibility adapters for operations that need a bounded working surface; they must not be re-serialized as the whole project after every small edit.
5. Existing v1 projects and packages remain readable and editable. Migration to tiled data is deterministic and lossless; no automatic resampling or dimension change is allowed.
6. ZIP import/export, Headless, CodeLab persistence, and Video Composer must preserve the same project identity, dimensions, frame/layer IDs, timing, tile hashes, and resources.
7. The user must be able to reopen an exported package in a clean session and reproduce the same pixels and animation timing.
8. Quotas must distinguish logical project bytes from physically deduplicated object bytes. Raising a UI limit without storage, memory, and authorization changes is not a capacity increase.

## Component integration matrix

| Component | Required behavior in tiled/high-resolution mode | Compatibility boundary / acceptance |
|---|---|---|
| Canvas renderer | Render visible tiles at viewport scale; request only visible/nearby tiles; smooth or nearest sampling by explicit mode | Zooming does not mutate source pixels; no full-canvas decode merely to pan |
| Brush / pencil / eraser | Rasterize strokes in document coordinates and update only intersected tiles | Same stroke result at different zoom levels; undo restores exact tile hashes |
| Selection / lasso / magic wand | Store selection geometry/mask independently or as sparse masks; process bounded tiles | Move/copy/fill/cut across tile edges without seams or lost alpha |
| Fill / gradient / sampling | Work with tiled neighborhoods and explicit color/alpha semantics | Large fills have bounded memory and deterministic results |
| Layers / masks / blend modes | Keep layer metadata independent from tile payloads; composite only visible dirty tiles | Layer reorder, opacity, visibility, masks, and blending survive save/reopen |
| History / undo / redo | Record immutable tile-resource references and metadata deltas | One brush stroke stores changed resources, not a full canvas copy |
| Animation timeline | Store each frame/layer cel as a sparse tile map; share unchanged resources copy-on-write | Duplicate frame is cheap; edits affect only the target frame/layer tiles |
| Project serializer | Versioned project manifest references immutable tile objects by hash, dimensions, MIME and byte length | v1 dense reader remains; v2/v3 format cannot silently fall back to lossy raster export |
| ZIP / CodeLab package | Include a tile/resource manifest and binary tile entries; integrity manifest covers every resource | Import validates paths, sizes, hashes, references and quotas before commit; export round-trips exactly |
| Importer | Accept legacy dense packages and new tiled packages; stream/validate resources before allocating editor memory | Malformed/missing/duplicate tiles reject atomically; no partial project installation |
| Exporter | Export native tiled package without flattening; image exports may materialize a bounded composite | PNG/WebP dimensions equal the selected source/output dimensions; no invented detail |
| Headless | Inspect and edit tile resources through stable frame/layer/tile IDs; proposals include resource diffs | Existing action protocol remains usable through a compatibility adapter; Headless stays isolated from storage credentials |
| CodeLab server / Neon | Authorize workspace/project, persist revision metadata and idempotent patch operations; store binary objects privately | Compare-and-swap base revision; stale patch returns 409; read-back verifies hashes |
| Object storage | Store immutable content-addressed private tiles and original assets | Signed, short-lived, object-scoped access; no public read path or browser-held storage credentials |
| Video Composer / A-B | Decode source tiles for each composed frame, composite layers, then scale into horizontal/vertical/square output | Aspect policy is explicit; source detail assessment is shown; output FPS does not imply interpolation |
| Mobile UI | Provide responsive zoom/pan, brush controls, memory-aware tile cache and visible progress | No UI control reports a higher resolution than the source document actually stores |

## Data contract and package evolution

The existing pixelforge-project v1 and pixelforge-animation v1 formats store dense base64 RGBA. The existing CodeLab structured package v2 currently validates dense layer/cel payloads. Do not overload those formats by changing the meaning of pixels.

The tiled migration must use an explicit versioned resource manifest. The minimum conceptual records are:

- Project: format, version, id, name, width, height, active layer, color metadata, revision and references to layers/animation.
- Layer: stable layerId, order, visibility, opacity, lock, blend/mask metadata, and cel/resource references.
- Cel: stable frameId + layerId, canvas dimensions, tile size, sparse coordinate-to-resource map.
- Tile resource: SHA-256, width, height, RGBA format, byte length, and immutable object reference.
- Animation: stable frame IDs, order, duration, FPS, loop/playback metadata, and cel references.
- Package manifest: schema version, entrypoint, resource index, integrity index, and declared total logical bytes.

Use separate format identifiers (for example, pixelforge-project v2 and a new structured package schema version) rather than changing v1 in place. The exact version numbers must be finalized together with importer/exporter tests before implementation ships.

The first implementation may use ZIP-contained tile binaries. Private remote object storage is a later transport optimization, not a prerequisite for proving the file format. ZIP import must verify every hash before constructing the project. The same resource manifest should be usable by local files, Headless, and remote storage so that changing transport does not change project semantics.

## Migration and rollout gates

### Gate A — editor model and tool parity
- Implement a tile-backed raster layer with a bounded decoded working-set cache.
- Keep a dense compatibility surface only for legacy tools that explicitly request a region or full composite.
- Migrate brush, eraser, fill, selection, transforms, masks, compositing, thumbnails, history, and animation cels.
- Test strokes and selections across tile boundaries, sparse transparent canvases, alpha preservation, zoom invariance, undo/redo, and multi-layer blending.
- Do not raise the default canvas preset until the worst-case working set is measured on desktop and mobile.

### Gate B — native project and package
- Add a versioned project manifest and tiled animation/cel representation.
- Keep v1 readers and a deterministic migration path.
- Update .codelab-pixelforge ZIP export/import, structured package validation, integrity manifests, scene workspaces, reference center and resource accounting.
- Round-trip a multi-layer animated illustration through ZIP import/export and compare every source tile hash and frame/layer metadata.

### Gate C — CodeLab persistence and incremental sync
- Persist immutable tile blobs separately from Neon project/revision metadata.
- Add authenticated upload/read authorization, per-workspace quota accounting, idempotent operations and atomic base-revision checks.
- Headless proposals send only changed resource references and metadata operations.
- Verify a small brush edit uploads only intersecting tiles, not the full project or unchanged frames.
- Keep a full snapshot/checkpoint path for recovery and old clients.

### Gate D — video and delivery
- Video Composer and A/B read the exact saved project revision, resolve only needed cel resources, composite layers and render the selected output aspect ratio.
- Add output-size and source-detail disclosure. A larger output is an upscale, not a detail enhancement.
- Verify horizontal 16:9, vertical 9:16 and square exports from one source project; source tile hashes must remain unchanged.
- Compare decoded output frames, frame durations and total playback time with the source timeline.

### Gate E — performance and reliability
- Stress-test a high-resolution illustration with many layers and animation frames on desktop and mobile.
- Measure peak decoded cache, history memory, package size, upload bytes, import time, export time and dropped playback frames.
- Simulate interrupted upload, retry, duplicate operation ID, stale revision, missing tile, corrupt hash and quota exhaustion.
- Confirm cleanup never deletes a tile still referenced by any live project revision or checkpoint.

### Explicit authoring mode ownership (required metadata contract)

A project-level active mode is only the editor's current default; it is not sufficient to identify the content already stored. Every raster layer must serialize an explicit `authoringMode` (`illustration` or `pixel-art`). Every animation frame must serialize its own `authoringMode`, and every frame/layer cel must serialize `metadata.authoringMode` as well. The cel mode is authoritative for that cel; when a cel is created without an explicit override, it inherits the frame mode, and the frame default inherits the layer mode. New layers/frames must materialize the resolved value rather than leave it null or rely on the editor's current global selection.

The resolved mode and per-mode tool overrides travel with the layer/cel through duplicate, reorder, edit, undo/redo, native save/load, ZIP import/export, Headless operations and Video Composer. Copying a frame copies its frame mode and each cel's mode independently. Changing the active editor mode never rewrites existing layer/frame/cel mode metadata or pixel/tile bytes. Legacy records with missing metadata receive a deterministic migration default (`pixel-art`) at import; they must never be interpreted from whichever mode happens to be active when opened.

The editor now stamps the selected mode at the moment a raster brush/eraser stroke, shape gesture, or gradient gesture begins. It writes the mode to the active dense/tiled layer and, when a dense animation is open, to the active frame and the specific frame/layer cel metadata. New dense layers and blank animation frames inherit the currently selected mode. On animation frame restore, cel mode metadata is restored onto the corresponding editor layer, falling back to the frame mode for older cel metadata. The dense animation model serializes `frames[].authoringMode` and per-cel `metadata.authoringMode` as well as preserving these values when duplicating frames.

This is the first editor-level integration slice, not completion of every drawing operation or every application surface. Fill, text, transform, AI-generated edits, imported assets, native save/load of all metadata paths, Headless runtime, and Video Composer still require dedicated mode propagation and regression coverage. Do not claim end-to-end Illustration integration until those paths are tested.

The tiled animation manifest therefore records `frames[].authoringMode` and `frames[].cels[].metadata.authoringMode`; tiled project manifests record `layers[].authoringMode`. Readers validate known mode values and normalize missing legacy fields at the compatibility boundary.

## Current implementation status (truthful boundary)

- The branch contains an isolated SparseTileCelStore and sparse tile codec with hashing, deduplication, copy-on-write, resource diffs and a bounded decoded-tile LRU cache.
- The branch contains source-quality-aware video scaling and timeline-clock preview improvements.
- The sparse store is not yet the canonical editor layer/cel model. Brush, selection, fill, history, project serialization, package import/export, Headless persistence and remote storage are not yet migrated to it.
- Current v1 dense limits still apply. This document does not authorize larger default canvas dimensions, larger animation limits, or larger account quotas.
- No production Neon schema, R2 bucket, Render service, or account quota is changed by this architecture document.

## Incremental implementation: animation migration adapter

The branch now includes `public/pixelforge/src/animation-tiled-adapter.mjs` and contract tests.

- `TiledAnimationDocument.fromAnimation()` performs an explicit, lossless one-time migration from the current `PixelForgeAnimation` dense model into the sparse tile store. It preserves canvas dimensions, FPS, frame IDs/durations, layer IDs, active frame and layer metadata.
- `readRegion()` and `writeRegion()` expose bounded tile-backed editing for a frame/layer. A changed region replaces only intersecting tile resources; unchanged frames/layers remain shared.
- `cloneFrame()` shares immutable tile resources (copy-on-write); `deleteFrame()` releases its references.
- `toManifest()` emits a tiled animation manifest without flattening cels; `fromManifest()` validates timeline/layer/frame structure and every tile hash before rebuilding the in-memory tiled model. `toLegacyAnimationJSON()` is an explicit compatibility export and intentionally materializes dense v1 cels.
- `dispose()` releases the adapter's in-memory resource references.

**Boundary:** this is a migration/working-model adapter, not yet the editor's canonical animation model. The current editor, undo/redo, brush pipeline, native project serializer, ZIP package, Headless and server persistence still use their existing paths. The initial v1-to-tile conversion reads dense cels once and therefore does not remove the current v1 memory/size limits during import. No higher default canvas size or quota is enabled by this adapter.

## Project-persisted drawing modes and mid-project switching

A PixelForge project owns its drawing-mode configuration. It is serialized with the native project snapshot and therefore travels with autosave, account save/load, legacy editable project JSON, and the structured CodeLab ZIP package's `project.json`. The editor must restore it automatically when opening a project; users must not have to reselect the mode after import.

The v1 configuration contract is:

```json
{
  "version": 1,
  "availableModes": ["illustration", "pixel-art"],
  "initialMode": "illustration",
  "activeMode": "illustration"
}
```

- `availableModes` declares which modes this project supports.
- `initialMode` is the project's preferred starting mode when no valid active selection exists.
- `activeMode` records the current selection and is restored when the project is reopened.
- When both modes are enabled, PixelForge opens in the saved active/initial mode and offers an immediate switch in the editor. A project may restrict itself to one mode; the UI disables modes not enabled by that project.
- Users may switch illustration ↔ pixel art at any point, including during an animation project. The selection is project state and autosaves.
- The mode switch changes presentation/tool defaults (smooth vs nearest-neighbor canvas preview and soft vs hard brush hardness defaults). It must not resize, resample, quantize, flatten, or rewrite existing pixels, cels, frame timing, or tile hashes.
- Exported project ZIPs retain this configuration because it is embedded in `project.json`; importing the ZIP restores the selected mode before the editor is shown. Video Composer inherits the matching smooth/pixelated scaling default from native project mode, while allowing the user to change it for a specific export.
- Legacy projects without this metadata receive a compatibility default of pixel art. New blank documents start in illustration mode with both modes enabled. Importing a raster image starts from illustration defaults unless a native project contains its own saved configuration.

**Current implementation boundary:** the persisted configuration, editor selector, restore path, mode-specific preview sampling, brush size/shape/hardness defaults and transform interpolation defaults are implemented. The complete tiled raster engine and all per-tool mode-specific rasterization semantics are still under migration; this selector does not yet convert the dense editor document to a tile-backed document. A project mode switch is lossless metadata/presentation state, not a destructive conversion.

## Incremental implementation: tiled raster project adapter

The branch now also includes `public/pixelforge/src/raster-tiled-adapter.mjs` and dedicated contract tests.

- `TiledRasterProjectDocument.fromDocument()` migrates all existing raster layers into sparse tile cels, preserving project identity, dimensions, layer order/IDs, visibility, opacity, lock state, blend/mask/clipping metadata and drawing configuration.
- `readRegion()` / `writeRegion()` operate on a specific layer without composing a full project image. Locked layers reject writes.
- Layer duplication shares immutable tile resources; a subsequent edit uses copy-on-write. Deleting a layer releases its cel references.
- `toManifest()` and `fromManifest()` provide a validated versioned tiled project representation. `toLegacyProjectJSON()` is an explicit compatibility export that materializes dense v1 layer buffers.
- The adapter enforces current canvas geometry and layer-count limits and uses a bounded decoded-tile cache.

**Boundary:** this is still an opt-in migration adapter. `RasterDocument`, the editor brush/fill/selection/transform pipeline, undo/redo, compositing, project serializer, ZIP package and Headless raster actions have not yet switched to this as their canonical storage. The one-time migration from v1 must materialize the existing dense source layers. Existing 64 MiB document/animation constraints remain until the editor's actual working set and history are tile-backed and stress-tested.


### Guarded mode transitions and per-cel exceptions
- The editor stores non-default brush size, shape, hardness, opacity and transform interpolation under the active layer's mode-specific `modeOverrides`. Defaults are not redundantly stored; switching modes suspends the old profile and restores the target profile. Selecting another layer restores that layer's profile, and native project JSON preserves it.

The editor stores per-layer and per-animation-cel, per-mode non-default tool profiles (`brushSize`, `brushShape`, `brushHardness`, `brushOpacity`, and transform `interpolation`). Standard defaults are omitted to keep metadata compact. Switching modes suspends the previous profile and restores the target mode's profile; selecting another layer restores that layer's saved profile. These exceptions are included in native v1 project JSON and animation frame-layer metadata, and are not applied as pixel mutations.

The tiled project adapter now exposes a metadata-only mode transition. Switching illustration ↔ pixel art changes only the project's active drawing mode; it does not clear, resample, quantize, rewrite, or discard any cel/tile bytes. Each layer/cel may retain an optional `authoringMode` and `modeOverrides` record. Those values represent non-default settings that must survive when the project changes modes and later switches back. The adapter reports `pixelsChanged: false` and `celsRewritten: 0` for a transition, and tests compare tile SHA-256 values before and after both directions.

This is the safe interpretation of a mode-switch guard: deactivate the previous mode's defaults for new editing operations, but preserve source pixels and per-cel exceptions as dormant metadata. Do not physically delete “extra” pixels or settings. The editor's dense v1 model still needs the same contract wired into its canonical per-cel/tile storage before this guard can be considered end-to-end.


## Pixel growth: verified blockers and current safe boundary

A mode switch is non-destructive, but that does **not** mean the current editor accepts unlimited additional canvas pixels or layers. The v1 dense editor still rejects:
- dimensions above 4096 px per side or 16,777,216 total canvas pixels;
- more than 64 layers;
- aggregate layer RGBA allocations above 64 MiB (including add/duplicate/crop/import/restore paths);
- projects whose JSON exceeds 96 MiB;
- animation above 64 MiB raw cel storage, more than 240 frames, or more than 64 layers;
- server saves above the same 64 MiB raster/animation checks, 96 MiB project envelope, or 512 MiB account storage.

The API has its own 32 MiB direct JSON limit and 6 MiB chunk protocol (9 MiB request body per chunk); these are transport limits, not extra drawing capacity. The editor's 256 MiB import file ceiling and the staged upload ceiling are separate again.

The tiled adapter now has a proof test showing that a sparse 4096×4096 project can represent 17 layers (over 1 GiB of theoretical dense RGBA) using a single deduplicated 32×32 tile resource. This bypasses the legacy *aggregate dense allocation* limit inside that adapter only. The editor still creates and edits `RasterDocument` dense buffers; its migration adapter begins with `toJSON()`, and the v1 server/package path still rejects those larger dense projects. Therefore this is not yet an end-to-end larger-pixel feature.

**Do not remove the v1 guards until the native editor, animation, history, compositing, package/ZIP, Headless and server persistence all consume the sparse tiled representation.** The exact audit and migration order live in [the high-resolution capacity audit](PIXELFORGE-HIGH-RESOLUTION-STORAGE-AND-INCREMENTAL-SYNC.md).


### Native tiled project creation milestone

The tiled raster adapter now exposes `TiledRasterProjectDocument.createBlank()`, backed by `SparseTileCelStore.createBlankCel()`. New projects created through this API begin with an empty sparse cel: no full-canvas RGBA allocation and no intermediate legacy `RasterDocument.toJSON()` conversion. A 4096×4096 regression test edits one pixel, checks that only one tile resource is allocated, duplicates the layer through shared tile references, and verifies copy-on-write isolation plus manifest export.

This is a migration milestone, not yet the default editor path. The UI still constructs the legacy dense document; tool/history/animation parity, sparse project open/save, ZIP/Headless support, and durable server persistence remain required before raising or removing legacy limits.


The adapter's bounded region-write path now releases the replaced layer-owned cel after a successful copy-on-write operation. This prevents stale cel/resource references from accumulating while preserving references held by duplicated layers. The new lifecycle test checks live cel count and complete resource cleanup on disposal.

### CodeLab ZIP: sparse animated project boundary

The CodeLab structured ZIP v2 path now accepts a tiled raster project together with an optional `pixelforge-tiled-animation` manifest embedded in `project.json`.

- Export/import validates the animation manifest, every cel's tile resources and SHA-256 integrity through `TiledAnimationDocument`.
- Canvas dimensions, layer IDs and layer order must match the parent tiled project; malformed or mismatched animation data is rejected.
- Frame IDs, order, durations, FPS, sparse tile payloads and per-cel metadata survive package round trips. Per-cel `authoringMode` and `modeOverrides` can therefore retain illustration and pixel-art editing profiles in different frames of the same animation.
- Tiled animation stays sparse inside the ZIP. The exporter does not generate dense `Frames/frames.tscn` RGBA cels, and package metadata reports the actual tiled frame count.
- A browser package regression covers two frames with different authoring modes, distinct durations, tile-backed pixel edits and import/export restoration.

**Boundary:** this completes the package-format boundary only. The editor still rejects `ensureAnimation()` for tiled raster projects and does not yet expose a live tiled timeline, onion skin, frame editing, playback, or autosave of `TiledAnimationDocument`. Do not describe mixed-mode high-resolution animation as fully available in the UI until that editor integration and persistence path are implemented and tested end-to-end.

### Structured package and agent-mode propagation

- Structured CodeLab v2 .codelab-pixelforge packages now carry authoringMode on every exported frame and on each frame-layer cel declaration, plus sparse modeOverrides. Import restores those fields into the native animation frame and layer-metadata records.
- Dense animation metadata normalization now retains modeOverrides through clone, duplicate, JSON save and restore; resolveDrawingMode() reads the canonical frame.layerMetadata[] record for the requested cel before falling back to frame, layer or project mode.
- Headless agent raster edits stamp the project's active drawing mode onto the edited layer and active animation cel. This keeps agent-produced content tagged consistently with the editor's current project mode.
- These additions close the structured-package and headless raster-edit propagation gaps; they do not yet provide independent interpolation per layer when a single composite video frame contains both pixel-art and illustration layers. Video Composer's scaling selector remains an export-wide choice until that rendering path is upgraded.


### Transactional sparse tiled fill (implemented; editor integration in progress)

- Added an atomic `SparseTileCelStore.writeTileBatch()`: it clones the source cel once, validates unique aligned tile coordinates and byte budget before mutation, writes every replacement tile into the private clone, and only returns the new cel after all tile updates succeed. On failure, the clone and its resource references are released; the source cel remains unchanged.
- Exposed the batch operation through `TiledRasterProjectDocument.writeTileBatch()`, swapping the active layer's cel only after the store batch succeeds.
- Extended `TiledRasterStrokeHistory` with bounded tile-operation commands. A fill is one undo/redo command and stores before/after tile buffers, not a canvas-sized RGBA snapshot. Undo/redo also apply one atomic batch.
- Added `raster-tiled-fill.mjs`: scanline flood fill uses a one-bit-per-pixel visited map, a capped queue of run seeds, a three-row read cache, and staged changed tiles. The fill rejects before committing if the staged history byte budget or queue cap is exceeded. Global fill scans rows without allocating a full RGBA canvas. Transparent pixels use alpha-aware matching; checker fill and tolerance remain supported.
- The editor's bucket-fill action now dispatches to this tiled path for tiled documents. It reports failure without presenting a partial fill as successful.
- Rectangular, elliptical and lasso selection masks are accepted by tiled documents (bounded one-byte-per-pixel compatibility mask, up to 16 MiB at current geometry limits). Tiled brush/eraser and flood fill clip to that mask; fill treats it as both a traversal and paint boundary.
- Magic-wand/color selection remains unavailable in tiled mode because its current source path requires a dense full-layer pixel buffer.
- Regression tests cover atomic fill/undo/redo, contiguous boundary behavior and budget rejection without pixel changes.

### Transactional tiled linear gradients (implemented)

- The linear gradient tool is now enabled for tiled documents and uses `raster-tiled-gradient.mjs` rather than the dense `RasterDocument.fillGradient()` path.
- The operation scans one source row at a time, stages only changed tiles, and writes them as one `TiledRasterStrokeHistory` tile operation. It does not allocate a full-canvas RGBA buffer.
- The active selection is a paint boundary; the gradient uses the same endpoint projection, color interpolation, alpha compositing and opacity semantics as the dense implementation.
- The working/undo budget is checked before the first write. Budget rejection is atomic; identical gradients produce no history command; undo/redo treats the complete gradient as one operation.

### Transactional tiled shape outlines (implemented)

- Line, rectangle-outline and ellipse-outline gestures now rasterize through the tiled brush/history path instead of being rejected by the tiled editor guard.
- `raster-tiled-shapes.mjs` accepts an already-rasterized document-coordinate path, preflights every point and symmetry expansion against a hard dab cap, and applies the outline as one `TiledRasterStrokeHistory` command.
- Every dab writes only its clipped brush region; selection masks are honored by the shared tiled brush primitive. No full-canvas RGBA surface is allocated for a shape.
- If the path exceeds the dab cap, it is rejected before drawing. If the undo byte budget is exceeded during rasterization, the active history stroke rolls back before the error is returned. Undo/redo treats the complete shape as one operation.
- Editor shape gestures are serialized with tiled pointer gestures so two operations cannot claim the same history transaction concurrently. Symmetry is expanded in document coordinates and is covered by tests.
- **Scope limit:** this does not yet implement tiled gradients, magic-wand/color selection, transforms, general layer-metadata history or tiled animation cels. The visited bitset is bounded by the existing maximum canvas area; staged RGBA history, scanline queue and shape dab count have explicit caps. Do not raise canvas or history limits based on these tools alone.

### Tiled layer management and metadata history

The sparse editor layer panel now enables add, duplicate, delete, rename, visibility, lock, opacity and stack reordering. These operations are wrapped in bounded metadata-history snapshots. Snapshots retain shared immutable cel references rather than copying canvas pixels; undo/redo restores layer order, active-layer identity and metadata while preserving copy-on-write tile ownership. Snapshot metadata is charged against the same history byte budget, and a rejected operation is rolled back rather than left applied without an undo command. The editor still enforces the 64-layer cap and the tiled document's existing geometry limits.
