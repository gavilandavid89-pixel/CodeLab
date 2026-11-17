# CodeLab native headless protocol

## Architecture

The assistant-side headless client and the repository-side native worker communicate through the PostgreSQL command mailbox:

**Assistant headless client → codelab_agent_commands → agent-bridge-worker.mjs → CodeLab ADMIN workspace / PixelForge**

The assistant client submits structured JSON commands directly to PostgreSQL. It does not open the CodeLab UI, click menus, or depend on screen coordinates. The persistent repository worker claims commands, checks the ADMIN workspace, executes the action, and stores the result in the same mailbox row.

## Assistant-side client

The client uses the same CodeLab PostgreSQL database as the deployed app. Keep DATABASE_URL in the assistant runtime secret store; never commit it or send it to the browser.

    import { createAssistantHeadlessClient } from './assistant-headless-client.mjs';
    const codelab = createAssistantHeadlessClient();
    try {
      const status = await codelab.status();
      const source = await codelab.readCode('proj_example');
      const saved = await codelab.updateCode('proj_example', {
        html: '<!doctype html><html><body><h1>Updated</h1></body></html>',
        css: 'body { font-family: sans-serif; }'
      }, source.result.revision);
      const video = await codelab.exportAnimationVideo('pixelforge_project_id', {
        uploadTarget: { url: process.env.CODELAB_VIDEO_PRESIGNED_URL, objectKey: 'pixelforge/exports/example.webm' }
      });
    } finally { await codelab.close(); }

The client discovers the ADMIN workspace ID from codelab_accounts, queues a UUID command with an expiry, and polls the mailbox for its result. It exposes submit, getCommand, wait, and run for custom workflows.

## Repository-side actions

- codelab_project_get_code: read HTML, CSS and JavaScript from ADMIN workspace.
- codelab_project_update_code: update one or more of HTML/CSS/JS, with 500 KiB per-field limits, optional revision precondition, conflict-safe workspace persistence, and read-after-write verification.
- pixelforge_export_animation_video: load the saved animation timeline, render each saved frame, play frames for their recorded durations in headless Chromium, and record a WebM with Playwright. Output is capped at 240 frames, 60 seconds, 16 MiB of serialized frame data and 24 MiB of video.
- PNG capture remains provided by the existing real-Chromium capture action. Existing PixelForge structured animation editing remains approval-gated through proposal/approve commands.

## Video artifact storage

For durable video output, the command may include a trusted Neon presigned uploadTarget. The worker accepts HTTPS uploads only to the configured Neon storage host, public capture bucket, and exact object key under pixelforge/exports/. The content type is video/webm. Without an upload target, small videos (up to 8 MiB) are returned inline as base64; larger videos fail clearly instead of bloating PostgreSQL command rows.

The video is captured by Chromium itself; it is not a fabricated GIF, a sequence of PNGs renamed as a video, or a screenshot montage. Frame timing follows the saved durationMs values. The reported timeline FPS is source metadata; Chromium's WebM encoder controls the encoded frame cadence.

## Security and operational constraints

- All commands are scoped to the ADMIN workspace resolved from the same database.
- The worker checks workspace ownership and command expiry before dispatch.
- Code updates only permit the html, css, and js fields.
- Video upload URLs are checked for HTTPS, exact storage host, bucket, and object key.
- Proposal-based raster/design changes retain explicit approval; the client does not auto-approve them.
- The native worker still requires DATABASE_URL and CODELAB_AGENT_BRIDGE_ENABLED not set to 0.
- Run npm test to execute the native bridge contract tests.
