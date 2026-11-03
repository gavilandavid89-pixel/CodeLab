# PixelForge studio module

This directory is the CodeLab-hosted integration copy of the standalone PixelForge AI editor.

## Boundaries

- Keep editor implementation, styles, and assets for PixelForge inside `public/pixelforge/`.
- Keep CodeLab-wide session and request semantics in `public/studio-core.js`; PixelForge imports that shared contract instead of implementing a second account/login system.
- Keep account-bound project CRUD in the PixelForge API route in `server.js`. The API derives ownership from the authenticated CodeLab session and stores records under that account's workspace.
- Do not change CodeLab's general workspace/project model just to add a PixelForge-specific feature unless the feature genuinely belongs to the shared platform.
- PixelForge provider keys are held in memory while configured; do not persist them in shared local storage or attach them to saved artwork.

## Upstream source

The standalone source project is [PixelForge-Ai](https://github.com/gavilandavid89-pixel/PixelForge-Ai). This directory is intentionally kept as a separate module in the CodeLab repository so the editor can be evolved without spreading its UI and engine changes through unrelated CodeLab files.

When syncing upstream changes, review and port changes into this directory rather than replacing the whole directory blindly. Preserve the CodeLab-specific integrations in:

- `index.html`: CodeLab return link and studio entry.
- `src/persistence.js`: account-backed API adapter using `studio-core.js`.
- `src/editor.js`: CodeLab session gate and account-scoped palette preferences.
- `server.js` (outside this directory): authenticated, bounded project storage API.
- `tests/pixelforge-integration.test.js`: cross-account, persistence, validation, and browser acceptance coverage.

## Verification expectations

After changing this module, run the CodeLab validation workflow and Agent Space Browser Runner. Do not merge or deploy until the account gate, account isolation, project save/load/delete, reload recovery, malformed-project rejection, storage limits, and account-scoped palette tests pass.
