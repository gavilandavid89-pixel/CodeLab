# PixelForge native studio module

PixelForge is a first-party CodeLab studio. Its editor engine and UI stay encapsulated in `public/pixelforge/`, while CodeLab owns the account, session, platform navigation, and durable project storage.

## Native integration contract

- **Identity:** use `public/studio-core.js` for the active CodeLab session and same-origin API requests. Do not introduce a separate PixelForge login or account model.
- **Entry:** open the studio directly from CodeLab's Design area at `/pixelforge/index.html`; there is no separate PixelForge home screen.
- **Storage:** use the authenticated `/api/pixelforge/projects` API. PostgreSQL stores the project document and its raster-layer data in the dedicated `codelab_pixelforge_projects` table, scoped by the CodeLab workspace/account.
- **Isolation:** keep PixelForge-specific editor, raster document schema, styles, and assets inside this module. Keep platform-wide authentication and shared request semantics in CodeLab's shared runtime.
- **Concurrency:** every save carries a server-issued `serverRevision` token. Local edit counters are not concurrency tokens; divergent sessions must conflict even if their local edit counters happen to match.
- **Durability:** production must fail clearly when the database is unavailable; it must not silently fall back to ephemeral or sidecar storage. File-backed persistence is only a development/E2E fallback when no database is configured.
- **Safety:** validate document shape, pixel buffers, dimensions, layer references, encoded size, per-account quota, and project count on the server. The editor and API share 4096 × 4096 canvas bounds and a 64 MiB aggregate raw RGBA budget across raster layers. Enforce account isolation on every operation and never evict existing work to make room.
- **Provider credentials:** reuse CodeLab's existing AI-settings contract instead of creating a second PixelForge credential store. Never attach provider keys to artwork documents or persist them in PixelForge project records; any settings persistence remains owned by CodeLab's shared settings implementation.
- **Recent projects:** opening a saved project updates its persistent recency timestamp, so project lists reflect actual use.

## Evolving the studio

PixelForge is maintained directly in this CodeLab repository. No upstream repository sync step is part of the architecture. Make engine/UI changes inside this module and update the CodeLab-specific persistence adapter and integration tests when their contracts change. Avoid spreading raster-editor concerns into unrelated CodeLab modules.

## Animation implementation

- The isolated `src/animation.mjs` module is the canonical validated timeline model. It stores independent RGBA cels for each raster layer in every frame and supports frame duplication/reordering/deletion, precise FPS and frame durations, playback time mapping, onion-skin neighbor metadata, bounded thumbnail composition, and versioned animation JSON.
- The visual editor is integrated with that model: selecting a frame loads its cels into the existing `RasterDocument`; edits are captured back into that frame; layer add/remove/reorder operations stay synchronized; playback, onion-skin overlay, per-frame timing, loop controls, and sprite-sheet export are wired into the timeline UI and project persistence.
- Headless uses the same model through `src/animation.js`. It can capture document/layer/composite frames, read and write individual cels, duplicate/delete/reorder frames, set active frame, FPS, loop and duration, inspect onion-skin neighbors, compose frames, undo/redo animation edits, and export sprite sheets. Headless is a deterministic editing/runtime interface; it does not run a real-time playback clock.
- The animation model enforces a 64 MiB aggregate raw RGBA frame/cel budget before allocating or decoding cel buffers. This is separate from the raster document's 64 MiB budget; the complete combined project must still fit the 96 MiB serialized envelope.
- Known visual-editor limitations: canvas crop is disabled while a multi-frame timeline is active because a safe all-cel crop operation is not yet exposed; animated image import currently opens as a still image (first frame); export currently provides sprite sheets with a JSON frame/pivot manifest rather than animated GIF/APNG/video.
- The server-side project validator checks the optional animation contract before persistence and rejects a combined payload above 96 MiB.

### Local ZIP package export\n\n- Project and animation downloads use a single `.zip` file rather than triggering one browser download per frame. An animation package contains the editable `.pforge` project, transparent composite PNG frames in playback order, a `manifest.json` with per-frame durations/FPS/loop/dimensions, and a short README. No server-side render is required.\n- ZIP entries are stored without recompression (PNG is already compressed). The browser builds the archive from Blob parts and computes each entry checksum sequentially, avoiding a second full-size archive copy in memory on mobile. The package can be opened in any ZIP utility; the `.pforge` remains the source of truth for editable independent layers/cels.\n\n## Verification expectations

After changes, run the CodeLab validation workflow and Agent Space Browser Runner. Do not merge or deploy until authentication, account isolation, PostgreSQL persistence, save/load/delete, reload recovery, recent-project ordering, malformed-project rejection, quota enforcement, and account-scoped browser preferences pass.


### High-resolution capacity (testing profile)

- PixelForge animation canvas bounds are 4096 × 4096 pixels (16,777,216 pixels maximum). The aggregate in-memory timeline/cel budget is 64 MiB of raw RGBA data, matching the raster document ceiling and remaining compatible with the current base64 project envelope when serialized as the animation payload. These are hard safety ceilings, not a promise that every combination of resolution, layers, and frames fits; the model rejects combinations that exceed the aggregate budget before allocating.
- The raster document and animation cel ceilings are both 64 MiB of aggregate raw RGBA data. Both raster and animation serializers preflight their component JSON/base64 representation against a 96 MiB ceiling with an 8 MiB metadata reserve; the persistence adapter estimates the combined raster + animation + metadata envelope before JSON serialization, and the server enforces the same 96 MiB cap on the complete stored project. The undo/redo history is a separate 256 MiB RAM-only budget and is not serialized with projects. The browser uses direct JSON saves up to 24 MiB; larger saves use authenticated 6 MiB chunks (each Base64 JSON chunk request is capped at 9 MiB). The server's PixelForge JSON body ceiling is 32 MiB for ordinary direct requests and small manifests, while chunked transfers support a 96 MiB complete project and 512 MiB total storage per account. These limits are scoped to PixelForge and do not raise unrelated CodeLab API limits. The API's canvas validation now matches the editor's 4096 px maximum (previously it incorrectly stopped at 2048 px).
- Chunk sessions are stored in PostgreSQL, become unusable after 24 hours and are cleaned on the next upload initialization, accept idempotent retries, expose an authenticated status endpoint so clients resend only missing chunks, verify SHA-256 per chunk, and publish only after the full payload validates and the server-revision compare-and-swap succeeds. Each account may have at most two active sessions and 256 MiB of staged data; a failed or abandoned transfer leaves the previous saved project untouched.
- Every animation frame stores an independent RGBA cel for every raster layer. Editing one frame/layer pair cannot mutate a neighboring frame or sibling layer; duplicating a frame deep-copies its cels, and adding/removing/reordering raster layers updates the same stable layer IDs across the whole timeline. The supported ceiling is 64 raster layers and 240 frames, subject to the aggregate 64 MiB raw-cel budget and the complete 96 MiB project JSON budget. The editor and Headless runtime use the same model and project save adapter, including combined raster + animation size preflight and authenticated chunked persistence for larger projects. Timeline previews are small (at most 48×48) and cached by frame identity and layer presentation settings; editing a cel invalidates that frame's preview, while changing the layer stack invalidates the preview cache. The least-recently-used preview cache is capped at 8 MiB and 480 entries and never replaces or shares the full-resolution cel buffers.
- These coordinated limits are intended for development/testing. Production deployment still depends on validating Render ingress limits, PostgreSQL row/TOAST behavior, memory headroom, and account quota behavior under concurrent saves.

## Shared visual and Headless runtime

PixelForge now exposes a DOM-free `HeadlessEditorRuntime` for Node.js, workers, browser automation, and agent workflows. It uses the same `RasterDocument`, `AIWorkspace`, and `AICommandSession` engine as the visual editor. Its animation adapter (`src/animation.js`) delegates to the visual editor's canonical `PixelForgeAnimation` model in `src/animation.mjs`; there is one versioned timeline/cel format, not a second Headless-only animation store.

Headless actions run against an isolated sandbox. A mutating batch produces a review proposal and a pixel diff; it does not write the account project until explicit approval. Acceptance is guarded by the source revision and the server-issued `serverRevision`. A stale revision is returned as a conflict rather than silently overwriting newer work. Large approved projects reuse the editor's authenticated, resumable 6 MiB chunk upload path; the project envelope remains capped at 96 MiB.

The Headless contract tests cover raster drawing/fill/transforms, layers, selections, symmetry, animation frame/cel operations, per-cel diff bounds, capability discovery, validated multimodal vision snapshots, undo/redo, sprite-sheet export, proposal isolation, approval, revision conflicts, and persistence bridge recovery. The browser E2E test also creates an artwork in the visual editor, edits its raster and animation through Headless, approves the proposal, and reopens the same saved project in the visual editor to verify cross-mode parity. The runtime inspection response publishes the supported raster/animation action lists, safety limits, authenticated-persistence requirement, and explicit-approval requirement.

Run the focused tests with:

```sh
node --test tests/pixelforge-animation.test.mjs
node --experimental-default-type=module --test tests/pixelforge-headless-runtime.test.mjs tests/pixelforge-headless-bridge.test.mjs
```

## Agent drawing and coordinate reference

- The CodeLab agent bridge exposes `pixelforge_headless_list_projects`, `pixelforge_headless_inspect`, and `pixelforge_headless_batch`. These use the authenticated PixelForge project API and the same Headless runtime as the editor.
- `pixelforge_headless_inspect` returns project/layer/timeline metadata plus `canvas.get_reference`: pixel origin at the top-left, positive X to the right, positive Y downward, inclusive pixel bounds, corners, center, quarter landmarks, and a configurable grid.
- `canvas.get_reference` and bounded `canvas.get_region` are read-only and remain available while a proposal is pending. Use `canvas.get_pixel` to sample one color or `canvas.get_region` to inspect a precise RGBA patch (up to 32 × 32 pixels) with its exact top-left document coordinate and layer identity before drawing.
- Drawing commands use document pixel coordinates, not CSS pixels or screen coordinates. The bridge requires explicit `approval: "approved"` before a batch can be persisted.
- When the user explicitly enables artwork sharing for an AI edit, the editor now builds a validated vision snapshot with a downscaled pixel-art composite, project dimensions/layer count, viewport and selection metadata, and up to four neighboring animation frames plus the active frame. This is sent through the configured provider as multimodal image context; artwork is not attached when the consent checkbox is off. Interface screenshots are supported by the snapshot schema but are not currently captured by the editor. The visual editor has an optional Guides overlay with center/quarter crosshairs and corner coordinate labels, plus a live X/Y pixel readout under the pointer. These are view-only and never alter saved pixels or exports.
- Use a reference-first workflow: inspect dimensions and landmarks, sample important pixels, draw in a small batch, inspect the changed bounds, then approve the proposal. Keep strokes and shapes within `0..width-1` and `0..height-1`.
