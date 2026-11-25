# PixelForge mixed-style pixel ownership

## Required behavior

Illustration and Pixel Art may coexist in the same animation frame, raster layer, and cel. They must remain independently editable at pixel granularity. Changing the active drawing mode changes the active tool profile; it must never relabel existing pixels or grant the active mode permission to overwrite pixels authored by the other mode.

This is stronger than the existing per-layer/per-cel `authoringMode` and `modeOverrides` metadata. Those fields remember the preferred editing profile, but they do not identify which style owns an individual pixel.

## Ownership contract

Use a sparse, per-cel ownership plane alongside RGBA data:

- `0`: unowned / transparent / legacy pixel with unknown ownership.
- `1`: Illustration.
- `2`: Pixel Art.

The ownership plane is metadata, not a color channel. It must not affect exported RGBA appearance, blending, sampling, or color picking.

### Write rules

Every raster write must provide its authoring mode and operation:

1. A draw/fill/gradient/shape write may modify an unowned pixel or a pixel owned by the same mode.
2. A write targeting a pixel owned by the other mode is skipped; it must not blend with, replace, or partially soften that pixel.
3. An erase operation may reduce alpha only for pixels owned by its own mode. It must never erase the other mode.
4. When an owned pixel becomes fully transparent, clear its ownership to `0`.
5. When an unowned pixel receives non-zero alpha, claim it for the active mode.
6. Selection masks, clipping, symmetry, and layer locks remain additional constraints; ownership checks do not bypass them.
7. A no-op caused entirely by ownership conflicts must report blocked pixels distinctly from a successful write.

This deliberately prevents semi-transparent illustration brush edges from blending into hard Pixel Art pixels, and prevents a square Pixel Art brush from destroying a soft illustration stroke.

## Storage and lifecycle requirements

- Ownership data belongs to the cel, not merely the layer: two animation frames may use different styles in the same layer.
- Cloning/duplicating a cel uses copy-on-write for both RGBA tiles and ownership tiles.
- Frame switching swaps RGBA and ownership references together.
- Native tiled manifests, CodeLab ZIP packages, autosave/recovery and import/export preserve ownership data.
- Legacy dense projects without ownership metadata are read as unowned. Their first successful write claims only the pixels actually changed; migration must not guess a style from the current global mode.
- Sparse ownership tiles are omitted when all entries are `0`; tile integrity hashes cover ownership payloads independently or as part of a versioned combined resource.
- Undo/redo, cancellation, fill transactions, gradients, transforms, selection edits and erasing restore RGBA and ownership atomically. A rollback must never leave a color change without its owner metadata or vice versa.
- Existing RGBA-only readers remain compatible. Existing manifest readers must reject unsupported ownership versions clearly rather than silently discarding ownership.

## Tool integration checklist

The ownership guard must be enforced below the UI, at the shared cel write boundary, so no tool can bypass it:

- brush, eraser, symmetry and shape outlines
- bucket fill and global fill
- gradients and pattern fills
- selection clear/cut/paste and transforms
- AI edits and scripted/headless raster commands
- animation frame editing and undo/redo

A UI warning or a disabled toolbar button is not sufficient protection.

## Required regression tests

1. Draw a soft Illustration stroke, switch to Pixel Art, draw through its pixels: the original RGBA and ownership remain unchanged there.
2. Draw Pixel Art first, then cross it with a soft Illustration brush: no alpha/color blending occurs on Pixel Art-owned pixels.
3. Same-mode drawing and erasing continue to work normally.
4. Erasing one style leaves the other style untouched, including semi-transparent edges.
5. Fill, gradient, shape, selection transform, AI/headless edits and undo/redo preserve the same ownership guarantees.
6. Two frames sharing a cel initially remain isolated after editing either frame; duplicate-frame copy-on-write clones ownership with pixels.
7. Native tiled manifest, autosave/reload and CodeLab ZIP round-trip preserve mixed ownership exactly.
8. Legacy cels with no ownership plane remain visually byte-identical until edited and are not automatically assigned to either style.

## Current implementation boundary (2026-11-25)

### Implemented in the tiled path

- Both dense `RasterDocument` layers and sparse tiled cels now store sparse per-pixel ownership tiles with values `0/1/2`.
- Tiled ownership tiles are validated on manifest load (coordinates, dimensions, allowed values, canonical base64 and SHA-256); dense project JSON validates coordinates, dimensions, allowed values and canonical base64. Both formats export ownership metadata.
- Cel copy-on-write clones ownership data; native tiled project and tiled animation manifests carry the ownership tiles. Legacy cels without the field load as unowned.
- The shared tiled raster adapter guards both bounded region writes and tile-batch writes. The tiled animation adapter guards frame/layer cel region writes. Dense animation JSON preserves per-frame ownership in layer metadata and the editor restores it on frame switches.
- Dense and tiled brush/eraser, bucket fill, gradient, shape outlines, color replacement, selection paste, transforms, and dense AI/batch layer replacement respect pixel ownership.
- Dense and tiled stroke/tile-operation history capture RGBA and ownership snapshots together and restore both on undo/redo/cancel.
- Integration tests cover dense/tiled project round-trips, legacy unowned import, both cross-style directions, erasing, brush/fill/gradient/AI paths, undo/redo, and dense/tiled animation frame clone/manifest round-trip.

### Still incomplete — do not mark the feature fully released

- Dense animation frame restore now carries ownership; the remaining animation mutation APIs and every AI/headless/scripted write entry point still need a full audit.
- Server/remote cel patch generation (`createPatch`) currently diffs RGBA tiles only; ownership tile deltas are not yet represented in that patch protocol.
- Legacy RGBA export intentionally has no ownership channel. Re-importing such an export treats its pixels as unowned; native tiled manifest/animation manifest round-trips are the ownership-preserving paths.
- Selection cut/paste, transform, and any direct tile-store callers must be audited to prove they route through the guarded boundary or use a privileged, explicit restore path.
- CI for the latest changes is still running; the implementation is not CI-verified until the workflows finish successfully.

Mixed-style protection is now implemented across the dense and tiled raster brush, eraser, fill, gradient, shape, transform, selection-paste, color-replacement and batch layer-write paths, plus dense/tiled animation frame ownership. It is **not yet complete across every direct store, AI/headless, remote-patch, autosave/recovery, and legacy export path**. Do not advertise the whole feature as finished until those remaining gates and the CI suite pass.
