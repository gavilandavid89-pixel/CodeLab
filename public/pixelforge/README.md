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

## Animation roadmap

- The isolated `src/animation.mjs` module provides a validated, UI-independent timeline model with independent per-layer RGBA cels, frame duplication/reordering/deletion, precise FPS and frame durations, playback time mapping, onion-skin neighbor metadata, and versioned animation JSON.
- The animation model synchronizes add/remove/reorder operations for raster layers and enforces a 64 MiB aggregate raw RGBA frame/cel budget before allocating or decoding cel buffers. This keeps one 4096×4096 RGBA cel representable as base64 inside the 96 MiB project envelope when it is the main payload.
- The current raster editor remains the drawing surface. Animation UI, frame switching into the existing `RasterDocument`, playback rendering, project persistence, and animation export are intentionally separate integration steps; do not replace the editor or bypass its existing tools/history.
- The server-side project validator now checks the optional animation contract before persistence. The animation component can approach the 96 MiB envelope on its own; do not assume a full-size raster document and a full-size timeline can both fit together. The server rejects a combined payload above 96 MiB.

## Verification expectations

After changes, run the CodeLab validation workflow and Agent Space Browser Runner. Do not merge or deploy until authentication, account isolation, PostgreSQL persistence, save/load/delete, reload recovery, recent-project ordering, malformed-project rejection, quota enforcement, and account-scoped browser preferences pass.


### High-resolution capacity (testing profile)

- PixelForge animation canvas bounds are 4096 × 4096 pixels (16,777,216 pixels maximum). The aggregate in-memory timeline/cel budget is 64 MiB of raw RGBA data, matching the raster document ceiling and remaining compatible with the current base64 project envelope when serialized as the animation payload. These are hard safety ceilings, not a promise that every combination of resolution, layers, and frames fits; the model rejects combinations that exceed the aggregate budget before allocating.
- The raster document and animation cel ceilings are both 64 MiB of aggregate raw RGBA data. Both raster and animation serializers preflight their component JSON/base64 representation against a 96 MiB ceiling with an 8 MiB metadata reserve; the server enforces the same 96 MiB cap on the complete stored project. The undo/redo history is a separate 256 MiB RAM-only budget and is not serialized with projects. The browser uses direct JSON saves up to 24 MiB; larger saves use authenticated 6 MiB chunks (each Base64 JSON chunk request is capped at 9 MiB). The server's PixelForge JSON body ceiling is 32 MiB for ordinary direct requests and small manifests, while chunked transfers support a 96 MiB complete project and 512 MiB total storage per account. These limits are scoped to PixelForge and do not raise unrelated CodeLab API limits. The API's canvas validation now matches the editor's 4096 px maximum (previously it incorrectly stopped at 2048 px).
- Chunk sessions are stored in PostgreSQL, become unusable after 24 hours and are cleaned on the next upload initialization, accept idempotent retries, expose an authenticated status endpoint so clients resend only missing chunks, verify SHA-256 per chunk, and publish only after the full payload validates and the server-revision compare-and-swap succeeds. Each account may have at most two active sessions and 256 MiB of staged data; a failed or abandoned transfer leaves the previous saved project untouched.
- The current timeline JSON uses base64 cel payloads. A 64 MiB raw animation payload expands to roughly 85.3 MiB of base64 before metadata, leaving only a small margin under the 96 MiB project cap when stored as the primary payload. The timeline is not yet connected to the project save adapter; when it is, the serializer must account for the complete project envelope (including any raster layers stored alongside the timeline) before encoding or uploading. It must not serialize duplicate frame-zero raster pixels alongside the timeline unless the combined size is preflighted. Compressed/chunked cel storage is the next step for larger animations.
- These coordinated limits are intended for development/testing. Production deployment still depends on validating Render ingress limits, PostgreSQL row/TOAST behavior, memory headroom, and account quota behavior under concurrent saves.
