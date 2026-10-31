# CodeLab capability coverage matrix

This is a source-backed inventory for turning the web app's existing capabilities into assistant-callable operations. It separates UI presence, bridge exposure, and verified behavior: a visible control is not proof that it works, and a registered bridge action is not proof of end-to-end coverage.

**Reviewed baseline:** `main` after PR #76; app version 2.6.6.  
**Live smoke-test evidence:** PR #76 deployment served HTTP 200/API health OK; project list returned the existing workspace project; a disposable web project was created, its HTML written and compared exactly against the requested content, then the disposable project was deleted and deletion verified. See the linked run issues in the project activity.  
**Scope:** CodeLab only. Agent Space automation runs in a separate Playwright context and does not control the user's currently open browser tab.

## Coverage status meanings

- **Exposed**: an allowlisted bridge action and handler exist.
- **Contract-tested**: the repository has a test assertion for the action/guard/contract.
- **Live-smoke-tested**: a real deployed request returned evidence of the requested result.
- **Gap**: UI behavior exists but is not yet directly exposed, or lacks enough evidence.
- **Not appropriate as a direct tool**: secrets, authentication challenges, or UI-only gestures should use guarded flows rather than accepting credentials or arbitrary script from an issue.

## Screen and feature inventory

| Screen / area | UI options and behavior found in source | Current direct assistant coverage | Gaps / next verification |
|---|---|---|---|
| Welcome dashboard / projects | Search/filter projects; create; open; rename; duplicate; delete; project count; workspace and sync status; auth/profile status; account actions; AI settings; design tools; component library | `project_list`, `project_create`, `project_rename`, `project_duplicate`, `project_delete`, `workspace_inspect`, `project_inspect` | Search/filter is UI-only; verify duplicate/rename/delete semantics and workspace isolation; don't expose account credentials to bridge commands. |
| Web editor | HTML/CSS/JS tabs; Monaco/fallback; edit; autosave; preview refresh; save; copy source; download project; console; AI copilot; mobile code/preview tabs | `project_code_read`, `project_code_write`, `project_save`, `project_export_html`, `ai_generate`, `preview_diagnostics`, `preview_interact`, `preview_editor_smoke_test`, `read_page`, `list_controls`, `read_element`, `click`, `fill`, `select`, `sequence` | Direct project download/ZIP is not represented as a dedicated export operation; verify preview interaction and browser diagnostics against deployed editor. AI generation is gated because it may consume provider quota. |
| Copy branch / merge lifecycle | Create branch copy; edit/save copy independently; branch status; resume existing branch; merge to main; three-way merge/conflict protection; undo last merge | `branch_status`, `branch_create`, `branch_resume`, `branch_save`, `branch_merge`, `branch_undo_merge`, `project_save` | Live-tested on a disposable web project: create → write branch-only HTML → resume and compare exact editor contents → merge with backup → undo and verify restored code/history → delete disposable project. Conflict path still needs a dedicated test. |
| Visual design studio | Add heading/text/button/rectangle/ellipse/image; select; update properties; delete; duplicate/move/order layers; undo/redo; grid/snap; grid size; zoom/fit; background; desktop/tablet/mobile frames; Auto Layout direction/gap/padding; prototype target; flow graph | `design_read`, `design_element_add`, `design_element_update`, `design_element_delete`, `design_history`, `design_flow_read`, `design_flow_connect`, `design_flow_disconnect` | Duplicate/reorder/alignment/distribution/layout configuration/zoom/frame/prototype-target controls are not all directly exposed; add typed operations where the underlying functions support them and test persistence. |
| Design templates and export/import | Landing/dashboard/portfolio templates; SVG/HTML/JSON export; design project JSON import; capture design for AI; convert design to web project | `design_template_apply`, `design_export`, `project_convert_design_to_web` | JSON import and AI capture are not separate direct actions; export is bounded and reports truncation. Verify imported JSON validation and source-preserving conversion. |
| Design tools | Palette/system colors; save/reset design system; foreground/background contrast; typography/spacing/radius tokens; copy CSS; apply tokens; export CSS/JSON; import design-system JSON; accessibility audit and export results | `design_tokens_generate`, `accessibility_audit` | Persist/apply/reset palette, contrast query, token import/export, and audit export are not all dedicated actions. Add safe structured tools only after mapping exact app APIs. |
| Component library | Search; category filter; select component; preview and inspect HTML; copy/download component; insert into current project | `component_search`, `component_insert` | Dedicated read/preview/export operations may be useful; insertion needs a disposable project live test and exact persisted-code verification. |
| AI settings and copilot | Auto/API/local modes; base URL/model/API key; status/ping; quick prompts; generated edits | `ai_settings_inspect`, `ai_ping`, `ai_generate` | Never return key values. Mode changes/provider configuration are not directly exposed; provider calls require explicit approval and quota-aware failure handling. |
| Authentication / accounts | Native login; GitHub/Google OAuth; logout; password change; admin account list/create; workspace isolation; local import/recovery | Browser inspection only; `connections_status` and dashboard status | Do not accept passwords or OAuth secrets through GitHub issue bodies. Account administration needs a separate, explicitly authorized and secret-safe design if automated. |
| Console and sync diagnostics | Console log count/output; clear logs; sync state; server/local snapshot status; reconnect; sync conflict modal with take-server/keep-local decisions; network diagnostics | `status`, `workspace_inspect`, `preview_diagnostics`, `connections_status` | Dedicated sync-conflict resolution and log retrieval/export operations are not all exposed; verify the evidence distinguishes server sync from local-only durability. |
| Agent Space / browser bridge | Read page, inspect controls/elements, click/fill/select/sequence, connection status, AI ping, preview diagnostics/interactions, editor smoke test | Existing browser bridge actions | Runs in a fresh remote browser session, not the user's tab. Add per-action assertions, screenshot/console/network evidence, and avoid arbitrary code execution. |
| Responsive / mobile navigation | Mobile bottom bar; code/preview switching; dropdown actions; landscape and zoom reflow | Browser interaction tools | Add targeted viewport/orientation tests; not every responsive state is an independent business action. |

## Current registered bridge actions

The allowlist contains 44 actions:

- **Browser/diagnostics:** `status`, `read_page`, `list_controls`, `connections_status`, `ai_ping`, `preview_diagnostics`, `preview_interact`, `preview_editor_smoke_test`, `click`, `read_element`, `fill`, `select`, `sequence`.
- **Projects, workspace, code, branches:** `project_list`, `project_rename`, `project_save`, `branch_status`, `branch_resume`, `branch_save`, `workspace_inspect`, `project_inspect`, `project_code_read`, `project_code_write`, `project_create`, `project_duplicate`, `project_delete`, `project_export_html`, `project_convert_design_to_web`.
- **Design, components, AI:** `design_read`, `design_element_add`, `design_element_update`, `design_element_delete`, `design_template_apply`, `design_history`, `design_export`, `design_flow_read`, `design_flow_connect`, `design_flow_disconnect`, `design_tokens_generate`, `accessibility_audit`, `component_search`, `component_insert`, `ai_settings_inspect`, `ai_generate`.

## Verification ledger

| Capability | Contract / CI | Live evidence | State |
|---|---|---|---|
| Deployed status and API health | CI passed on merged change | HTTP 200, `ok: true`, version 2.6.6 | Verified |
| List existing projects | Contract coverage | Returned exact project ID/name | Live-tested read |
| Create disposable project | Contract coverage | Created, snapshot verified, server sync reported “Sincronizado” | Verified |
| Write HTML to disposable project | Contract coverage | Exact requested HTML persisted; `saved: true` | Verified |
| Delete disposable project | Approval guard | Deletion and local snapshot verified | Verified |
| Rename project | Contract coverage | No live mutation test yet | Pending |
| Save / resume copy branch | Contract coverage | No live branch lifecycle test yet | Pending |
| Design, component, token, audit, export, AI operations | Contract coverage varies by action | No comprehensive live matrix yet | Pending |

## Execution order

1. Finish read-only mapping of all UI controls to source handlers and existing test files.
2. Fill missing typed actions for deterministic app functions; keep credentials and destructive operations behind explicit gates.
3. Add contract tests for every action, argument schema, permission, error case, and persistence evidence.
4. Test by feature group on disposable projects: branch lifecycle; code/editor; design/layers/flow; templates/export/import; design tools; components; diagnostics.
5. For each live mutation, verify exact resulting state and cleanup; check Render deployment status after any merge/deploy before reporting success.
6. Mark an item **verified** only when source/contract checks and the appropriate live test both pass. Keep server-synced and local-only results distinct.

## Live test evidence — branch lifecycle (2026-10-31)

All commands ran against the deployed CodeLab service using a disposable web project; the project was deleted after the checks.

- [Create disposable project](https://github.com/gavilandavid89-pixel/CodeLab/issues/86): project `proj_e41e6815-86ba-4c6c-92de-5e43ac23797d`, snapshot verified and server sync reported `Sincronizado`.
- [Create branch](https://github.com/gavilandavid89-pixel/CodeLab/issues/87): branch `branch_a7f8696b-0057-4c59-92f4-62ba637e3f08`; branch snapshot verified and branch code matched main at creation.
- [Write branch-only HTML](https://github.com/gavilandavid89-pixel/CodeLab/issues/88): exact requested HTML persisted; `saved: true`, `persistedCodeMatchesRequested: true`, `localSnapshotVerified: true`.
- [Resume branch](https://github.com/gavilandavid89-pixel/CodeLab/issues/89): `resumed: true`, `editorMatchesSavedBranch: true`.
- [Merge branch](https://github.com/gavilandavid89-pixel/CodeLab/issues/90): `merged: true`, backup created, local snapshot verified, server synced.
- [Undo merge](https://github.com/gavilandavid89-pixel/CodeLab/issues/91): `undone: true`, branch restored, merge history returned to zero, local snapshot verified, server synced.
- [Delete disposable project](https://github.com/gavilandavid89-pixel/CodeLab/issues/92): `deleted: true`, local snapshot verified.

This verifies the happy path only. Three-way conflict handling and the separate branch-save path still need independent live tests.