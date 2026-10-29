# CodeLab functional audit — 2026-10-29

## Scope
Audit of the changes in PR #2 on `feature/design-workspace`: visual design projects/canvas, AI capture exports, design-system laboratory, accessibility checker, reusable component library, and CI coverage. This is a source review plus GitHub Actions/Chromium tests; it is **not** a live deployed-site audit. No Render service was changed.

## Verified
- The PR workflow validates syntax, capture unit tests, design-token/contrast/audit unit tests, component catalog tests, Chromium interaction tests, the full visual-design workflow E2E against the real app/server, and API/Groq health. The full workflow test covers create → edit → undo/redo → drag → duplicate/delete → responsive frame presets/mobile overflow → server persistence/reload → convert to web → insert a real library component and verify it persists in the server workspace.
- Design capture builds SVG/PNG assets and a JSON context. Web capture removes scripts/embedded frames from its isolated capture document and reports that JavaScript is excluded from the screenshot.
- Design-system utilities calculate contrast, generate palettes/tokens, export CSS/JSON, save settings in browser localStorage, and statically scan HTML.
- Component library has 8 catalog entries, search/category filtering, sandboxed preview, HTML copy/download, and insertion into the active web project. Its focused browser test uses mocked editor APIs; the full-app E2E now additionally checks real insertion and server persistence.
- Visual design projects are distinguished by `type: "design"`; web project integrations explicitly reject design projects where appropriate.

## Fixes applied during this audit
- Layer selection and property values now use HTML-attribute escaping; layer selection uses data attributes rather than interpolating project IDs into inline JavaScript handlers.
- Text alignment property changes update the canvas immediately.
- Palette swatches are labelled as selecting/using a shade rather than claiming to copy it.
- Uncommitted design-system edits remain in the modal draft when it is closed and reopened during the same page session.
- CSS token insertion deduplicates repeated managed marker blocks.
- UI wording now explains that token insertion adds CSS variables and does not automatically rewrite every existing color/style.

## Remaining limitations / coverage gaps
- The focused browser tests for the design-tools and component-library dialogs extract their modal markup and mock editor APIs. The full-app E2E now covers component insertion and server persistence, but the focused modal tests still do not exercise real autosave/network sync, OAuth, or deployed Render behavior.
- The dedicated full visual-design workflow E2E now covers project creation, property editing, undo/redo, pointer dragging, duplication/deletion, desktop/tablet/mobile frame presets, document-level horizontal overflow on mobile, real server-backed persistence and reload, and conversion to web with generated HTML verified from the persisted workspace. It does not yet test PNG/JSON export inside the same workflow.
- AI web screenshot capture depends on loading html2canvas from its external script source. If it cannot load, the feature intentionally falls back to exporting JSON context without PNG.
- Design tokens are saved in localStorage, not synchronized to the user's account/workspace.
- The accessibility audit is static regex-based HTML analysis. It does not execute JavaScript, inspect dynamic states, compute CSS contrast, or replace a full accessibility evaluation.
- Monaco editor loading is asynchronous. A project switch could leave a previous project's delayed editor initialization callback able to overwrite the active editor; initialization now uses a generation guard so stale callbacks are ignored. The full-app E2E waits for the active project's editor contents before exercising insertion.
- Workspace sync now schedules automatic retries after HTTP 429 rate limiting with backoff delays of 2 s, 5 s, then a 15 s cap instead of claiming a retry without scheduling one. Overlapping saves no longer cancel a retry while another request is in flight; the full-app E2E simulates a first 429 and verifies that the real save retries and persists. The E2E checks mobile viewport dimensions, canvas frame sizing, and document-level horizontal overflow, but it is not yet a screenshot-based visual regression test across multiple device sizes.

## Deployment / merge
PR remains open and draft. No merge or deployment was performed as part of this audit.
