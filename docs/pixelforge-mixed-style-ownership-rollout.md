# PixelForge mixed-style ownership: implementation and audit

This document records the implemented ownership contract, the write-path integration, persistence behavior and verification status. The rollout inventory below reflects the audited implementation, not the original pending work plan.

## Current write-path inventory

| Path | Implemented behavior | Audit status |
|---|---|---|
| Brush / eraser | `raster-tiled-brush.mjs` routes bounded writes through ownership-aware raster adapters. Foreign-owned pixels are filtered before compositing; RGBA and owner changes are committed together. Erasing only affects pixels owned by the active style and clears ownership when alpha reaches zero. | Complete |
| Pointer strokes | `raster-tiled-pointer-controller.mjs` captures the authoring mode at pointer-down and carries it through dabs, segments and stroke history. A mode change cannot relabel an in-progress gesture. | Complete |
| Stroke undo/redo | `raster-tiled-history.mjs` records before/after RGBA and owner snapshots in the same history entry and restores both atomically. Restore of owned regions requires the exact owner snapshot. | Complete |
| Bucket fill | `raster-tiled-fill.mjs` excludes foreign-owned pixels during region discovery and commits accepted RGBA/owner changes through the guarded tile operation. | Complete |
| Gradient | `raster-tiled-gradient.mjs` filters foreign-owned pixels and commits RGBA/owner updates atomically. | Complete |
| Shapes | `raster-tiled-shapes.mjs` uses the shared ownership-aware stroke/dab path and the gesture's captured authoring mode. | Complete |
| Transform, selection and color operations | Transform, selection paste/clear, color replacement and batch layer replacement use guarded write boundaries and preserve owner snapshots for restoration. | Complete |
| Animation | Dense and tiled frame/cel clone, duplicate, switch and replacement paths preserve cel-local ownership. Frame/layer mode metadata is retained in the relevant native serialization paths. | Complete |
| Headless / agent writes | `animation.frame.set_cel` validates the authoring mode, applies the shared ownership guard, stamps frame mode metadata and reports blocked pixels. Proposal diffs include owner-plane and mode-only changes. | Complete |
| Remote patch receiver | Cel patch v2 emits/applies `ownership.put` and `ownership.remove` atomically with RGBA operations. Receiver/server validation rejects ownership bytes for missing or transparent RGBA pixels. | Complete |
| Persistence and recovery | Native project/animation manifests, full-snapshot autosave, chunked save, offline recovery and reconnect preserve ownership metadata. The JSON size estimator accounts for owner metadata. | Complete |
| Import/export | CodeLab ZIP export/import preserves mode and owner metadata; strict validation checks tile structure, values, bounds, canonical bytes and RGBA alpha consistency. | Complete, with legacy limitation below |

## Ownership contract

- Ownership is cel-local and sparse; owner values are validated (0/1/2) and transparent pixels cannot retain an owner.
- User- and agent-originated raster writes specify an authoring mode and pass through guarded dense/tiled adapters.
- A write can modify unowned pixels or pixels belonging to its own style; it cannot paint over or erase pixels owned by the other style.
- The authoring mode is captured for a gesture, so switching modes affects subsequent work rather than changing the ownership of an active stroke.
- RGBA and ownership are one logical transaction. Undo/redo and internal restore paths must carry the exact owner snapshot when restoring an owned region.
- Raw `SparseTileCelStore` mutation methods are internal storage primitives, not public tool write paths. Adapter restore APIs reject owned-region restoration without the corresponding exact owner snapshot.
- Frame/cel cloning and native persistence preserve ownership; legacy imports without ownership data remain unowned. Ownership is never guessed from the currently selected mode or a layer's historical mode.

## Final audit — 2026-11-26

- [x] Sparse cel-local owner tiles in dense and tiled projects, bounded owner-region read/write, clone and native project JSON/manifest round-trip.
- [x] Dense and tiled raster write guards; foreign-style pixels are filtered before dense writes or tiled copy-on-write commits.
- [x] Brush, eraser, bucket fill, gradient, shape, transform, selection paste, color replacement, batch layer replacement and reference package copy/restore use ownership-aware write boundaries.
- [x] Dense/tiled stroke history and tile-operation undo/redo restore RGBA and owner snapshots together.
- [x] Dense and tiled animation frame clone/switch/JSON or manifest paths preserve owner tiles; transparent pixels cannot retain owner metadata.
- [x] Headless full-cel writes use the shared ownership guard and report blocked pixels; invalid authoring modes are rejected.
- [x] Remote cel patch v2 generates and applies ownership operations atomically; receiver/server validation rejects ownership on missing or transparent RGBA pixels.
- [x] Dense 64px ownership grids are re-tiled losslessly when migrating to sparse cels with a different tile size.
- [x] Direct writer audit completed: user/agent raster writes enter through guarded dense/tiled adapters; raw storage writes remain internal; restore paths require exact owner snapshots.
- [x] Full-snapshot autosave, chunked save, offline recovery and reconnect preserve native ownership metadata. The JSON size estimator includes owner metadata.
- [x] CodeLab ZIP export/import preserves mode and owner metadata; strict import validation checks owner tile structure, values, bounds, canonical bytes and RGBA alpha consistency.
- [x] Regression tests cover Headless full-cel writes, invalid modes, remote ownership patches, transparent-owner rejection, stale-owner prevention, dense/tiled restore guards and dense-to-sparse re-tiling.
- [x] CI verification passed on implementation commit `d6a1b9f7a45c2c29d488067f8f29cf9c7700d696`: PixelForge animation core, Headless runtime, native Headless contract, PixelForge validation, mobile UI, visual animation evidence, browser runner, CodeLab QA, full CodeLab validation and PostgreSQL integration. Full-system E2E, offline recovery/reconnect and concurrent-account isolation checks were also reported passing in that validation cycle.

### Remaining format limitation

Legacy RGBA-only export intentionally has no ownership channel. Re-importing such an export treats its pixels as unowned; native tiled project/animation manifests and CodeLab ZIP packages are the ownership-preserving paths. This is a documented format limitation, not a silent ownership inference.

### Verification scope and maintenance

The CI statement above is pinned to the implementation commit listed above. Documentation-only edits do not change runtime behavior; re-run the relevant workflows after code changes and update this audit when write paths, serialization formats or test coverage change.
