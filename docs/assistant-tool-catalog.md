# CodeLab assistant tool catalog — incremental implementation

This document records assistant-facing operations that are backed by CodeLab's existing application state and are added in independently verifiable sections. The UI remains the source of truth; tools must call the same application functions and persistence path rather than maintain a parallel project model.

## Section 1 — Project lifecycle and resumable copy branches

**Branch:** `feat/assistant-tooling-project-lifecycle`

### Existing application behavior confirmed in source

- Projects have stable IDs, names, type, timestamps, web code, design state and optional copy-branch/merge-history state.
- Project names can already be changed from the editor. The normal save path writes to the authenticated workspace and maintains a local recovery snapshot.
- The copy branch is stored on the project as `branch: { id, baseCode, code, baseMainUpdatedAt, updatedAt }`. It is not just a temporary editor buffer.
- Opening a project loads its saved branch into memory. The user can enter the branch, save it independently, compare/merge it into the main version, and undo a merge.
- Workspace persistence is revision-checked. A conflict is not supposed to silently overwrite the newer server state.

### New bridge operations

All operations below require `use_admin_session: true`, which means credentials are read from GitHub Actions secrets, never from the issue body. Each command also requires the normal bridge protocol, a unique command ID and an expiry timestamp. Mutating commands are rejected from the read-only comment mailbox.

| Action | Required arguments | Behavior / evidence returned |
|---|---|---|
| `project_list` | none | Lists project IDs, names, type, update timestamp, branch presence/ID/update time, and merge-undo availability. |
| `project_rename` | `project_id`, `name` | Renames a project, persists through CodeLab's workspace save path, checks the local durable snapshot if server sync is unavailable, and reports sync/local verification separately. |
| `project_save` | `project_id` | Opens the requested project if needed, saves the active editor state through the existing save function, and fails unless server or local persistence can be verified. |
| `branch_status` | `project_id` | Reports whether a branch exists, its ID/base timestamp/update timestamp, code lengths, and whether the editor currently displays it. |
| `branch_resume` | `project_id` | Reopens the project, activates its persisted branch, then verifies the editor's HTML/CSS/JS exactly match the saved branch contents. Does not create a new branch or copy the main code over the branch. |
| `branch_save` | `project_id` | Reopens the selected branch if needed, saves through the existing branch persistence path, and verifies saved branch data in the local snapshot if server sync is not confirmed. |

### Example command envelopes

Use a fresh, unique `command_id` and an expiry in the near future for every command. Do not reuse command IDs.

```json
{
  "protocol": "codelab-agent-bridge/v1",
  "command_id": "projectlist_20261031_01",
  "action": "project_list",
  "use_admin_session": true,
  "expires_at": "2026-10-31T23:59:00-03:00",
  "args": {}
}
```

```json
{
  "protocol": "codelab-agent-bridge/v1",
  "command_id": "branchresume_20261031_01",
  "action": "branch_resume",
  "use_admin_session": true,
  "expires_at": "2026-10-31T23:59:00-03:00",
  "args": { "project_id": "proj_REPLACE_WITH_REAL_ID" }
}
```

### Safety and durability rules

1. Never infer a project ID from its name; list projects first and use the exact returned ID.
2. Renaming must not recreate a project or replace its code/design/branch.
3. Resuming a branch must not initialize a fresh branch from the main version.
4. A local snapshot is reported as local-only, not as server-synced.
5. A failed save must not be reported as successful unless durable local state was actually checked.
6. The bridge runs in a fresh isolated browser context for each command. This is a remote automation session, not the user's current browser tab.
7. Live validation is still required after CI: verify the deployed bridge supports these actions, the admin session can access the intended workspace, and a test branch can be resumed without altering the main code. Do not use a real project for destructive tests.

### Section 1 status

- [x] Tool actions added to the bridge allowlist.
- [x] Admin-session gate and project ID/name validation added.
- [x] Rename persistence verification tightened.
- [x] Branch resume verifies editor contents against the saved branch.
- [ ] CI syntax/workflow validation.
- [ ] Live authenticated read-only inventory.
- [ ] Safe end-to-end test using a disposable project and copy branch.
- [ ] Confirm Render is serving the commit after merge/deploy.

Do not mark this section fully verified until the unchecked tests pass. Continue the next capability section only after this section's validation is complete.

\n## Section 2 — Read-only workspace, code, and design inspection\n\nNew authenticated read tools: `workspace_inspect` (workspace/editor/sync summary), `project_inspect` (project metadata, code lengths, design summary, branch metadata), `project_code_read` (main or saved-branch HTML/CSS/JS with explicit truncation metadata), and `design_read` (saved design frame and layer geometry/content). These operations do not change project state. Code reads cap each language at 20,000 characters; design layer reads cap at 200 elements and report truncation. All require `use_admin_session: true` and exact project IDs from `project_list`. CI and live checks remain separate evidence.\n
\n## Section 3 — Controlled code editing\n\nAdded `project_code_write` for HTML/CSS/JavaScript changes on an existing web project. It accepts one or more language fields, caps each supplied field at 50,000 characters, preserves omitted fields, supports `source: "main"` or `source: "branch"`, and verifies the resulting saved code against the requested values. It rejects design-only projects and branch writes without a saved branch. This is a mutating tool: use only after confirming the exact project ID and target source; live mutation testing must use a disposable project. Server sync and local snapshot evidence are reported separately.\n
\n## Section 4 — Component library and design-layer editing\n\nAdded `component_search` (read-only search over the app's actual component catalog) and `component_insert` (insert a chosen component into a web project's HTML, with an idempotency marker and persistence verification). Added `design_element_add`, `design_element_update`, and `design_element_delete` for saved design projects. Updates use a property allowlist and record design history; delete is scoped to one exact element ID. All actions require admin session and project ID; writes require a disposable project for live tests. CI contract coverage is not proof of live UI success.\n
\n## Section 5 — Project creation and duplication\n\nAdded `project_create` (uses CodeLab's existing create flow, supports web/design types, returns the generated stable project ID, and verifies the local snapshot) and `project_duplicate` (uses the existing duplication path, verifies the source code/design remained unchanged, and checks the duplicate in the local snapshot). Both require admin session. Live tests must use a disposable workspace/project; server synchronization is not inferred from local persistence alone.\n