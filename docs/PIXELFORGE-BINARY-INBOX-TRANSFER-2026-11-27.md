# PixelForge binary inbox transfer — 2026-11-27

## Purpose

This note records the exact transfer path for the editable PixelForge project **El ser devora la galaxia** and, importantly, distinguishes a documented transfer mechanism from a transfer that has actually completed. It is intended to prevent future agents from incorrectly declaring the task blocked after looking only at text-file upload actions.

## Source artifact facts

- Local package: `el-ser-devora-la-galaxia-16-frames.codelab`
- Native package type: CodeLab structured v2, editor `pixelforge`
- Internal project ID: `281043f5-295c-4a88-832e-534e3f12e0ef`
- Project name: `El ser devora la galaxia`
- Canvas: `691 × 721`
- Frames: 16
- Archive entries: 43
- Byte size: 46,067,737
- SHA-256: `66f63821593b53f85a928f11e0e7e54112b6ef3ba0dca1bd4cb0be58024f9248`
- ZIP integrity: `unzip -t` passed; the archive root contains `project.codelab-pixelforge`, `manifest.json`, and `project.json`.

The archive is the editable project package. It is not a rendered video and must not be treated as evidence of a completed export.

## Canonical transfer choice

Per `docs/inline-artifact-bridge.md` §10.1 and `docs/ANIMATION-AUTONOMOUS-WORKFLOW.md` §§129–142, choose the normal inline transfer if complete normal transfer data is available and suitable. Choose the Git inbox when the project is large or normal transfer data is missing/incomplete.

For this 46 MB native package, the documented Git inbox route is appropriate:

`projects/animation-inbox/el-ser-devora-la-galaxia/project.codelab`

The repository keeps the source copy. The workflow creates the ADMIN working copy. Do not delete the repository source as part of import or cleanup.

## Workflow behavior

The workflow is `.github/workflows/pixelforge-project-inbox.yml`. It is triggered by either:

1. A push changing a file under `projects/animation-inbox/**`; or
2. `workflow_dispatch` with optional input `project_slug=el-ser-devora-la-galaxia`.

The workflow then:

1. Checks out the repository.
2. Resolves the changed project folder or the manually supplied slug.
3. Validates the slug and confirms `project.codelab` exists.
4. Runs `unzip -tq`, extracts the archive, and checks the three required root files.
5. Validates `manifest.json` has `format: codelab` and `editor: pixelforge`.
6. Reads the internal project ID and name from `project.json`.
7. Calculates byte size, 1 MiB chunk count, and SHA-256.
8. Creates the bridge manifest using `POST /api/agent/bridge/artifacts`, with:
   - `artifact_kind: codelab_zip_upload`
   - `editor_id: pixelforge`
   - `target_workspace_id: ws_local_admin`
   - `source_project_id` equal to the internal project ID
   - the calculated size, chunk count and SHA-256.
9. Uploads each 1 MiB binary chunk with `PUT /api/agent/bridge/artifacts/:artifactId/:index`.
10. Commits the artifact using `POST /api/agent/bridge/artifacts/:artifactId/commit`.
11. Requires the commit response to say `queued`; this means accepted for processing, not imported.
12. The CodeLab worker imports the package. The agent must wait for terminal `succeeded`, then read the project back from PixelForge ADMIN and verify the project ID, frame count and editable data.

The workflow obtains `CODELAB_AGENT_BRIDGE_CONTROL_SECRET` from GitHub Actions secrets. Never put this secret in a command, commit, issue comment, log, documentation, Headless process or user message.

## GitHub binary upload mechanism

A key correction to the earlier diagnosis: the connected GitHub toolset does expose Git Data operations, including `create_blob`, `create_tree`, `create_commit` and `update_ref`. The Git Data blob operation accepts `encoding: base64`, so it is not limited to UTF-8 text files.

The repository publication sequence, when the binary bytes are available to the GitHub tool call, is:

1. Read the current `main` ref and its commit/tree SHA.
2. Base64-encode the exact archive bytes without changing the archive.
3. Create a Git blob with `create_blob(repository_full_name, content=<base64>, encoding="base64")`.
4. Create a tree based on the current tree, adding:
   - path: `projects/animation-inbox/el-ser-devora-la-galaxia/project.codelab`
   - mode: `100644`
   - type: `blob`
   - sha: the blob SHA returned by step 3.
5. Create a commit with the new tree and current main commit as its parent.
6. Advance `refs/heads/main` using `update_ref` with the expected old SHA (force must remain false).
7. Confirm the push-triggered `Import PixelForge project inbox` workflow run exists and inspect its job steps/logs.
8. Confirm the import command reaches `succeeded` and the project is visible in `ws_local_admin`.

Do not use a GitHub issue comment as a substitute for the binary file, do not commit a text placeholder under the package filename, and do not write artifact chunks directly to Neon. The bridge/workflow owns authentication, staging, validation, chunk upload and worker enqueueing.

## Exact acceptance criteria

The task is not complete merely because a Git commit, workflow run, manifest, HTTP 202, `queued` command, local ZIP, SHA-256 or package validation exists.

Completion requires all of the following:

- The workflow imported the exact SHA-256 listed above.
- The import command reached terminal `succeeded`.
- PixelForge ADMIN lists project ID `281043f5-295c-4a88-832e-534e3f12e0ef` in workspace `ws_local_admin`.
- Reading the project back confirms 16 frames and the expected canvas dimensions.
- The editable frame/cel data and Illustration authoring metadata survived import.
- The project is opened/inspected in the real PixelForge UI before any A/B video export is started.

## Session status at time of writing

The local package is present and its ZIP integrity and SHA-256 were checked. The workflow and Git Data upload actions were inspected. **The binary has not yet been committed to the inbox in this session, and no new ADMIN import has been confirmed.** This note deliberately records that status rather than claiming a successful transfer without evidence.

## Documentation to consult next

- `AGENTS.md` — task flow, identity, Headless isolation and persistence rules.
- `docs/ANIMATION-AUTONOMOUS-WORKFLOW.md` — creative workflow, transfer and read-back acceptance.
- `docs/inline-artifact-bridge.md` — inline bridge API and §10 Git inbox.
- `docs/ADMIN-AUTH-AND-BRIDGE-RECOVERY.md` — ADMIN identity and bridge recovery.
- `projects/animation-inbox/README.md` — inbox package conventions.


## 2026-11-27 recovery: stale Agent Space target URL

### Symptom

The documented CodeLab Agent Space comment mailbox command `connections_status` failed at `admin_authentication` with a 20-second timeout on:

`POST https://codelab-pbw9.onrender.com/api/auth/login`

The first diagnostic was not an inline-artifact token rejection. It was the separate browser/UI bridge trying to log in to an obsolete Render hostname. Do not conflate this failure with the inline artifact endpoint's `x-codelab-agent-bridge-token` authentication.

### Evidence and root cause

The connected Render service metadata for service `srv-dc1tnvmq1p3s73b6sok0` identifies:

- Service name: `codelab`
- Current slug: `codelab-qedi`
- Current URL: `https://codelab-qedi.onrender.com`
- State: `not_suspended`
- Last updated: `2026-11-27T04:34:11Z`

The repository's Agent Space browser bridge still hard-coded `https://codelab-pbw9.onrender.com` in both its script origin allowlist and the workflow's `TARGET_URL`. Its documentation repeated the stale URL.

The PixelForge inbox importer already targeted `https://codelab-qedi.onrender.com`; that confirmed the active application host used by the documented transfer workflow.

### Repair applied

Updated these three files on `main`:

1. `.github/scripts/codelab-bridge.mjs`
   - Changed the default browser bridge URL to `https://codelab-qedi.onrender.com/`.
   - Changed the strict origin allowlist to `https://codelab-qedi.onrender.com`.
2. `.github/workflows/codelab-command-bridge.yml`
   - Changed `TARGET_URL` to `https://codelab-qedi.onrender.com/`.
3. `docs/agent-space-github-bridge.md`
   - Updated the documented current target URL.

Commits:
- Script: `0f5bf489176c23ef69d0af088950b39a78a13086`
- Workflow: `c2c26a6b07b5a4281468d2cb7e4f26f7e7842b50`
- Documentation: `7f77c3de15002b4228cdd8479b8d92532ffaae59`

No Render environment variables, GitHub secrets, Neon credentials, passwords, cookies or tokens were read or changed.

### Verification after repair

Reused the existing dedicated CodeLab Bridge issue mailbox and posted a fresh read-only `connections_status` command with a valid future expiry. The first command attempt had expired before the runner reached it; it was not counted as a successful check. The fresh command ran against the corrected hostname and returned:

- Command ID: `connections-20261127-qedi-check`
- GitHub Actions run: [45942129812](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45942129812)
- Workflow result: `completed / success`
- CodeLab page: `https://codelab-qedi.onrender.com/`
- App version: `2.7.0`
- API health: HTTP 200, `ok: true`
- Authenticated browser session: `true`
- Account context: `ADMIN`, local provider, role `admin`
- Destination workspace: `ws_local_admin`
- `identityVerified: true`, `workspaceVerified: true`

The returned connection diagnostics did not expose any secret. The result proves the Agent Space browser bridge now reaches the active CodeLab service and can authenticate the configured ADMIN session.

### Important boundary: what this repair did not do

This repaired the Agent Space browser/UI command bridge. It did **not** transfer the PixelForge package and did **not** authenticate a request to `/api/agent/bridge/artifacts`. The UI bridge's allowlist does not include a binary artifact upload action.

The native package still requires the separate documented transfer:

1. Agent-side authorized inline transport action/proxy, or the documented inbox workflow when its binary source is available in the repository.
2. Manifest → 1 MiB chunks → commit, using the existing server-side secret without revealing it.
3. Worker terminal `succeeded`.
4. Project read-back from `ws_local_admin`.

The normal CodeLab UI bridge being healthy is not evidence that the inline artifact HTTP token route was exercised. Keep these capabilities and acceptance criteria separate.

### Canonical compact package verified

The 46,067,737-byte archive and the 9,103,655-byte compressed archive contain the same 43 paths and every corresponding entry has identical bytes. The compressed archive is therefore a byte-equivalent ZIP-content package with a different compression level:

- File: `el-ser-devora-la-galaxia-compressed.codelab`
- Size: 9,103,655 bytes
- SHA-256: `d365a295afc0b9ccb617839277c2a2469f3d0aee8d334352dace52078f8e3325`
- ZIP integrity: passed
- Project ID: `281043f5-295c-4a88-832e-534e3f12e0ef`
- Project name: `El ser devora la galaxia`
- Canvas: 691 × 721
- Animation manifest: 16 frame paths, 12 FPS
- Entries: 43

A read-only Neon check after the repair still found no project, import command or staged artifact for this project ID/name. Therefore the import remains pending; no success is claimed until the actual inline transfer and read-back are complete.


## Exact remaining transfer boundary in this ChatGPT session

After repairing the stale UI bridge target, the documented ADMIN browser mailbox was successfully exercised. The remaining issue is specifically binary transport, not account identity:

- The GitHub connector exposes repository reads and Git Data blob/tree/commit writes. Its `create_blob` contract accepts a Base64 **string**, not a local filesystem path or file handle.
- The GitHub `fetch` action is GET-only and explicitly does not support binary downloads/uploads.
- The Agent Space comment mailbox supports bounded browser/UI actions, but its allowlist does not contain an artifact manifest/chunk/commit upload action or a file-input upload action.
- The connected Neon MCP actions expose SQL and metadata operations, but there is no action in this session that invokes the CodeLab inline HTTP routes with a local binary body. Direct SQL inserts into `codelab_agent_artifacts` or `codelab_agent_artifact_chunks` are expressly prohibited by the project policy.
- The connected Render actions expose service/deploy/workflow metadata and configuration, but this session has no Render Sandbox create/exec/file-transfer action. The local container also has no outbound DNS/network route to the CodeLab host, and its environment does not contain the assistant-side `DATABASE_URL` or a Render API key.
- The documented assistant-side `createAssistantHeadlessClient().importPixelForgeZip(bytes)` requires a `DATABASE_URL` in the assistant runtime secret store and uses `stageNativeArtifact`. That runtime secret store/client action is not exposed through the current tool surface. Do not call `get_connection_string` merely to reveal a privileged password into the model context; do not give it to Headless.

Therefore the following are verified separately:

1. **ADMIN/UI bridge:** repaired and verified against the active Render host; run `45942129812` succeeded with exact ADMIN identity and `ws_local_admin`.
2. **Inline artifact transport:** not yet invoked for this animation. No manifest, chunks, commit, import command or staged artifact for this package exists in Neon.
3. **Final import:** not yet persisted or read back in PixelForge ADMIN.

A future agent must first discover an authorized binary-capable action/proxy or the assistant runtime's documented native-client capability. Once available, use the normal inline route for this complete 9.1 MB package (within the 256 MiB limit), keeping the bridge secret on the service side. Do not choose the inbox merely to hide this missing capability, do not ask the user for credentials, and do not bypass the bridge with direct SQL writes.
