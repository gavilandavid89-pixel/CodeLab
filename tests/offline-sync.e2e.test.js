const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const PROJECTS_KEY = 'codelab_xd_projects_v2';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    await context.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.__codelabIntervalCallbacks = [];
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 15000 && typeof callback === 'function') {
          window.__codelabIntervalCallbacks.push({ callback, delay });
        }
        return nativeSetInterval(callback, delay, ...args);
      };
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() =>
      document.getElementById('syncLoadingModal')?.classList.contains('hidden') &&
      window.codelabWorkspaceReady === true,
      null,
      { timeout: 20000 }
    );

    const initial = await page.evaluate(async () => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
        headers: { 'x-workspace-token': token }
      });
      if (!response.ok) throw new Error('Could not read initial workspace: ' + response.status);
      const remote = await response.json();
      if (!Array.isArray(remote.projects) || remote.projects.length === 0) {
        throw new Error('Expected at least one initial project to test offline recovery');
      }
      return { workspaceId, token, projectId: remote.projects[0].id, initialCount: remote.projects.length };
    });

    await context.setOffline(true);
    const firstOfflineSave = await page.evaluate(async projectId => {
      const project = projects.find(item => item.id === projectId);
      if (!project) throw new Error('Test project disappeared before offline save');
      project.code.html = '<main id="offline-first">Primera versión sin conexión</main>';
      project.updatedAt = new Date(Date.now() + 1000).toISOString();
      const ok = await persistWorkspace();
      const stored = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || '[]');
      return {
        ok,
        localHtml: stored.find(item => item.id === projectId)?.code?.html,
        statusText: document.getElementById('statusText')?.textContent || '',
        serverReady
      };
    }, initial.projectId);
    assert.equal(firstOfflineSave.ok, false, 'A save during a real browser network outage must report that server sync did not complete');
    assert.match(firstOfflineSave.localHtml || '', /offline-first/, 'The first offline edit must be retained in localStorage');
    assert.equal(firstOfflineSave.serverReady, false, 'A failed network request must mark the server as unavailable');
    assert.match(firstOfflineSave.statusText, /Solo local|Reintento pendiente/, 'The status indicator must not claim the offline save was synchronized');

    const newerOfflineSave = await page.evaluate(projectId => {
      const project = projects.find(item => item.id === projectId);
      project.code.html = '<main id="offline-newest">Versión más reciente guardada sin conexión</main>';
      project.updatedAt = new Date(Date.now() + 5000).toISOString();
      saveLocalProjectsSnapshot();
      const stored = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || '[]');
      return {
        localHtml: stored.find(item => item.id === projectId)?.code?.html,
        projectCount: stored.length,
        uniqueIds: new Set(stored.map(item => item.id)).size
      };
    }, initial.projectId);
    assert.match(newerOfflineSave.localHtml || '', /offline-newest/, 'A newer offline edit must replace the older local version');
    assert.equal(newerOfflineSave.projectCount, initial.initialCount, 'Offline editing must not create duplicate projects');
    assert.equal(newerOfflineSave.uniqueIds, newerOfflineSave.projectCount, 'Local project IDs must remain unique during offline saves');

    await context.setOffline(false);
    const reconnectCallbackCount = await page.evaluate(() => window.__codelabIntervalCallbacks.length);
    assert.ok(reconnectCallbackCount > 0, 'The real reconnect loop must be registered');
    await page.evaluate(async () => {
      const reconnect = window.__codelabIntervalCallbacks.find(item => item.delay === 15000);
      if (!reconnect) throw new Error('Reconnect callback was not captured');
      await reconnect.callback();
    });

    await page.waitForFunction(async ({ workspaceId, token, projectId }) => {
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const state = await response.json();
        const project = state.projects.find(item => item.id === projectId);
        return !!project && typeof project.code?.html === 'string' &&
          project.code.html.includes('offline-newest');
      } catch (_) {
        return false;
      }
    }, { workspaceId: initial.workspaceId, token: initial.token, projectId: initial.projectId }, { timeout: 15000 });

    const finalState = await page.evaluate(async ({ workspaceId, token, projectId }) => {
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
        headers: { 'x-workspace-token': token }
      });
      if (!response.ok) throw new Error('Could not read final workspace: ' + response.status);
      const remote = await response.json();
      const local = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || '[]');
      const project = remote.projects.find(item => item.id === projectId);
      return {
        remoteCount: remote.projects.length,
        remoteUniqueIds: new Set(remote.projects.map(item => item.id)).size,
        remoteHtml: project?.code?.html || '',
        localCount: local.length,
        localUniqueIds: new Set(local.map(item => item.id)).size,
        statusText: document.getElementById('statusText')?.textContent || '',
        serverReady
      };
    }, { workspaceId: initial.workspaceId, token: initial.token, projectId: initial.projectId });

    assert.match(finalState.remoteHtml, /offline-newest/, 'Reconnect must upload the newest local edit, not overwrite it with the stale server copy');
    assert.equal(finalState.remoteCount, initial.initialCount, 'Reconnect must not duplicate projects on the server');
    assert.equal(finalState.remoteUniqueIds, finalState.remoteCount, 'Server project IDs must remain unique after retry');
    assert.equal(finalState.localCount, initial.initialCount, 'Local project count must remain stable after reconnect');
    assert.equal(finalState.localUniqueIds, finalState.localCount, 'Local project IDs must remain unique after reconnect');
    assert.equal(finalState.serverReady, true, 'The workspace must return to a connected state after recovery');
    assert.match(finalState.statusText, /Sincronizado|Reconectado/, 'The status indicator must reflect successful recovery');
    assert.deepEqual(pageErrors, [], 'Offline save and reconnect recovery must not throw browser runtime errors');

    console.log('Offline save/reconnect E2E passed: local retention, honest sync status, latest-edit-wins recovery, and duplicate-project checks.');
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
