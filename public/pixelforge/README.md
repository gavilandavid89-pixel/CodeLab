# PixelForge native studio module

PixelForge is a first-party CodeLab studio. Its editor engine and UI stay encapsulated in `public/pixelforge/`, while CodeLab owns the account, session, platform navigation, and durable project storage.

## Native integration contract

- **Identity:** use `public/studio-core.js` for the active CodeLab session and same-origin API requests. Do not introduce a separate PixelForge login or account model.
- **Entry:** open the studio directly from CodeLab's Design area at `/pixelforge/index.html`; there is no separate PixelForge home screen.
- **Storage:** use the authenticated `/api/pixelforge/projects` API. PostgreSQL stores the project document and its raster-layer data in the dedicated `codelab_pixelforge_projects` table, scoped by the CodeLab workspace/account.
- **Isolation:** keep PixelForge-specific editor, raster document schema, styles, and assets inside this module. Keep platform-wide authentication and shared request semantics in CodeLab's shared runtime.
- **Concurrency:** every save carries a server-issued `serverRevision` token. Local edit counters are not concurrency tokens; divergent sessions must conflict even if their local edit counters happen to match.
- **Durability:** production must fail clearly when the database is unavailable; it must not silently fall back to ephemeral or sidecar storage. File-backed persistence is only a development/E2E fallback when no database is configured.
- **Safety:** validate document shape, pixel buffers, dimensions, layer references, encoded size, per-account quota, and project count on the server. Enforce account isolation on every operation and never evict existing work to make room.
- **Provider credentials:** reuse CodeLab's existing AI-settings contract instead of creating a second PixelForge credential store. Never attach provider keys to artwork documents or persist them in PixelForge project records; any settings persistence remains owned by CodeLab's shared settings implementation.
- **Recent projects:** opening a saved project updates its persistent recency timestamp, so project lists reflect actual use.

## Evolving the studio

PixelForge is maintained directly in this CodeLab repository. No upstream repository sync step is part of the architecture. Make engine/UI changes inside this module and update the CodeLab-specific persistence adapter and integration tests when their contracts change. Avoid spreading raster-editor concerns into unrelated CodeLab modules.

## Animation roadmap

- The isolated `src/animation.mjs` module provides a validated, UI-independent timeline model with independent per-layer RGBA cels, frame duplication/reordering/deletion, precise FPS and frame durations, playback time mapping, onion-skin neighbor metadata, and versioned animation JSON.
- The animation model synchronizes add/remove/reorder operations for raster layers and enforces a bounded in-memory frame budget before allocating or decoding cel buffers.
- The current raster editor remains the drawing surface. Animation UI, frame switching into the existing `RasterDocument`, playback rendering, project persistence, and animation export are intentionally separate integration steps; do not replace the editor or bypass its existing tools/history.
- Before animation data is attached to account-backed projects, extend and test the server-side project validator and storage-size policy. The current project JSON limit is smaller than the animation model's raw memory ceiling, so do not assume every valid in-memory animation can already be saved to PostgreSQL.

## Verification expectations

After changes, run the CodeLab validation workflow and Agent Space Browser Runner. Do not merge or deploy until authentication, account isolation, PostgreSQL persistence, save/load/delete, reload recovery, recent-project ordering, malformed-project rejection, quota enforcement, and account-scoped browser preferences pass.


### High-resolution capacity (testing profile)

- PixelForge animation canvas bounds are now 4096 × 4096 pixels (16,777,216 pixels maximum) and the in-memory timeline budget is 256 MiB. These are hard safety ceilings, not a promise that every combination of resolution, layers, and frames fits; the model rejects combinations that exceed the aggregate budget before allocating.
- The PixelForge API accepts request bodies up to 80 MiB, stored project JSON up to 64 MiB, and 1 GiB total project storage per account. These limits are scoped to PixelForge and do not raise unrelated CodeLab API limits.
- The current timeline JSON uses base64 cel payloads, so the 64 MiB persisted-project ceiling can be reached before the 256 MiB raw in-memory ceiling. A compressed/chunked cel storage format is still required to persist larger animations efficiently; do not claim that the entire memory budget is saveable yet.
- These expanded limits are intended for development/testing. Production deployment still depends on validating Render ingress limits, PostgreSQL row/TOAST behavior, memory headroom, and account quota behavior under concurrent saves.
