# PixelForge + CodeLab account integration

## Contract

CodeLab remains the source of human identity and authentication. PixelForge does not create a second account, request credentials, or maintain a parallel login. The PixelForge client uses CodeLab's same-origin, HttpOnly session when hosted under CodeLab; when run standalone or signed out, it continues to use IndexedDB.

PixelForge's raster documents are stored under a dedicated `pixelforge-projects/<CodeLab workspace ID>/` data namespace. They do not enter the existing CodeLab web/design project schema. This keeps editor engines and document formats independently maintainable while sharing account ownership.

## API

- `GET /api/pixelforge/session`: returns the authenticated CodeLab user and deterministic workspace ID; unauthenticated requests receive 401.
- `GET /api/pixelforge/projects`: lists metadata only for the current CodeLab account.
- `GET /api/pixelforge/projects/:id`: reads a single account-scoped raster document.
- `PUT /api/pixelforge/projects/:id`: atomically saves a document. Existing documents require the current `baseRevision`; stale writes receive 409.
- Canvas dimensions are individually capped at 8192 and total area at 16,777,216 pixels. Serialized project payloads have a 20 MiB application limit, with the global request-body limit remaining authoritative.

## Security and recovery

- Every request derives ownership from the existing CodeLab session; clients cannot choose another account's workspace.
- The storage directory is outside the public asset root, with owner-only directory/file permissions and atomic temp-file rename.
- Project IDs are path-validated, document metadata is checked, and stale/concurrent saves cannot silently overwrite a newer revision.
- PixelForge keeps a local IndexedDB copy before cloud synchronization, so cloud failures do not erase the local working copy. The UI reports whether the save reached CodeLab or remained local.
- Do not expose the cloud API on a separate origin without adding an explicit short-lived SSO exchange. The current client contract intentionally relies on same-origin cookies.

## Current boundary

The account/session and cloud persistence bridge is implemented in these draft PRs. The remaining integration step is to package/serve the separately maintained PixelForge UI under CodeLab's same origin and add a CodeLab navigation entry. Until that is completed, the cloud API is not by itself a user-facing launcher.
