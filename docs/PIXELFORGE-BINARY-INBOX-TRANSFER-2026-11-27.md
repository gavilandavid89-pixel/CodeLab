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
