# Penpot native RPC and WebSocket compatibility contract

Status: protocol discovery complete; CodeLab compatibility services are not yet implemented.

Pinned source: Penpot 2.19.0, commit `f66e5afa70e7d5e039b79cee758bf8e03510ad3e`.

## Browser-to-backend HTTP contract

The pinned frontend sends its standard RPC requests to:

`/api/main/methods/{method-name}`

The request contract in `vendor/penpot/frontend/src/app/main/repo.cljs` is:

- GET for methods whose names start with `get-` (and methods explicitly configured as query-only).
- POST for mutations.
- `Content-Type: application/transit+json` for Transit request bodies.
- Accept: `application/transit+json,text/event-stream,*/*`.
- Cookies are included.
- Headers include `x-external-session-id`, `x-session-id`, and where applicable `x-event-origin`.
- Some commands return Server-Sent Events, not a single JSON response.
- Upload commands use multipart form data.
- Export commands use dedicated `/api/export` and `/api/export/jobs` routes, including binary responses and job cancellation.

A generic JSON endpoint that stores one document object is not a compatible implementation of this protocol. Transit decoding/encoding, error envelopes, conditional requests, multipart uploads, SSE, command-specific validation, and the method registry must be covered.

## WebSocket contract

The frontend opens:

`/ws/notifications?session-id={frontend-tab-session-uuid}`

The pinned backend requires an authenticated profile and a real WebSocket upgrade. The client/server messages are Transit-encoded maps. Relevant message types include:

- `:subscribe-file` with `file-id`: server validates file existence and read permissions, then subscribes the connection to that file's event topic.
- `:unsubscribe-file` with `file-id`.
- `:subscribe-team` with `team-id`.
- `:keepalive`.
- `:broadcast` for profile-scoped messages.
- `:pointer-update` for active file presence.

The server emits file presence events such as `:join-file`, `:leave-file`, `:disconnect`, and `:presence`. Messages are scoped to authenticated profiles, files, teams and sessions. They must never be relayed solely because a client supplies an arbitrary file or team identifier.

## Current CodeLab gap

CodeLab currently has a Node HTTP server and a project-scoped JSON persistence route:

- `GET /api/workspace/:workspaceId/projects/:projectId/penpot-document`
- `PUT /api/workspace/:workspaceId/projects/:projectId/penpot-document`

The server does not currently expose Penpot's `/api/main/methods/*` registry, Transit codec, Penpot-compatible multipart/SSE flows, or `/ws/notifications` WebSocket endpoint. The current browser bridge is therefore a persistence proof-of-concept, not a live Penpot backend.

## Source-verified command inventory

The following RPC methods are registered by the pinned Penpot backend source and are useful for scoping the first authenticated vertical slice. This is an inventory, not yet a CodeLab allowlist implementation:

- Profile: `get-profile`, `update-profile`.
- Teams: `get-teams`, `get-team`, `get-team-members`, `get-team-info`.
- Projects: `get-projects`, `get-project`, `create-project`, `rename-project`, `delete-project`.
- Files: `get-file`, `get-file-fragment`, `get-project-files`, `get-page`, `get-file-info`, `rename-file`, `delete-file`.
- Media: `upload-file-media-object`, `create-upload-session`, `upload-chunk`, `assemble-file-media-object`.

The pinned frontend source also identifies the actual dashboard/workspace calls (rather than only the backend's available methods):

- Dashboard lifecycle: `create-file`, `duplicate-file`, `delete-file`, `rename-file`, `move-files`, `get-file-summary`, `get-projects`, `create-project`, `duplicate-project`, `rename-project`, `move-project`, `delete-project`, `update-project-pin`, `search-files`, `get-team-recent-files`, `get-team-deleted-files`, `get-builtin-templates`, `set-file-shared`.
- Workspace open: `get-file`, `get-file-libraries`, `get-file-object-thumbnails`, `rename-file`.
- Library sync: `get-library-usage`, `ignore-file-library-sync-status`, `link-file-to-library`, `unlink-file-from-library`, `update-file-library-sync-status`.
- Media lifecycle: `upload-file-media-object`, `create-file-media-object-from-url`, `clone-file-media-object`, `assemble-file-media-object`.

The backend registration was confirmed for `create-file` in `files_create.clj`, `update-file` in `files_update.clj`, snapshot operations in `files_snapshot.clj`, and the media methods in `media.clj`. This gives us a source-backed checklist for the dashboard-to-editor vertical slice. It is still not permission to expose every method: each one must be mapped to CodeLab project ownership and tested before its UI action is enabled.

The full native workspace will also require the command groups for file creation/duplication, document changes, comments, libraries, fonts, exports, plugin APIs and feature/configuration bootstrap. These must be inventoried from the pinned source before enabling the corresponding UI paths. A UI control must not be exposed as functional until its backend operation is implemented and permission-tested.

## Required implementation gates

1. Define a CodeLab-owned identity adapter that derives the active ADMIN/user, workspace and project from the existing authenticated session. Do not trust profile, team, file, workspace or project ownership values supplied by the browser.
2. Implement a tested Transit codec with Penpot's UUID, keyword, set, date/instant and map semantics. Keep JSON endpoints for CodeLab-specific operations separate.
3. Implement a command registry for the minimum complete dashboard/workspace lifecycle: profile/bootstrap, project/file listing, file creation/open, get-file, update-file, media/assets, and required feature/config queries. Add commands as source-driven groups, not permissive catch-all handlers.
4. Map Penpot files/projects/pages to CodeLab project/document ownership without creating a second user or project directory. Preserve stable native IDs and file revision/version semantics.
5. Implement bounded multipart media upload and authenticated asset serving using CodeLab-owned storage.
6. Implement SSE for commands that declare streaming responses.
7. Implement authenticated WebSocket upgrade, Transit message decoding/encoding, file/team subscription authorization, keepalive, disconnect cleanup and scoped presence fan-out. Use a bounded in-process event hub initially; introduce cross-instance coordination only if deployment topology requires it.
8. Add protocol contract tests using captured fixtures from the pinned Penpot frontend and backend. Include unauthenticated access, cross-account project/file access, stale revisions, invalid Transit payloads, oversized assets, reconnect and subscription cleanup.
9. Only mount the native Penpot workspace after the dashboard/bootstrap, file lifecycle, persistence and WebSocket flows pass together.

## Security invariants

- Existing CodeLab OAuth/session is the sole login authority.
- Never accept a client-selected Penpot profile/team identity.
- Every file read, write, media operation and WebSocket subscription must resolve through the owning CodeLab workspace/project and enforce the same permissions.
- Keep optimistic revision checks; do not let the editor silently overwrite newer state.
- Enforce per-document, per-asset, per-request and per-connection limits.
- Do not alter production Render build/start settings until the integrated build and end-to-end tests pass.
