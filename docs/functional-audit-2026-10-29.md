# CodeLab functional audit — 2026-10-29

## Scope
Audit of the changes in PR #2 on `feature/design-workspace`: visual design projects/canvas, AI capture exports, design-system laboratory, accessibility checker, reusable component library, and CI coverage. This is a source review plus GitHub Actions/Chromium tests; it is **not** a live deployed-site audit. No Render service was changed.

## Verified
- The PR workflow validates syntax, capture unit tests, design-token/contrast/audit unit tests, component catalog tests, Chromium interaction tests, the full visual-design workflow E2E against the real app/server, and API/Groq health. The full workflow test covers create → edit → undo/redo → drag → duplicate/delete → responsive frame presets/mobile overflow → server persistence/reload → recovery of a newer local edit and a pending offline deletion → convert to web → insert a real library component and verify it persists in the server workspace. It also injects HTTP 429 and 413 responses to verify retry and local-only recovery behavior.
- Design capture builds SVG/PNG assets and a JSON context. Web capture removes scripts/embedded frames from its isolated capture document and reports that JavaScript is excluded from the screenshot.
- Design-system utilities calculate contrast, generate palettes/tokens, export CSS/JSON, keep a local backup, and synchronize settings through a workspace-authorized server endpoint; the browser test now covers migration, remote save, and import sync. The HTML audit remains static.
- Component library has 8 catalog entries, search/category filtering, sandboxed preview, HTML copy/download, and insertion into the active web project. Its focused browser test uses mocked editor APIs; the full-app E2E now additionally checks real insertion and server persistence.
- Visual design projects are distinguished by `type: "design"`; web project integrations explicitly reject design projects where appropriate.

## Fixes applied during this audit
- Layer selection and property values now use HTML-attribute escaping; layer selection uses data attributes rather than interpolating project IDs into inline JavaScript handlers.
- Text alignment property changes update the canvas immediately.
- Palette swatches are labelled as selecting/using a shade rather than claiming to copy it.
- Uncommitted design-system edits remain in the modal draft when it is closed and reopened during the same page session.
- CSS token insertion deduplicates repeated managed marker blocks.
- UI wording now explains that token insertion adds CSS variables and does not automatically rewrite every existing color/style.
- Capture sanitization neutralizes quoted and unquoted javascript: URLs in link, image, and form-action attributes.
- Server request handling now tolerates malformed cookie encoding and returns a proper 413 for oversized bodies; rate-limit maps expire stale AI entries and forwarded-IP parsing supports an explicit trusted-proxy hop count.
- Workspace recovery merges local/server projects by ID and update time, preserves pending deletions as per-workspace tombstones, keeps pending imports per account, and avoids false timestamp bumps on page unload.
- A workspace-scoped design-system endpoint persists visual settings; localStorage remains the fallback and old local settings migrate on first use. Design-system writes are serialized to prevent a slow earlier save from overwriting a newer value, and a stale workspace read cannot replace a local save made while it was in flight.
- Forwarded-IP rate limiting preserves proxy-hop positions and rejects malformed chains instead of filtering invalid entries and accidentally shifting the trusted-hop selection; integration coverage uses a two-hop trust configuration.
- Outbound HTTPS calls to OAuth and AI providers now have a configurable inactivity timeout (default 60 seconds, bounded to 1–300 seconds), preventing stalled upstreams from holding requests indefinitely.
- OAuth callbacks now require the signed state to match an HttpOnly, SameSite=Lax, short-lived cookie set when that browser starts login; integration tests verify copied state URLs without the initiating browser cookie are rejected for GitHub and Google.
- Copilot provider settings and user-supplied API keys are now stored under account-specific browser storage keys; account identity resolves before loading AI settings, legacy global keys are discarded when a real account is active, and logout reloads anonymous settings to avoid leaving the prior account's key in memory. A source-level regression guard runs in CI.
- The user-configurable AI provider URL is validated as HTTPS and resolved against public IP ranges; loopback/private targets are rejected, the resolved address is pinned for the connection, and the server integration test covers a loopback SSRF attempt.

## Remaining limitations / coverage gaps
- The focused browser tests for the design-tools and component-library dialogs extract their modal markup and mock editor APIs. Design-system workspace sync is tested with a simulated API, and server persistence/auth is covered by an integration test; live OAuth cross-device behavior still requires a deployed environment.
- The dedicated full visual-design workflow E2E covers project creation, property editing, undo/redo, pointer dragging, duplication/deletion, desktop/tablet/mobile frame presets, document-level horizontal overflow on mobile, real server-backed persistence/reload, recovery of newer local edits, offline-deletion tombstones, HTTP 429 retry, HTTP 413 local-only status/recovery, and conversion to web with generated HTML verified from the persisted workspace. It does not yet test PNG/JSON export inside the same workflow.
- AI web screenshot capture depends on loading html2canvas from its external script source. If it cannot load, the feature intentionally falls back to exporting JSON context without PNG.
- Design-token settings now synchronize per workspace with localStorage retained as a fallback. The workspace API integration and browser-level migration/save/import path are covered by tests; live cross-device behavior still requires a deployed OAuth-enabled environment to validate.
- The accessibility audit is static regex-based HTML analysis. It does not execute JavaScript, inspect dynamic states, compute CSS contrast, or replace a full accessibility evaluation.
- Monaco editor loading is asynchronous; initialization now uses a generation guard so stale callbacks from a previous project are ignored. The full-app E2E waits for the active project's editor contents before exercising insertion.
- Workspace sync schedules automatic retries after HTTP 429 with backoff delays of 2 s, 5 s, then a 15 s cap. HTTP 413 is distinguished from a connectivity outage; local changes are retained and a later successful smaller save clears the warning. The E2E checks mobile viewport dimensions, canvas frame sizing, and document-level horizontal overflow, but it is not yet a screenshot-based visual regression test across multiple device sizes.

## Deployment / merge
PR remains open and draft. No merge or deployment was performed as part of this audit.
