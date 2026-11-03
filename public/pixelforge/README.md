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

## Verification expectations

After changes, run the CodeLab validation workflow and Agent Space Browser Runner. Do not merge or deploy until authentication, account isolation, PostgreSQL persistence, save/load/delete, reload recovery, recent-project ordering, malformed-project rejection, quota enforcement, and account-scoped browser preferences pass.
