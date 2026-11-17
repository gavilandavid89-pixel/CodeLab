# CodeLab native headless protocol

## Architecture

The assistant-side headless client and the repository-side native worker communicate through the PostgreSQL command mailbox:

**Assistant headless client → codelab_agent_commands → agent-bridge-worker.mjs → CodeLab ADMIN workspace / PixelForge**

The assistant client submits structured JSON commands directly to PostgreSQL. It does not open the CodeLab UI, click menus, or depend on screen coordinates. The persistent repository worker claims commands, checks the ADMIN workspace, executes the action, and stores the result in the same mailbox row.

## Assistant-side client

The client uses the same CodeLab PostgreSQL database as the deployed app. Keep DATABASE_URL in the assistant runtime secret store; never commit it or send it to the browser. For production, use a dedicated database role limited to reading the ADMIN account identity and inserting/reading command rows; do not give the assistant client the app's broad owner credentials when a restricted role can be provisioned.

    import { createAssistantHeadlessClient } from './assistant-headless-client.mjs';
    const codelab = createAssistantHeadlessClient();
    try {
      const status = await codelab.status();
      const source = await codelab.readCode('proj_example');
      const saved = await codelab.updateCode('proj_example', {
        html: '<!doctype html><html><body><h1>Updated</h1></body></html>',
        css: 'body { font-family: sans-serif; }'
      }, source.result.revision);
      const png = await codelab.captureCodeLabPng('proj_example');
  const projectVideo = await codelab.recordCodeLabVideo('proj_example', { duration_ms: 5000 });
  const video = await codelab.exportAnimationVideo('pixelforge_project_id', {
        uploadTarget: { url: process.env.CODELAB_VIDEO_PRESIGNED_URL, objectKey: 'pixelforge/exports/example.webm' }
      });
    } finally { await codelab.close(); }

The client discovers the ADMIN workspace ID from codelab_accounts, calls the existing public /api/health endpoint to wake a sleeping Render instance, queues a UUID command with an expiry, and polls the mailbox for its result. Set CODELAB_BASE_URL when the CodeLab service is hosted at a different URL. It exposes wakeWorker, submit, getCommand, wait, and run for custom workflows.

## Repository-side actions

- codelab_project_get_code: read HTML, CSS and JavaScript from ADMIN workspace.
- codelab_project_update_code: update one or more of HTML/CSS/JS, with 500 KiB per-field limits, optional revision precondition, conflict-safe workspace persistence, and read-after-write verification.
- codelab_project_capture_png: capture the actual ADMIN project route or preview body in Chromium as a PNG; optionally upload it to Neon.
- pixelforge_capture_interface: capture the real PixelForge interface and artwork canvas as PNGs; optionally upload both to Neon.
- codelab_project_record_video: record the actual CodeLab project route in Chromium as WebM for 1–30 seconds; optionally upload it to Neon.
- pixelforge_export_animation_video: open the actual PixelForge editor with the saved project ID, activate its native animation playback in headless capture mode, and record the editor canvas/UI in Chromium. It preserves the saved frame order, frame durations and timeline FPS. Output is capped at 240 frames, 60 seconds and 24 MiB of video.
- PNG capture remains provided by the existing real-Chromium capture action. Existing PixelForge structured animation editing remains approval-gated through proposal/approve commands.

## Video artifact storage

For durable video output, the command may include a trusted Neon presigned uploadTarget. The assistant should request a short-lived upload URL through Neon Storage's presign_storage_object action (operation=upload, content_type=video/webm) and pass its URL with the intended objectKey. The worker accepts HTTPS uploads only to the configured Neon storage host, public capture bucket, and exact object key under pixelforge/exports/. The result includes a publicUrl for later inspection. Without an upload target, small videos (up to 8 MiB) are returned inline as base64; larger videos fail clearly instead of bloating PostgreSQL command rows.

The PixelForge video is captured from the actual PixelForge editor running in Chromium, using its own playback engine rather than a synthetic frame slideshow. The editor's headless capture mode starts one native playback cycle and stops without saving or mutating the project. Frame timing follows the saved durationMs values, and Playwright's WebM recorder is configured with the source timeline FPS (or the requested FPS for CodeLab web projects).

## Security and operational constraints

- All commands are scoped to the ADMIN workspace resolved from the same database.
- The worker checks workspace ownership and command expiry before dispatch.
- Code updates only permit the html, css, and js fields.
- Video upload URLs are checked for HTTPS, exact storage host, bucket, and object key.
- Proposal-based raster/design changes retain explicit approval; the client does not auto-approve them.
- The native worker still requires DATABASE_URL and CODELAB_AGENT_BRIDGE_ENABLED not set to 0. Runtime requirements: Node.js 22.17 or newer (matching @sparticuz/chromium 153), plus the Playwright FFmpeg binary. The cross-platform package postinstall script installs FFmpeg into node_modules/.local-browsers; server startup sets PLAYWRIGHT_BROWSERS_PATH=0 so the worker resolves that packaged binary. CI installs it explicitly because dependency scripts are disabled there. The assistant client also needs network access to CODELAB_BASE_URL (defaults to the current CodeLab Render URL) so it can wake the app before queueing work.
- Run npm run test:native-headless to execute the focused native bridge contract tests.
