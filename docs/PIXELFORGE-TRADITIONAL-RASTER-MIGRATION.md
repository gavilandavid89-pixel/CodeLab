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
