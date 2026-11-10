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

## CodeLab identity primitives verified in the host server

The existing server already provides the primitives the adapter must reuse:

- `getSessionUser(req)` resolves the HttpOnly CodeLab session cookie to the signed-in account.
- `userWorkspaceId(user)` derives the deterministic workspace ID from the authenticated provider and account ID.
- `isAuthorized(req, workspaceId)` accepts either the signed workspace HMAC token or the owning signed-in session.
- `enforceSessionWorkspaceOwner(workspaceId, state, user)` binds and validates the stored workspace owner.

The Penpot adapter must call these existing functions and then resolve the requested project from the authorized workspace state. A Penpot `profile-id`, `team-id`, `file-id`, `workspace-id`, or owner value supplied in Transit parameters is only a lookup hint; it is never authorization. The logged-in CodeLab account (including ADMIN) remains the identity authority. Anonymous Penpot sessions and Penpot password/OAuth login flows must not be enabled as a second account system.

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

## Additional upstream transport findings (verified against the pinned source)

### Transit wire types

The authoritative shared codec is `vendor/penpot/common/src/app/common/transit.cljc`, namespace `app.common.transit`. It uses `cognitect.transit` with JSON as the default Transit wire type and registers Penpot-specific handlers in addition to Transit built-ins.

Penpot-specific handler IDs confirmed in that source:

- `n`: integer parsing in ClojureScript.
- `u`: UUID parsing in ClojureScript.
- `ordered-map`: preserves ordered-map semantics.
- `ordered-set`: preserves ordered-set semantics.
- `m`: JavaScript Date / JVM Instant, encoded as epoch milliseconds.
- `uri`: Penpot URI values.
- `penpot/pointer`: pointer values with an ID and metadata.

The codec also uses the Transit library's built-in handling for keywords, symbols, sets, and ordinary maps. A JSON.parse/JSON.stringify shim would lose typed values and is not acceptable. CodeLab now pins `transit-js` 0.8.874 in `package.json` and implements a bounded codec in `penpot-transit.js`. Its initial host/codec suite verifies keyword maps, UUIDs, dates, sets, Penpot ordered collections, URI/pointer tags, malformed payload rejection and byte limits (12 tests passed in GitHub Actions run 42759363063). This codec is a tested transport component; the `/api/main/methods/*` dispatcher and native command handlers are not yet connected to it.

### RPC dispatch and authorization semantics

The authoritative backend dispatcher is `vendor/penpot/backend/src/app/rpc.clj`:

- The route parameter `method-name` is looked up in a resolved method map; unknown names dispatch to a not-found handler.
- The method map is built from explicitly scanned RPC namespaces, with method metadata processed into wrappers. It is not an open-ended dynamic function call.
- GET/HEAD is rejected unless the method name starts with `get-`.
- Authentication, required auth type, token permissions, parameter validation, response transformations, and completion hooks are applied by the backend wrappers.
- The main route is `/api/main/methods/:method-name`; it applies CORS, client-header checks, session authorization, and access-token authorization before dispatch.
- The backend also retains `/rpc/command/:method-name` as a compatibility route.

For CodeLab, the safe equivalent is an explicit registry whose entries declare method, parameter schema, project-resolution rule, required permission, response type, and whether the operation streams or uploads. Registry misses must return a Penpot-compatible not-found error; they must never fall through to arbitrary server functions.

### Source-confirmed command families beyond dashboard/workspace

The frontend call sites below were scanned directly for `rp/cmd!` invocations:

- Profile: `get-profile`, `update-profile`, `update-profile-props`, `update-profile-notifications`, `update-profile-password`, `update-profile-photo`, `delete-profile-photo`, `delete-profile`, `recover-profile`, `request-profile-recovery`, `request-email-change`, `cancel-email-change`, `get-access-tokens`, `create-access-token`, `delete-access-token`, `get-subscription-usage`.
- Teams: `get-teams`, `get-team`, `create-team`, `update-team`, `delete-team`, `leave-team`, `get-team-members`, `delete-team-member`, `update-team-member-role`, `get-team-invitations`, `create-team-invitations`, `create-team-with-invitations`, `delete-team-invitation`, `update-team-invitation-role`, `get-team-invitation-token`, `get-team-shared-files`, `get-team-stats`, `all-organization-members-in-team`, `check-organization-members`, `check-nitrate-sso`, and webhook CRUD methods.
- Project: `get-project`, `get-project-files`.
- Fonts: `get-font-variants`, `create-font-variant`, `update-font`, `delete-font`, `delete-font-variant`.
- Comments: `get-comments`, `get-comment-thread`, `get-comment-threads`, `get-unread-comment-threads`, `get-profiles-for-file-comments`, `create-comment`, `update-comment`, `delete-comment`, `create-comment-thread`, `update-comment-thread`, `update-comment-thread-frame`, `update-comment-thread-status`, `mark-all-threads-as-read`, and `delete-comment-thread`.
- Upload sessions: `create-upload-session`, `upload-chunk`.
- Persistence: `update-file` is invoked from the workspace persistence layer.

These are observed frontend call sites, not a blanket authorization grant. Several profile/team operations (password, email, token, team membership, webhooks) are not appropriate to expose as part of the first CodeLab editor slice. The first allowlist should stay limited to the CodeLab-owned project/file lifecycle, document persistence, required assets/fonts, and the minimum bootstrap queries. Collaboration/comments and administrative account operations remain gated until their identity and permission mappings are implemented.

### Verified upstream source locations

- Transit types and handlers: `vendor/penpot/common/src/app/common/transit.cljc`.
- RPC dispatch, method lookup, GET restriction, auth wrappers and routes: `vendor/penpot/backend/src/app/rpc.clj`.
- Dashboard command call sites: `vendor/penpot/frontend/src/app/main/data/dashboard.cljs`.
- Workspace and persistence call sites: `vendor/penpot/frontend/src/app/main/data/workspace.cljs`, `vendor/penpot/frontend/src/app/main/data/persistence.cljs`.
- Profile/team/font/comment/upload call sites: `vendor/penpot/frontend/src/app/main/data/profile.cljs`, `team.cljs`, `fonts.cljs`, `comments.cljs`, and `uploads.cljs`.
- WebSocket server: `vendor/penpot/backend/src/app/http/websocket.clj`; frontend client: `vendor/penpot/frontend/src/app/main/data/websocket.cljs`.

This discovery is now detailed enough to implement a command-by-command adapter without guessing the upstream transport. The adapter itself, Transit codec, WebSocket server, and command handlers remain implementation work; none are marked complete by this source audit.

## First vertical-slice method map (backend handlers inspected)

The following mapping goes one level deeper than frontend call-site discovery: the actual upstream `sv/defmethod` declarations and handler metadata were inspected in the pinned backend.

| Penpot method | Backend source | Verified contract / guardrail |
|---|---|---|
| `get-projects` | `backend/src/app/rpc/commands/projects.clj` | Requires `team-id`; calls team read-permission check. |
| `get-project` | `backend/src/app/rpc/commands/projects.clj` | `id-type :project`; checks project read permissions. |
| `create-project` | `backend/src/app/rpc/commands/projects.clj` | Requires `team-id` and name; checks team edition permissions; server generates the ID in 2.19.0. |
| `get-project-files` | `backend/src/app/rpc/commands/files.clj` | Requires project context; returns files for that project. |
| `create-file` | `backend/src/app/rpc/commands/files_create.clj` | Requires `project-id`; checks project edition permissions and team feature/quote limits; server generates the file ID in 2.19.0. |
| `get-file` | `backend/src/app/rpc/commands/files.clj` | `id-type :file`; checks file read permissions and client/file feature compatibility; accepts file ID and project context. |
| `update-file` | `backend/src/app/rpc/commands/files_update.clj` | `id-type :file`; checks file edition permissions; applies ordered document changes; validates `vern` and `revn` and returns explicit conflict errors. |
| `rename-file` / `delete-file` | `backend/src/app/rpc/commands/files.clj` | File-scoped operations; must resolve the file through the owning CodeLab project before dispatch. |
| `upload-file-media-object` | `backend/src/app/rpc/commands/media.clj` | Requires `file-id` and multipart `content`; validates media type, size and upload path; checks file edition permissions. |
| `create-upload-session` / `upload-chunk` / `assemble-file-media-object` | `backend/src/app/rpc/commands/media.clj` | Chunked uploads are session/profile scoped, quota bounded, and use multipart content; they are not plain JSON mutations. |
| `get-font-variants` | `backend/src/app/rpc/commands/fonts.clj` | Supports team/file/project context; font upload and management have separate permission and processing rules. |

### Consequences for the CodeLab adapter

1. A CodeLab project must resolve to one stable Penpot file identity for the editor document; Penpot pages remain pages inside that file. This is the shape that supports multiple pages without creating one CodeLab project per screen.
2. Penpot 2.19.0 explicitly rejects client-supplied IDs for `create-project` and `create-file`. CodeLab must create and persist its mapping on the server, not force a browser-generated ID into those commands.
3. Penpot file updates are change operations, not whole-document JSON replacement. The adapter must preserve change ordering and version fields (`revn` and `vern`) and translate conflicts into a visible save conflict; the current host bridge's workspace revision check remains an outer CodeLab guard, not a replacement for Penpot's native file version semantics.
4. Media upload requires real multipart parsing, media validation, ownership checks and bounded storage. It cannot be enabled by forwarding a JSON/base64 field to the existing document endpoint.
5. The first command allowlist should therefore be limited to the project/file bootstrap and editor persistence methods above, plus only the profile/team bootstrap queries needed to establish the virtual Penpot context. Team administration, profile security changes, comments, plugin APIs and collaboration remain disabled until separately mapped.

This method map is source-derived from the pinned 2.19.0 backend. It is an implementation specification, not a claim that these handlers have already been ported to CodeLab.

## CodeLab WebSocket adapter status

A first authenticated notification transport is now implemented in `penpot-websocket.js` and mounted on the existing CodeLab HTTP server at `/ws/notifications`.

- The upgrade requires the same-origin browser request, a valid Penpot `session-id` UUID, and an authenticated CodeLab session cookie.
- The connection's profile identity is derived from the CodeLab account. Team and file subscriptions are resolved through `penpot-identity.js` against that account's workspace and projects; a supplied UUID is never accepted as proof of ownership.
- Implemented message paths: `subscribe-team` (workspace validation), `subscribe-file`, `unsubscribe-file`, `keepalive`, profile-scoped `broadcast`, and file-scoped `pointer-update`.
- File presence fan-out emits `join-file`, `leave-file`, `disconnect`, and `presence` events. Message payloads use the Transit codec.
- The server enforces same-origin checks, a 256 KiB message ceiling, a per-connection message rate limit, and a maximum of eight active connections per profile by default.

The current event hub is in-process. It does not yet relay notifications across multiple CodeLab server instances, and team subscriptions are currently authorization-validated but do not yet receive project/team mutation fan-out. Native document changes are also not yet being published through this socket. Do not enable collaborative editing or claim multi-instance presence until those paths are implemented and tested.

The adapter and identity modules are covered by the Penpot test workflow. On 2026-11-10, the server syntax check and all 24 host, Transit, identity and WebSocket tests passed in Actions run 42759768697. The main CodeLab validation workflow still has an unrelated existing PixelForge animation test failure; the failing test and editor file have identical blob SHAs on `main` and this branch, so it is not introduced by the Penpot changes.

## Exact frontend integration hooks for the next RPC phase

The pinned frontend source shows that command transport and persistence have two narrow integration points. These are preferable to patching dozens of individual editor tools:

1. **RPC transport choke point — `frontend/src/app/main/repo.cljs`, `send!`.** Every normal `rp/cmd!` call is converted here into `GET` for `get-*` methods or `POST` for mutations, sent to `/api/main/methods/{method-name}`, with cookies included and headers `x-external-session-id`, `x-session-id`, and `x-event-origin`. The same function handles Transit request encoding, Transit response decoding, raw Transit responses, blob responses and SSE streams. A CodeLab adapter must preserve these branches rather than replacing them with generic JSON fetches.
2. **Save queue choke point — `frontend/src/app/main/data/persistence.cljs`, `send-queued-commit`.** The current request carries `id`, `session-id`, `revn`, `vern`, `changes` and `features`; `update-file` returns a revision-bearing result. The backend rejects `vern` conflicts and future `revn` values, then processes ordered change operations. This is the correct place to add a CodeLab full-document snapshot bridge if we choose not to port Penpot's full change processor to Node.
3. **File load/resolve — `frontend/src/app/main/data/workspace.cljs`, `resolve-file`.** The response's `data` is passed through the pointer-map resolver before being installed into the editor. The CodeLab file response must therefore preserve Penpot's native `data` structure, feature flags, revisions and page identifiers.
4. **WebSocket lifecycle — `frontend/src/app/main/data/websocket.cljs`.** The client opens `/ws/notifications?session-id={uuid}` and sends Transit messages through the same session. The CodeLab endpoint is now mounted; the remaining collaboration work is to publish actual document-change events and provide cross-instance fan-out.

The recommended next implementation is to connect the frontend's RPC choke point to a strict server-side allowlist, then route `get-file` and `update-file` through the existing CodeLab host persistence boundary. Do not enable the Penpot workbench until bootstrap, native file shape, save/reopen and conflict behavior pass end-to-end tests.
