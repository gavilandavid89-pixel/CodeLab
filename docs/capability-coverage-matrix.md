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
| Visual design studio | Add heading/text/button/rectangle/ellipse/image; select; update properties; delete; duplicate/move/order layers; undo/redo; grid/snap; grid size; zoom/fit; background; desktop/tablet/mobile frames; Auto Layout direction/gap/padding; prototype target; flow graph | `design_read`, `design_element_add`, `design_element_update`, `design_element_delete`, `design_element_duplicate`, `design_layer_move`, `design_elements_align`, `design_layout_configure`, `design_canvas_configure`, `design_history`, `design_flow_read`, `design_flow_connect`, `design_flow_disconnect` | Direct controls now cover duplication, single-step layer order, alignment, layout, responsive frame, grid/snap, background, and session zoom. Live-tested on a disposable design project. Distribution, multi-step reorder, fit-to-viewport, prototype-target updates, and import/export edge cases remain pending. |
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


## Full design coverage program — eight workstreams

This checklist is intentionally explicit: the presence of a UI control or a bridge action does not count as complete until the operation has a contract test and evidence that the underlying application state changed and persisted where applicable.

| # | Workstream | UI inventory to cover | Assistant operations already present | Remaining completion criteria |
|---|---|---|---|---|
| 1 | Layers and properties | Add heading/text/button/rectangle/ellipse/image; select one or many; label/text; geometry; foreground/background; font size/weight; radius; image source/alt/object-fit; duplicate/delete; layer order; align/distribute | `design_read`, `design_element_add/update/delete/duplicate`, `design_layer_move`, `design_elements_align/distribute` | Inventory every property control and allowed enum; expose missing supported properties; test bounds, unsupported types, selection semantics, and durable state after each mutation. |
| 2 | Canvas and composition | Frame, background, zoom, fit, grid visibility/size, snap, canvas lock, free/auto layout, direction, gap, padding, toolbar/inspector visibility | `design_canvas_configure`, `design_layout_configure` | Add readback for session-only controls; test lock/fit/visibility through browser controls; document persistence boundaries instead of claiming session-only values were saved. |
| 3 | Responsive design | Desktop/tablet/mobile frame; viewport fit; mobile portrait/landscape; reflow; preview at each frame; overflow and hit-target checks | `design_canvas_configure` plus browser viewport tools | Add viewport-specific automated and live checks; compare element geometry and overflow at each frame; verify no control is unreachable at phone widths. |
| 4 | Components and resources | Search, category filtering, details, HTML preview, copy/download, insertion, resource safety and missing IDs | `component_search`, `component_inspect`, `component_insert` | Verify category enumeration from source, insertion into each supported project type, sanitization and failure paths; expose resource export only where the app has a real operation. |
| 5 | Prototypes and flows | External links; internal layer targets; flow graph; connect/disconnect; menu-role toggles; broken targets; export of multi-screen navigation | `design_prototype_target_set`, `design_flow_read/connect/disconnect` | Enforce the exact app link policy before mutation; test internal fragment targets, safe HTTP(S), credential rejection, menu behavior, broken edges and generated navigation. |
| 6 | Design systems | Color palette; primary/secondary/accent/surface/background/text; contrast foreground/background; type scale/base font/ratio; spacing; radius; save/reset; import/export JSON; CSS variables; apply tokens; accessibility audit | `design_tokens_generate`, `accessibility_audit` | Add inspect/export/import/apply operations only by invoking the existing `CodeLabDesignTools` API; verify workspace/local persistence, invalid imports are atomic, generated CSS/tokens match saved settings, and contrast calculations use actual values. |
| 7 | Templates and exchange | Landing/dashboard/portfolio templates; replace-existing confirmation; SVG/JSON design export; HTML project export; design-to-web conversion; design JSON import and recovery prompts | `design_template_apply`, `design_export`, `project_export_html`, `project_convert_design_to_web` | Enumerate all import entry points and schema versions; test malformed/oversized files, no partial mutation on failure, export truncation metadata, conversion source preservation, and round-trip fidelity. |
| 8 | History and reliability | Undo/redo; save/autosave; local snapshots; server sync/reconnect; import recovery; branch/merge recovery; invalid property errors; concurrent writes | `design_history`, workspace inspection and project save/branch tools | Test undo/redo across each mutation category, reload/reopen persistence, offline/local fallback, conflict behavior, recovery, and user-visible failure reporting. |

### Targeted regression added in the complete-coverage branch

The prototype-target operation previously accepted strings such as `#pricing` that the actual app's `safeDesignLink()` deliberately rejects. The bridge now validates the same two supported target classes before interacting with the app: credential-free HTTP(S) URLs and `#layer-<id>` fragments. Unsupported targets are rejected before mutation, avoiding false claims of successful target changes. Contract assertions cover this policy.

### Acceptance gate for each workstream

1. Trace every visible control and its event handler in `public/index.html`, `public/app.js`, `public/design-tools.js`, `public/design-flow.js`, and `public/component-library.js`.
2. Map the control to the existing application function and an allowlisted bridge action; add a new action only when a real capability is missing.
3. Validate required fields, enums, limits, unsafe URLs/content, permissions and approval requirements before mutating state.
4. Add contract tests for normal, boundary, and rejection paths.
5. Run CI; then use a disposable project on the CodeLab deployment for live verification when the action mutates project state.
6. Verify the state from a fresh read or snapshot; clean up disposable data and verify cleanup.
7. Mark a row complete only after evidence exists. Session-only browser state, locally persisted state, and server-synced state must be reported separately.

**Status note:** this program defines the required coverage, not a claim that all eight workstreams are finished. Workstreams 1, 2 and parts of 4–7 already have direct actions and some live smoke tests; the remaining criteria above are still open until implemented and verified.
