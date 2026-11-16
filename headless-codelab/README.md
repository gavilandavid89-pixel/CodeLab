# CodeLab Headless Remote Editor

This is the downloadable working environment for the CodeLab agent.

- The **headless package** is the operational editor.
- **Real CodeLab/Render** is the visual truth.
- **GitHub Actions** remains CI/evidence infrastructure, not the interaction mechanism.

The worker uses Chromium + Playwright and an explicit in-page semantic protocol. It can inspect state and issue commands without coordinate clicking or scrolling.

Example:

```bash
headless-codelab/bin/codelab-headless.sh remote \
  --url https://YOUR-CODELAB-RENDER.example.com/ \
  --allow-external \
  --commands commands.json \
  --screenshot
```

Commands:

```json
[
  {"action":"inspect","required":true},
  {"action":"navigate","args":{"path":"/design"},"required":true},
  {"action":"inspect","required":true},
  {"action":"save","required":false}
]
```

The browser context is persistent through `--session-dir`, allowing browser authentication/local state to survive across invocations.

Safety:
- same-origin navigation;
- explicit action allowlist;
- no arbitrary JavaScript execution;
- external network blocked unless explicitly allowed;
- no production database credentials embedded.

The Penpot headless editor remains a design component of the wider CodeLab headless environment.
