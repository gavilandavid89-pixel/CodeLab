# Runtime

The runtime is intentionally small. Penpot itself remains the design engine.

- design-server.mjs serves the compiled Penpot distribution only from loopback.
- web-test.mjs launches a real Chromium instance inside Xvfb and blocks non-loopback network requests.
- screenshots are produced by the same browser session used for visual QA.

A future native bootstrap adapter can be added here without replacing the editor or inventing a second design model.
