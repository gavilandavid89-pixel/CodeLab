# CodeLab functional audit — 2026-10-29

## Scope
Audit of the changes in PR #2 on `feature/design-workspace`: visual design projects/canvas, AI capture exports, design-system laboratory, accessibility checker, reusable component library, and CI coverage. This is a source review plus GitHub Actions/Chromium tests; it is **not** a live deployed-site audit. No Render service was changed.

## Verified
- The PR workflow has a passing run on the pre-audit head: syntax checks, capture unit tests, design-token/contrast/audit unit tests, component catalog tests, Chromium interaction tests for the design-tools and component-library modals, and API/Groq health smoke test.
- Design capture builds SVG/PNG assets and a JSON context. Web capture removes scripts/embedded frames from its isolated capture document and reports that JavaScript is excluded from the screenshot.
- Design-system utilities calculate contrast, generate palettes/tokens, export CSS/JSON, save settings in browser localStorage, and statically scan HTML.
- Component library has 8 catalog entries, search/category filtering, sandboxed preview, HTML copy/download, and insertion into the active web project. Its browser test uses mocked project editor functions for insertion.
- Visual design projects are distinguished by `type: "design"`; web project integrations explicitly reject design projects where appropriate.

## Fixes applied during this audit
- Layer selection and property values now use HTML-attribute escaping; layer selection uses data attributes rather than interpolating project IDs into inline JavaScript handlers.
- Text alignment property changes update the canvas immediately.
- Palette swatches are labelled as selecting/using a shade rather than claiming to copy it.
- Uncommitted design-system edits remain in the modal draft when it is closed and reopened during the same page session.
- CSS token insertion deduplicates repeated managed marker blocks.
- UI wording now explains that token insertion adds CSS variables and does not automatically rewrite every existing color/style.

## Remaining limitations / coverage gaps
- The browser tests for the design-tools and component-library dialogs extract their modal markup and mock editor APIs. They validate interaction logic, but do not exercise the full production page, real autosave/network sync, OAuth, or deployed Render behavior.
- No end-to-end browser test currently covers the entire visual design canvas workflow (create design project, drag, property editing, undo/redo, delete/duplicate, persistence, convert to web, and exports). Source review found the main handlers, but this workflow still needs a dedicated integration test.
- AI web screenshot capture depends on loading html2canvas from its external script source. If it cannot load, the feature intentionally falls back to exporting JSON context without PNG.
- Design tokens are saved in localStorage, not synchronized to the user's account/workspace.
- The accessibility audit is static regex-based HTML analysis. It does not execute JavaScript, inspect dynamic states, compute CSS contrast, or replace a full accessibility evaluation.
- Component HTML insertion is tested with mocked editor APIs; save/preview behavior should still be confirmed in the full app.
- Mobile layout has responsive classes and viewport options, but no screenshot-based regression test currently checks the full app at multiple viewport sizes.

## Deployment / merge
PR remains open and draft. No merge or deployment was performed as part of this audit.
