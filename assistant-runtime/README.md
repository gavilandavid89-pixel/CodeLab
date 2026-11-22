# CodeLab Assistant Headless Runtime

Persistent offline runtime for assistant-side CodeLab/PixelForge tests.

- No Neon.
- No Render.
- No account/authentication.
- No OAuth.
- No external API.
- Local filesystem workspace state.
- System Chromium through Chrome DevTools Protocol.
- Node.js built-ins; no npm registry required.

Run from repository root:

```bash
CODELAB_HEADLESS_ROOT=. node assistant-runtime/runtime.mjs
```

The runtime serves the existing `public/` UI at `127.0.0.1:3187` and launches Chromium headless.

Recovery: clone/download the `assistant/headless-runtime` branch. It contains the persistent runtime overlay and the CodeLab/PixelForge source it executes.

This branch is intentionally separate from production Render/Neon operation.
