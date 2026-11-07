import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../agent-bridge-worker.mjs', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('CodeLab browser QA runs against the persisted project HTML with Chromium', () => {
  assert.match(worker, /async function captureCodeLabProjectBrowser\(/);
  assert.match(worker, /playwrightChromium\.launch/);
  assert.match(worker, /page\.setContent\(html/);
  assert.match(worker, /captureMethod: 'playwright-chromium-saved-html-and-public-route'/);
});

test('CodeLab browser QA covers desktop and mobile and tests the actual CTA click', () => {
  assert.match(worker, /name: 'desktop', width: 1440, height: 1000/);
  assert.match(worker, /name: 'mobile', width: 390, height: 844/);
  assert.match(worker, /await page\.setViewportSize/);
  assert.match(worker, /const context = await browser\.newContext/);
  assert.doesNotMatch(worker, /for \(const viewport of viewports\)[\s\S]{0,500}browser\.newContext/);
  assert.match(worker, /button\.click\(\{ timeout: 5000 \}\)/);
  assert.match(worker, /Interacción funcionando/);
  assert.match(worker, /noHorizontalOverflow/);
  assert.match(worker, /mobileControlsReadable/);
  assert.match(worker, /design-layer-heading/);
  assert.match(worker, /design-layer-button/);
  assert.match(worker, /font-size:clamp\(28px,7vw,40px\)/);
  assert.match(worker, /max-width:320px/);
  assert.match(worker, /noPageErrors/);
});

test('CodeLab browser QA returns viewable PNG evidence and is opt-in on project inspection', () => {
  assert.match(worker, /dataBase64: screenshot\.toString\('base64'\)/);
  assert.match(worker, /dataBase64: routeScreenshot\.toString\('base64'\)/);
  assert.match(worker, /command\.payload\?\.browser_test === true/);
  assert.match(worker, /inspection\.browserTest = await captureCodeLabProjectBrowser/);
});

test('CodeLab public route QA authenticates ADMIN, tests preview, reload, and sandbox restrictions', () => {
  assert.match(worker, /localStorage\.setItem\('codelab_xd_workspace_v4', id\)/);
  assert.match(worker, /workspaceTokenFor\(workspaceId\)/);
  assert.match(worker, /step = 'set-route-desktop-viewport';[\s\S]{0,100}page\.setViewportSize\(\{ width: 1440, height: 1000 \}\)/);
  assert.match(worker, /page\.goto\(routeUrl/);
  assert.match(worker, /getElementById\('currentProjectTitle'\)/);
  assert.match(worker, /frameLocator\('#previewIframe'\)/);
  assert.match(worker, /page\.reload\(\{ waitUntil: 'domcontentloaded', timeout: 45000 \}\)/);
  assert.match(worker, /reloadRestoresProject/);
  assert.match(worker, /set-route-mobile-viewport/);
  assert.match(worker, /mobileLayoutPasses/);
  assert.match(worker, /public-route-mobile/);
  assert.match(worker, /#mobileTabPreview/);
  assert.match(worker, /switch-mobile-to-preview/);
  assert.match(worker, /previewTabSwitchWorks/);
  assert.match(worker, /codeTabRestoresEditor/);
  assert.match(worker, /toolbarControlsDoNotOverlap/);
  assert.match(worker, /toolbarActionsTouchSized/);
  assert.match(worker, /toolbarScrollsInsteadOfShrinking/);
  assert.match(worker, /public-route-desktop/);
  assert.match(worker, /expectedSandboxPageErrors/);
  assert.match(worker, /sandboxIsolationConfirmed/);
  assert.match(worker, /unexpectedPageErrors/);
});

test('CodeLab studio navigation header closes before the main workspace layout', () => {
  const studioStart = indexHtml.indexOf('id="studioView"');
  const headerStart = indexHtml.indexOf('<header', studioStart);
  const mainStart = indexHtml.indexOf('<main id="mainSplit"', studioStart);
  const headerEnd = indexHtml.indexOf('</header>', headerStart);
  assert.ok(studioStart >= 0, 'studioView exists');
  assert.ok(headerStart > studioStart, 'studio navigation header exists');
  assert.ok(headerEnd > headerStart && headerEnd < mainStart, 'studio header closes before mainSplit');
});

test('Native mailbox leases are workspace-scoped, expire dead commands, and heartbeat active work', () => {
  assert.match(worker, /status IN \('queued','running'\) AND expires_at <= now\(\)/);
  assert.match(worker, /WHERE workspace_id=\$1 AND status='running' AND updated_at < now\(\) - interval '3 minutes'/);
  assert.match(worker, /heartbeatTimer = setInterval/);
  assert.match(worker, /SET updated_at=now\(\) WHERE command_id=\$1 AND workspace_id=\$2 AND status='running'/);
  assert.match(worker, /clearInterval\(heartbeatTimer\)/);
});

test('Native mailbox supports navigation between different layers in the same project', () => {
  const connect = worker.match(/async function connectCodeLabProject\(command\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(connect, /payload\.target_element_id/);
  assert.match(connect, /A same-canvas connection must identify a different target element/);
  assert.match(connect, /sourceElementId === targetElementId/);
  assert.match(connect, /targetProject\.design\.elements\.some/);
  assert.match(connect, /targetElementId \? item\.targetElementId === targetElementId/);
  assert.doesNotMatch(connect, /sourceProjectId === targetProjectId\) throw new Error/);
});

test('CodeLab web export preserves full same-canvas dimensions and navigation targets', () => {
  const exporter = worker.match(/function exportDesignToHtml\(project\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(exporter, /Math\.min\(4000, Number\(design\.canvasWidth/);
  assert.match(exporter, /design\.flowConnections/);
  assert.match(exporter, /targetProjectId === project\.id/);
  assert.match(exporter, /data-flow-to-element/);
  assert.match(exporter, /outputId\(targetElementId\)/);
  assert.match(exporter, /scrollIntoView/);
  assert.match(exporter, /w>window\.innerWidth/);
  assert.match(exporter, /overflow:auto/);
});

test('CodeLab browser QA handles multi-heading designs without strict locator failures', () => {
  assert.match(worker, /preview\.locator\('h1'\)\.first\(\)\.waitFor/);
  assert.match(worker, /reloadedPreview\.locator\('h1'\)\.first\(\)\.waitFor/);
  assert.match(worker, /mobilePreviewHeading === routeHeading/);
});

test('CodeLab browser QA clicks every same-canvas navigation link in saved HTML and deployed preview', () => {
  assert.match(worker, /require_flow_navigation/);
  assert.match(worker, /flowLinks\.count\(\)/);
  assert.match(worker, /routeFlowLinks\.count\(\)/);
  assert.match(worker, /navigationLinkPresent/);
  assert.match(worker, /navigationWorks/);
  assert.match(worker, /routeNavigationWorks/);
});

test('Mobile web workspace toolbar actions keep a minimum 44px touch target after cascade overrides', () => {
  assert.match(indexHtml, /#webWorkspaceToolbar \.web-action \{\s*min-height: 44px !important;\s*height: 44px !important;/);
  assert.doesNotMatch(indexHtml, /#webWorkspaceToolbar \.web-action \{\s*min-height: 40px !important;/);
});

test('CodeLab browser QA captures the actual same-canvas node graph on desktop and mobile', () => {
  assert.match(worker, /openDesignFlowGraph/);
  assert.match(worker, /designFlowGraphModal/);
  assert.match(worker, /designFlowOverview/);
  assert.match(worker, /data-flow-action="hero-cta"/);
  assert.match(worker, /data-flow-target-element="catalog-title"/);
  assert.match(worker, /path\[data-connection\]/);
  assert.match(worker, /design-flow-graph-desktop/);
  assert.match(worker, /design-flow-graph-mobile/);
  assert.match(worker, /designFlowConnectionsVisible/);
  assert.match(worker, /designFlowGraphMobileFits/);
});
