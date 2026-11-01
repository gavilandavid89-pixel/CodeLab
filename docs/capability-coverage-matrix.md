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
| Visual design studio | Add heading/text/button/rectangle/ellipse/image; select; update properties; delete; duplicate/move/order layers; undo/redo; grid/snap; grid size; zoom/fit; background; desktop/tablet/mobile frames; Auto Layout direction/gap/padding; prototype target; flow graph | `design_read`, `design_element_add`, `design_element_update`, `design_element_delete`, `design_elements_delete`, `design_element_duplicate`, `design_layer_move`, `design_layer_reorder`, `design_elements_align`, `design_layout_configure`, `design_canvas_configure`, `design_history`, `design_flow_read`, `design_flow_connect`, `design_flow_disconnect` | Direct controls now cover duplication, single-step and arbitrary-index layer order, single and bulk deletion, alignment, layout, responsive frame, grid/snap, background, and session zoom. Live-tested on a disposable design project. Distribution, arbitrary-index layer reorder, fit-to-viewport, prototype-target updates, and import/export edge cases remain pending. `design_layer_reorder` now exposes arbitrary target-index ordering with range checks and local-order verification; live testing remains pending. |
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

## Live test evidence — visual design studio controls (2026-10-31)

PR #94 added five direct operations and was merged/deployed to Render. CI run [41234978614](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/41234978614) passed all validation steps, including syntax, assistant contract checks, static event wiring, persistence/resilience, design token/contrast, component library, browser capture, and full-system E2E. Render deployment for commit `4985b2ea1867779eb0b63770cc6b0997a2bf43c5` reached `live`.

The live tests used disposable design project `proj_f3edbfbb-b2e7-4bf0-9d5c-625c4c53058f`, which was removed after testing:

- [Create design project](https://github.com/gavilandavid89-pixel/CodeLab/issues/95) and [add first layer](https://github.com/gavilandavid89-pixel/CodeLab/issues/96).
- [Add second layer](https://github.com/gavilandavid89-pixel/CodeLab/issues/97).
- [Duplicate layer](https://github.com/gavilandavid89-pixel/CodeLab/issues/98): exact new layer persisted and local snapshot verified.
- [Move layer order](https://github.com/gavilandavid89-pixel/CodeLab/issues/99): order changed and saved snapshot matched.
- [Align layers](https://github.com/gavilandavid89-pixel/CodeLab/issues/100): position values changed and snapshot verified.
- [Configure Auto Layout](https://github.com/gavilandavid89-pixel/CodeLab/issues/101): mode, direction, gap and padding verified.
- [Configure responsive canvas](https://github.com/gavilandavid89-pixel/CodeLab/issues/102): mobile frame, grid, snap, grid size and background verified; zoom is reported as session-only.
- [Cleanup](https://github.com/gavilandavid89-pixel/CodeLab/issues/103): deletion and snapshot verified.

The tests verify these happy paths, not every invalid input, conflict state, or browser viewport variation.


## Live cross-tool verification — 2026-11-01

These are disposable-project results from the deployed bridge, not inferred from source presence alone:

- Layers: created rectangle/button/heading; updated geometry and styling; moved rectangle to front; duplicated and deleted only the duplicate. A fresh `design_read` showed the original button and rectangle remained after deletion. Evidence: issues [#133](https://github.com/gavilandavid89-pixel/CodeLab/issues/133), [#134](https://github.com/gavilandavid89-pixel/CodeLab/issues/134), [#135](https://github.com/gavilandavid89-pixel/CodeLab/issues/135), [#136](https://github.com/gavilandavid89-pixel/CodeLab/issues/136), [#137](https://github.com/gavilandavid89-pixel/CodeLab/issues/137), [#138](https://github.com/gavilandavid89-pixel/CodeLab/issues/138), [#139](https://github.com/gavilandavid89-pixel/CodeLab/issues/139), [#140](https://github.com/gavilandavid89-pixel/CodeLab/issues/140).
- Alignment and distribution: three elements were aligned left and then distributed horizontally; results returned changed positions, `saved: true`, and local snapshot verification. Evidence: [#143](https://github.com/gavilandavid89-pixel/CodeLab/issues/143), [#145](https://github.com/gavilandavid89-pixel/CodeLab/issues/145).
- Canvas/layout: mobile frame, grid, snap, grid size, background and zoom accepted; zoom is explicitly session-only. Auto Layout column mode, gap and padding were saved. Evidence: [#147](https://github.com/gavilandavid89-pixel/CodeLab/issues/147), [#148](https://github.com/gavilandavid89-pixel/CodeLab/issues/148).
- Templates: applying a landing template to a clean disposable design created four layers and verified the save. Attempting additive template application to a non-empty design was correctly rejected before replacement. Evidence: [#149](https://github.com/gavilandavid89-pixel/CodeLab/issues/149), [#150](https://github.com/gavilandavid89-pixel/CodeLab/issues/150), [#151](https://github.com/gavilandavid89-pixel/CodeLab/issues/151).
- Design system/export/flows: token generation returned normalized settings, tokens and CSS variables; JSON design export returned a 2,968-character payload without truncation; a button-to-project flow connection was saved and verified. Evidence: [#152](https://github.com/gavilandavid89-pixel/CodeLab/issues/152), [#153](https://github.com/gavilandavid89-pixel/CodeLab/issues/153), [#154](https://github.com/gavilandavid89-pixel/CodeLab/issues/154).
- Reopening/readback: a separate bridge execution read the same design project and confirmed three layers and persisted mobile canvas settings. Evidence: [#155](https://github.com/gavilandavid89-pixel/CodeLab/issues/155).
- Cleanup: both disposable design projects were deleted and local snapshots verified. Evidence: [#156](https://github.com/gavilandavid89-pixel/CodeLab/issues/156), [#157](https://github.com/gavilandavid89-pixel/CodeLab/issues/157).

### Remaining known gaps

- The bridge's standalone undo call returned `changed: false`; undo/redo needs a same-session test because history may be scoped to the editor session. Do not mark history complete yet. Evidence: [#146](https://github.com/gavilandavid89-pixel/CodeLab/issues/146).
- Render logs warn that `CODELAB_DATA_DIR` and `CODELAB_WORKSPACE_SECRET` are not configured. Current tests verified saves/readback while the service remained running, but restart-safe workspace persistence has not been proven and must be fixed or configured before claiming durable production storage.
- The landing page footer version was stale (2.6.4 while the title/server report 2.6.6); this PR aligns the footer to 2.6.6.


## Cross-workstream live regression — prototype links (2026-11-01)

The deployed bridge accepted a button target pointing to another design layer using the editor-supported `#layer-<id>` form. A separate JSON export then contained the exact same `href`, proving the value survived a new browser execution rather than only existing in the mutation response. The disposable project was deleted afterward.

- [Create test project](https://github.com/gavilandavid89-pixel/CodeLab/issues/161)
- [Add button and target heading](https://github.com/gavilandavid89-pixel/CodeLab/issues/162) · [add heading](https://github.com/gavilandavid89-pixel/CodeLab/issues/163)
- [Set internal target](https://github.com/gavilandavid89-pixel/CodeLab/issues/164)
- [Read design in a fresh execution](https://github.com/gavilandavid89-pixel/CodeLab/issues/165)
- [Export and verify exact href](https://github.com/gavilandavid89-pixel/CodeLab/issues/166)
- [Delete disposable project](https://github.com/gavilandavid89-pixel/CodeLab/issues/167)

**Cross-workstream rule:** bridge actions are globally available by their declared action name, not gated by which visual section the user happens to be viewing. A workflow may combine layer mutations, canvas/layout settings, component/library operations, prototype navigation, exports, tokens and audits against the same project when their input types and preconditions match. Keep each mutation permission-checked, verify the resulting state, and do not claim session-only operations are persisted.


## Authoritative coverage reconciliation — 2026-11-01

This section supersedes the older action count and pending rows above where newer live evidence is linked. The current allowlist contains **55 unique actions** (60 entries before duplicate-name cleanup; five names were repeated in the literal array). All visual design actions require an authenticated admin session and an explicit `project_id` after PR #170. UI section does not restrict tool choice: actions can be combined across workstreams when the target project and action preconditions are valid.

### Eight workstreams — current status

| Workstream | Available operations | Evidence-backed status | Still not proven / not exposed |
|---|---|---|---|
| 1. Layers and properties | Add/update/delete/duplicate, move layer order, align/distribute, set prototype target; geometry and style properties through `design_element_update` | Live add/update/reorder/duplicate/delete, alignment and distribution; deleting a duplicate left original layers intact. [Layer evidence](https://github.com/gavilandavid89-pixel/CodeLab/issues/133)–[#145](https://github.com/gavilandavid89-pixel/CodeLab/issues/145) | Not every property/type combination or boundary value has been tested. Selection is editor state, not a persistent design mutation. |
| 2. Canvas and composition | Frame, background, grid, snap, grid size, zoom; free/Auto Layout direction/gap/padding | Mobile frame, grid/snap, background and Auto Layout settings were saved and read back. [Canvas](https://github.com/gavilandavid89-pixel/CodeLab/issues/147), [layout](https://github.com/gavilandavid89-pixel/CodeLab/issues/148) | Zoom is session-only; no dedicated pan/fit-to-viewport operation. |
| 3. Responsive design | Desktop/tablet/mobile frame selection and the existing responsive web preview/browser controls | Mobile canvas setting persisted; editor/browser bridge is available. | Tablet-specific geometry, orientation, breakpoints and actual responsive viewport rendering still need live tests. A frame selection alone does not prove responsive layout quality. |
| 4. Components and resources | Search, inspect component metadata/standalone HTML, insert into a project | Search and inspect were live-tested; component HTML was returned without truncation. [Search](https://github.com/gavilandavid89-pixel/CodeLab/issues/107), [inspect](https://github.com/gavilandavid89-pixel/CodeLab/issues/108) | Component insertion still needs an isolated live test with exact saved-code verification; library images/download UX are not all separate bridge actions. |
| 5. Prototype and flows | Set internal/external prototype target; read/connect/disconnect flow graph | Internal `#layer-<id>` target survived a fresh read and JSON export. Flow connection was saved and verified. [Target roundtrip](https://github.com/gavilandavid89-pixel/CodeLab/issues/164)–[#166](https://github.com/gavilandavid89-pixel/CodeLab/issues/166), [flow](https://github.com/gavilandavid89-pixel/CodeLab/issues/154) | Full multi-screen preview playback and every disconnect/error path need tests. |
| 6. Design systems and accessibility | Generate normalized design tokens/CSS variables; run HTML accessibility audit | Token generation returned settings, tokens and CSS variables. [Tokens](https://github.com/gavilandavid89-pixel/CodeLab/issues/152) | Palette CRUD, import/export of design-system JSON, contrast query and audit export are not all direct typed operations. Audit needs live verification on known accessible/inaccessible fixtures. |
| 7. Templates and exchange | Apply landing/dashboard/portfolio template; export SVG/JSON; convert design to web | Landing template generated four layers on a clean disposable project; JSON export returned 2,968 characters without truncation. [Template](https://github.com/gavilandavid89-pixel/CodeLab/issues/150), [export](https://github.com/gavilandavid89-pixel/CodeLab/issues/153) | Dashboard/portfolio templates, SVG output, JSON import validation and design-to-web conversion still need live roundtrip tests. |
| 8. History, persistence and reliability | Design undo/redo; web branch create/save/resume/merge/undo; project save/readback; validation and sync diagnostics | Web branch happy path, merge backup and undo-merge were live-tested. Design edits/readback and cross-tool operations were verified while the service remained running. | Design undo returned `changed:false` when invoked from a separate execution; same-session undo/redo is unresolved. Render logs warn that `CODELAB_DATA_DIR` and `CODELAB_WORKSPACE_SECRET` are not configured, so restart-safe storage/token stability is not proven. Do not label this production-durable until persistent storage is configured and tested across a restart/redeploy. |

### Control inventory regression

After PR #172, live `list_controls` returned **24 visible interactive controls** from the deployed landing page, including project create/open/duplicate/delete, project search, design tools, component library and AI prompt controls. The result includes accessible labels, data-action metadata, IDs and disabled state. Evidence: [issue #173](https://github.com/gavilandavid89-pixel/CodeLab/issues/173). This is a landing-page inventory; the editor and each modal still need their own inventory pass.

### Permission and project-scope regression

PR #170 moved all layer ordering, alignment/distribution, prototype-target, layout and canvas mutation actions under the authenticated-session/project-scope policy. CI passed and Render reached `live`. A live negative test without `project_id` was rejected during command validation before page interaction: [issue #171](https://github.com/gavilandavid89-pixel/CodeLab/issues/171). This confirms the safety guard, not the success path for every action; existing live evidence remains the basis for each operation above.

### Next tests, in priority order

1. Fix/validate durable workspace persistence without repurposing an unrelated database or silently adding paid infrastructure.
2. Add a same-session undo/redo test harness and verify state after undo and redo.
3. Live-test component insertion, accessibility audit fixtures, SVG export, design-to-web conversion, tablet/orientation preview, and branch conflict handling.
4. Add a per-screen control inventory for editor, design tools, component library, prototype/flow, and settings dialogs.
5. Keep each result marked pending until a real deployed test verifies exact before/after state and disposable resources are cleaned up.


### Bulk layer deletion tool

`design_elements_delete` accepts 1–100 unique layer IDs, validates all targets before mutation, uses the existing app deletion flow for multi-selection, and verifies the requested layers are absent from the resulting project snapshot. It also checks that deleted layers do not leave outgoing flow connections. CI and live testing passed: [bulk-delete command](https://github.com/gavilandavid89-pixel/CodeLab/issues/213) removed two requested layers, verified `remainingElements: 1`, `danglingConnections: 0`, and `localSnapshotVerified: true`; [readback](https://github.com/gavilandavid89-pixel/CodeLab/issues/214) confirmed only the button remained, and [cleanup](https://github.com/gavilandavid89-pixel/CodeLab/issues/215) deleted the disposable project.


### Live evidence — composable layer operations (2026-11-01)

- [PR #198](https://github.com/gavilandavid89-pixel/CodeLab/pull/198) added `design_layer_reorder`, which moves a layer to an arbitrary valid index and verifies the complete local order.
- [Live reorder](https://github.com/gavilandavid89-pixel/CodeLab/issues/203): rectangle moved from index 0 to index 2; `changed: true`, `saved: true`, `localSnapshotVerified: true`.
- [Property edit after reorder](https://github.com/gavilandavid89-pixel/CodeLab/issues/204): changed x/y/width/height/background and verified the exact values in the snapshot.
- [Delete a different layer](https://github.com/gavilandavid89-pixel/CodeLab/issues/205) then [read back](https://github.com/gavilandavid89-pixel/CodeLab/issues/206): remaining layer order and properties matched expectations; disposable project cleanup succeeded in [issue #207](https://github.com/gavilandavid89-pixel/CodeLab/issues/207).
- [PR #208](https://github.com/gavilandavid89-pixel/CodeLab/pull/208) added `design_elements_delete` for 1–100 unique IDs. [Live bulk delete](https://github.com/gavilandavid89-pixel/CodeLab/issues/213) removed two of three layers and reported zero dangling outgoing connections; [readback](https://github.com/gavilandavid89-pixel/CodeLab/issues/214) confirmed exactly one layer remained; [cleanup](https://github.com/gavilandavid89-pixel/CodeLab/issues/215) succeeded.
- These tests prove tool composition on a running deployed instance, not restart durability. Continue covering other workstreams independently.
