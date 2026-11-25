# PixelForge mixed-style ownership rollout plan

This plan turns the contract in `pixelforge-mixed-style-ownership.md` into an implementation sequence. It is intentionally ordered so that no tool is advertised as protected before the shared storage and transaction semantics are ready.

## Current write-path inventory

| Path | Current implementation | Ownership integration required |
|---|---|---|
| Brush / eraser | `raster-tiled-brush.mjs` reads and writes a bounded RGBA region | Read owner region, filter foreign pixels before compositing, update ownership with RGBA atomically |
| Pointer strokes | `raster-tiled-pointer-controller.mjs` delegates dabs and segments to tiled stroke history | Capture the authoring mode at pointer-down; do not let a mid-stroke mode switch change ownership |
| Stroke undo/redo | `raster-tiled-history.mjs` records before/after RGBA regions | Store before/after ownership in the same history entry and restore both in one transaction |
| Bucket fill | `raster-tiled-fill.mjs` stages full changed tiles and commits through `applyTileOperation` | Exclude foreign-owned pixels during region discovery and commit owner updates in the same tile transaction |
| Gradient | `raster-tiled-gradient.mjs` stages changed tiles and commits through `applyTileOperation` | Skip foreign-owned pixels and commit owner updates atomically |
| Shapes | `raster-tiled-shapes.mjs` rasterizes dabs through tiled stroke history | Inherit the captured mode from the gesture and use the shared ownership-aware dab |
| Animation | `animation-tiled-adapter.mjs` stores per-frame/per-layer cel references | Ownership must live inside each cel so clone, duplicate, switch and copy-on-write preserve it |
| Persistence | `SparseTileCelStore.exportCel` and project/animation manifests serialize RGBA tiles | Version and validate sparse owner tiles, hashes, limits and legacy no-owner behavior |

## Implementation stages

### Stage 1 — cel storage and transaction primitive
- Add a sparse ownership tile plane to `SparseTileCelStore`, with owner values 0/1/2.
- Add bounded owner-region reads and atomic RGBA+owner writes.
- Clone/release/export/import ownership with the cel; retain copy-on-write semantics.
- Keep legacy RGBA readers visually identical and treat absent owner data as unowned.
- Add strict limits and integrity validation for ownership tiles.

### Stage 2 — central write guard
- Require explicit `authoringMode` for user-originated writes.
- At the storage boundary, skip foreign-owned pixels and return `blockedPixels`.
- Draw claims unowned pixels; erase affects only the same mode and clears ownership only when alpha reaches zero.
- Provide a separately named internal restore path for undo/redo and migration. It must restore the exact previous owner plane and must not be available to ordinary tools.

### Stage 3 — all tools and history
- Migrate brush, eraser, shape, fill and gradient to the same atomic write primitive.
- Capture mode at gesture start for pointer strokes and shape gestures.
- Extend history entries and tile-operation transactions to restore RGBA and owners together.
- Migrate selection clear/cut/paste/transforms and AI/headless write entry points before enabling the feature in the UI.

### Stage 4 — animation and persistence
- Ensure frame cloning, frame duplication and cel replacement preserve ownership.
- Add versioned project and animation manifest round trips, autosave/recovery and CodeLab ZIP tests.
- Ensure legacy imports remain unowned; never infer owner from the current mode or layer's historical authoringMode.

### Stage 5 — release gate
Do not enable mixed-style editing as a supported feature until every test in the ownership contract passes, including mixed-style brush/eraser, fill, gradient, shapes, transforms, AI/headless writes, per-frame isolation, undo/redo and persistence round trips.


## Implementation progress — 2026-11-25

- [x] Sparse cel-local owner tiles in dense and tiled projects, bounded owner-region read/write, clone and native project JSON/manifest round-trip.
- [x] Dense and tiled raster write guards; foreign-style pixels are filtered before dense writes or tiled copy-on-write commits.
- [x] Dense/tiled brush, eraser, bucket fill, gradient, shape, transform, selection paste, color replacement, batch layer replacement and reference package copy/restore routed through ownership checks.
- [x] RGBA + owner snapshots captured/restored by dense and tiled stroke/tile-operation undo/redo.
- [x] Dense and tiled animation frame clone/switch/JSON or manifest paths preserve owner tiles; tiled animation region writes are guarded.
- [ ] Audit direct tile-store writers and remaining headless animation-cel/scripted write entry points; isolated dense AI clones and accepted batch commits are guarded, but the complete agent surface is not yet audited.
- [ ] Extend remote cel patch protocol to include owner tile put/remove operations.
- [ ] Verify all autosave/recovery/ZIP flows use ownership-bearing tiled manifests; document legacy RGBA export limitation.
- [ ] Run and pass the complete CI suite on the final implementation commit.

Do not enable or advertise the complete feature until every unchecked release gate is closed.
