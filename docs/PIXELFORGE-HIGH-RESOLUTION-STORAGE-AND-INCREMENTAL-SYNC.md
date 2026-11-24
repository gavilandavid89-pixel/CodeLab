# PixelForge high-resolution, scalable storage, and incremental synchronization

**Status:** architecture decision / implementation plan. This document records constraints verified in the current code and the safe migration direction. It does not claim that object-backed project storage or incremental patch persistence is already implemented.

## Product invariants

1. The editable canvas is the source of truth for image detail. Export dimensions describe the encoded video frame, not newly created detail.
2. Export must never stretch artwork to a different aspect ratio. It may contain, crop, or scale with an explicit policy and must disclose upscaling.
3. Output FPS is not motion interpolation. If the source timeline has fewer unique poses, a higher output FPS may repeat poses. New motion requires authored/interpolated frames and must be clearly identified.
4. Existing projects retain their original dimensions, frame IDs, layer IDs, and editable content.
5. Binary assets are immutable, hash-addressed resources. Neon stores project structure, revision metadata, ownership, references, and lifecycle state.
6. Incremental writes use a base revision and idempotency key. Conflicts are explicit; a patch never silently overwrites a newer project.
7. Full import/export and full-snapshot recovery remain supported throughout migration.

## Verified current constraints

| Area | Current implementation |
|---|---:|
| Canvas maximum side | 4096 px |
| Canvas maximum area | 16,777,216 pixels |
| Raster layer memory budget | 64 MiB aggregate RGBA |
| Animation raw cel budget | 64 MiB |
| Animation frames | 240 maximum |
| Animation FPS | 1–60 |
| Animation JSON envelope | 96 MiB |
| PixelForge project JSON | 96 MiB |
| PixelForge account storage | 512 MiB |
| Direct PixelForge JSON request | 32 MiB |
| Chunked PixelForge save | 6 MiB per chunk |
| Chunk request body | 9 MiB |
| Staged uploads | 256 MiB per account |
| General CodeLab JSON body | 10 MiB default, configurable up to 50 MiB |

The general 10 MiB request-body default is not the PixelForge project-save ceiling. PixelForge has a dedicated 32 MiB JSON route and a resumable 6 MiB chunk protocol. Raising the general body limit would weaken unrelated endpoints and would not remove the 96 MiB project, 64 MiB raster/animation, or 512 MiB account limits.

The current animation model stores a full RGBA cel for every frame/layer. The project serializer encodes those cels into base64 JSON. Chunked saves resume transport, but they still serialize and upload a complete project snapshot. These are separate constraints: browser memory, animation representation, serialized project size, transfer, and account quota.

## Why the current R2 evidence path is not project storage

The repository already contains a Cloudflare Worker and R2 path for visual evidence. Its existing `/evidence/` GET/HEAD behavior serves objects publicly with immutable cache headers; signed HMAC authorization is currently applied to PUT. That behavior is suitable for intentionally shareable evidence, but it must not be reused as-is for private project cels, reference images, audio, or user assets.

Private project objects need a distinct authenticated namespace and signed reads, or a separate private bucket/worker binding. The browser must never receive R2 credentials. Object keys must be workspace-scoped and immutable, and every read/write must be authorized against the owning workspace/project.

## Target architecture

### 1. Sparse, tiled cel representation

Replace dense per-frame RGBA storage with sparse tiles (initial candidate: 64×64 pixels; benchmark 64×64 against 128×128 before locking the format).

- Omit fully transparent tiles.
- Hash each tile with SHA-256 and deduplicate identical tiles across frames/layers.
- Use copy-on-write: unchanged tiles are shared; editing a tile creates a new immutable tile.
- Keep only the active frame and a small adjacent-frame window decoded in memory; use a bounded LRU tile cache.
- Preserve a compatibility adapter so existing raster tools can continue reading/writing a full RGBA buffer for the active layer.
- Version the animation/package format and keep a v1 dense-cel reader. Do not silently reinterpret v1 data.

This makes memory use proportional to non-empty/changed image regions instead of canvas area × every frame × every layer. It also makes a one-pixel edit a small resource change rather than a new full-frame allocation.

### Implemented in-memory tile-store contract (v2 foundation)

The current isolated implementation is `SparseTileCelStore` in `public/pixelforge/src/animation-tiles.mjs`:

| Method | Contract |
|---|---|
| `createCel(document)` | Validate a v2 sparse cel, verify every tile SHA-256, and register immutable resources. |
| `createCelFromPixels(pixels, options)` | Encode a legacy dense RGBA buffer and register it as a sparse cel. |
| `cloneCel(celId)` | Clone the coordinate map while retaining the same immutable tile resources. |
| `updateTile(celId, x, y, pixels)` | Replace or remove one tile. Only that coordinate receives a new content hash; the source cel remains unchanged. |
| `getTile(celId, x, y)` | Return a defensive copy of one decoded tile, or `null` for a sparse/empty coordinate. |
| `composeCel(celId)` | Materialize a full RGBA buffer for compatibility with current raster tools. |
| `exportCel(celId)` | Export the versioned sparse cel document. |
| `diffCels(previousId, nextId)` | Return changed, added, and removed tile resources/coordinates. |
| `releaseCel(celId)` | Release tile references and reclaim unreferenced in-memory resources. |

The decoded-tile LRU cache defaults to 8 MiB and can be set to 0 to disable decoded caching. Cache memory is tracked separately from the canonical base64 tile resources. Resource references count cel-to-tile links, not project ownership or durable database references.

**Important limitation:** this store currently lives only in the current JavaScript process. It is not durable across reloads, tabs, browser restarts, or deployments; it is not a quota system; and it does not authorize access to private assets. Do not describe it as the final project storage engine. The next integration must preserve the existing synchronous raster API or deliberately migrate its callers to an asynchronous tile-aware interface, while retaining v1 dense-cel read/write compatibility.

### 2. Private content-addressed object storage

Use a dedicated private object namespace for large binary resources:

- RGBA tiles, full-resolution source images, audio, video, and other binary assets.
- Object identity is content hash + MIME + byte length.
- Neon tables store workspace/project ownership, hash, object key, byte length, MIME, reference count/lifecycle state, and creation metadata.
- Upload/download URLs are short-lived, object-scoped, HMAC-signed, and restricted by method, key, expiry, and content type.
- Uploads are verified by hash before a resource becomes visible to a project revision.
- Orphan cleanup is reference-aware and delayed; never delete an object just because an upload or revision is temporarily unreferenced.
- Quotas measure logical bytes and physical deduplicated bytes separately.

Do not move project ownership, revision ordering, permissions, or operation history out of Neon. R2 is for binary bytes, not the canonical project state.

### 3. Incremental project operations

Introduce a versioned patch API with:

- `projectId`, `baseRevision`, `operationId`, and a bounded list of typed operations.
- Stable layer/frame IDs and tile/resource hashes.
- Operations for tile replacement/removal, frame insertion/deletion/reorder, duration changes, layer metadata, and project metadata.
- A transaction that locks/checks the current revision, rejects stale bases with 409, applies the patch, advances the revision, and records the operation result.
- A unique idempotency constraint on (workspace, project, operationId), so a retry returns the original result rather than applying twice.
- Read-back of the resulting revision/hash before the client treats a save as complete.
- Periodic full-snapshot checkpoints and explicit full-save fallback for imports, migrations, recovery, or patch-chain compaction.

The first patch implementation should be limited to one resource class (tiled cels) and one client (Headless). The editor and other clients can adopt it after the contract is proven.

### 4. Canvas and export quality policy

- Keep sprite templates small and explicit.
- Add illustration/HD canvas presets only after the sparse-cel path can sustain their intended animation length.
- Preserve custom dimensions and all old projects.
- Display original canvas dimensions separately from output container dimensions.
- Offer YouTube 16:9, TikTok/Shorts 9:16, square, and original-aspect presets.
- Default to contain (no distortion); crop/fill must be explicit.
- Smooth scaling is appropriate for illustrations; nearest-neighbor remains available for pixel art.
- Warn when source content is enlarged. A 1280×720 source exported in a 3840×2160 container is still 720p detail.
- Treat 24/30/60 FPS as output cadence. Do not claim that changing the dropdown creates intermediate poses.

## Migration sequence and acceptance gates

1. **Video export correctness:** preserve aspect ratio, smooth/nearest scaling choice, source-resolution disclosure, named social presets, and timeline-clock preview. Verify actual WebM dimensions and decoded frames.
2. **Tiled cel model:** add v2 format, v1 compatibility, sparse tile encode/decode, deduplication, copy-on-write, bounded active-frame cache, and undo/redo tests.
3. **Private object store:** add signed PUT and signed GET/HEAD, workspace authorization, integrity checks, resource metadata, quotas, and orphan lifecycle tests. Do not change production bucket bindings until a deployment plan and rollback are documented.
4. **Incremental patch API:** add CAS revision checks, idempotency, atomic operations, patch replay, checkpointing, and conflict tests.
5. **Headless adoption:** make proposals report tile/resource diffs and persist only changed resources; retain explicit full-snapshot fallback.
6. **End-to-end stress test:** create a high-resolution multi-layer animation with many frames, edit a small region, prove that only changed tile objects and patch metadata transfer, reload from persisted resources, compare pixels/hashes, and export horizontal and vertical videos without modifying the source project.

No production database schema, R2 bucket, Render service, or account quota should be changed until the relevant isolated tests pass and the exact storage/cost impact is known.

## Current implementation status

- **Implemented as an isolated v2 building block:** `public/pixelforge/src/animation-tiles.mjs` encodes dense RGBA cels into sparse 64×64 tiles (with 32/128 benchmark options), omits all-zero tiles, preserves exact RGBA bytes, validates each tile with SHA-256, and computes added/changed/removed tile diffs.
- **In-memory resource store implemented:** `SparseTileCelStore` deduplicates immutable tile resources by SHA-256, shares tile references when cloning a cel, applies copy-on-write when a tile changes, removes references when cels are released, and exposes a bounded LRU cache for decoded tiles. It also offers a full-RGBA composition adapter for legacy raster consumers.
- Contract tests in `tests/pixelforge-animation-tiles.test.mjs` cover exact round trips, edge tiles, integrity rejection, tile diffs, copy-on-write sharing, resource reference cleanup, and LRU eviction. They are included in `npm run test:pixelforge`.
- **Integration boundary:** this store remains an isolated in-memory primitive. It is not yet wired into `PixelForgeAnimation`, undo/redo, project serialization, Headless persistence, or private object storage. It does not change the current 64 MiB animation budget or enable larger canvas defaults.
- Video Composer aspect-safe scaling, source-quality assessment, scaling-mode selection, source-vs-output disclosure, named 16:9/9:16 presets, and timeline-clock preview are implemented in the source-quality/motion export branch; CI has passed the PixelForge validation, animation-core, and Headless runtime workflows for the current tested revision.
- Dense RGBA cels, full-project JSON serialization, 96 MiB project envelope, 64 MiB raster/animation budgets, and 512 MiB account quota remain current constraints.
- Private project-object storage and incremental patch persistence are design targets, not yet implemented.
