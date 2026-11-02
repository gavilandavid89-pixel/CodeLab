const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const PROJECT_NAME = 'Flujo integral E2E ' + Date.now();

async function waitForPersistedProject(page, projectName) {
  await page.waitForFunction(async name => {
    const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
    const token = localStorage.getItem('codelab_xd_workspace_token_v1');
    if (!workspaceId || !token) return false;
    try {
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
        headers: { 'x-workspace-token': token }
      });
      if (!response.ok) return false;
      const data = await response.json();
      return Array.isArray(data.projects) && data.projects.some(project =>
        project.name === name &&
        project.type === 'design' &&
        project.design &&
        project.design.elements.some(element => element.text === 'Prueba integral CodeLab')
      );
    } catch (_) {
      return false;
    }
  }, projectName, { timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      acceptDownloads: true
    });
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });

    // The project preview runs scripts in an opaque-origin sandbox. It must not
    // gain same-origin access or let unrelated windows spoof console entries.
    const previewSandbox = await page.locator('#previewIframe').getAttribute('sandbox');
    assert.ok(previewSandbox && !previewSandbox.includes('allow-same-origin'),
      'Preview must not share the app origin or expose its localStorage credentials');
    await page.evaluate(() => window.postMessage({
      type: 'CONSOLE_LOG', logType: 'error', message: 'SPOOFED_CONSOLE_MESSAGE'
    }, '*'));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#consoleOutput').getByText('SPOOFED_CONSOLE_MESSAGE', { exact: true }).count(), 0,
      'The app must ignore console messages not sent by its own preview iframe');
    await page.evaluate(() => updatePreview());
    // The preview iframe is inside a hidden studio panel during dashboard boot;
    // wait for its document to attach, not for the hidden body to become visible.
    await page.frameLocator('#previewIframe').locator('body').waitFor({ state: 'attached' });
    await page.frameLocator('#previewIframe').locator('body').evaluate(() => {
      window.parent.postMessage({
        type: 'CONSOLE_LOG', logType: 'log', message: 'TRUSTED_PREVIEW_MESSAGE'
      }, '*');
    });
    await page.waitForFunction(() =>
      document.getElementById('consoleOutput')?.textContent.includes('TRUSTED_PREVIEW_MESSAGE')
    , null, { timeout: 3000 });

    // Project creation must respect the same configurable cap enforced by the API.
    const projectLimitCheck = await page.evaluate(() => {
      const previousLimit = maxProjects;
      const before = projects.length;
      maxProjects = before;
      openNewProjectModal();
      document.getElementById('newProjectNameInput').value = 'No debe crearse por límite';
      createNewProjectConfirm();
      const after = projects.length;
      closeNewProjectModal();
      maxProjects = previousLimit;
      return { before, after };
    });
    assert.equal(projectLimitCheck.after, projectLimitCheck.before,
      'The UI must prevent creating a project when the workspace has reached its server-configured limit');

    // Creating either project type must persist locally before opening the editor,
    // and a failed server sync must be reported as local-only rather than success.
    const createFailureFeedbackCheck = await page.evaluate(async () => {
      const saved = {
        projects: projects.slice(), maxProjects, currentProjectId, currentUser,
        saveProjectsToStorage, saveLocalProjectsSnapshot, showToast,
        renderProjectsList, openProject, closeNewProjectModal,
        inCopyBranch, isCopyBranchCreated
      };
      const originalProjectIds = projects.map(project => project.id);
      let localSnapshotCalled = false;
      let openedId = null;
      let toast = '';
      try {
        maxProjects = Math.max(maxProjects, projects.length + 2);
        saveLocalProjectsSnapshot = () => {
          localSnapshotCalled = true;
          return lsSet(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
        };
        saveProjectsToStorage = async () => false;
        showToast = message => { toast = message; };
        renderProjectsList = () => {};
        openProject = id => { openedId = id; };
        document.querySelector('input[name="newProjectType"][value="web"]').checked = true;
        document.getElementById('newProjectNameInput').value = 'Proyecto web offline E2E';
        await createNewProjectConfirm();
        const created = projects.find(project => project.name === 'Proyecto web offline E2E');
        const raw = JSON.parse(lsGet(STORAGE_KEY_PROJECTS) || '[]');
        const persistedLocally = Array.isArray(raw) && raw.some(project => project.id === created?.id);
        const webHasBothSpaces = !!created?.code && !!created?.design && created?.hasWebSpace === true && created?.hasDesignSpace === true;
        document.querySelector('input[name="newProjectType"][value="design"]').checked = true;
        document.getElementById('newProjectNameInput').value = 'Proyecto diseño offline E2E';
        await createNewProjectConfirm();
        const designCreated = projects.find(project => project.name === 'Proyecto diseño offline E2E');
        const designHasBothSpaces = !!designCreated?.code && !!designCreated?.design && designCreated?.hasWebSpace === true && designCreated?.hasDesignSpace === true;
        const feedbackIsHonest = /guardado localmente|sincronización queda pendiente/i.test(toast);
        return { localSnapshotCalled, createdType: created?.type, persistedLocally, openedMatchesCreated: openedId === designCreated?.id,
          feedbackIsHonest, webHasBothSpaces, designCreatedType: designCreated?.type, designHasBothSpaces };
      } finally {
        projects = saved.projects;
        maxProjects = saved.maxProjects;
        currentProjectId = saved.currentProjectId;
        currentUser = saved.currentUser;
        saveProjectsToStorage = saved.saveProjectsToStorage;
        saveLocalProjectsSnapshot = saved.saveLocalProjectsSnapshot;
        showToast = saved.showToast;
        renderProjectsList = saved.renderProjectsList;
        openProject = saved.openProject;
        closeNewProjectModal = saved.closeNewProjectModal;
        inCopyBranch = saved.inCopyBranch;
        isCopyBranchCreated = saved.isCopyBranchCreated;
        localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
      }
    });
    assert.equal(createFailureFeedbackCheck.localSnapshotCalled, true, 'project creation must attempt a local snapshot before sync');
    assert.equal(createFailureFeedbackCheck.createdType, 'web', 'the selected web project type must be retained');
    assert.equal(createFailureFeedbackCheck.persistedLocally, true, 'a server failure must not leave the new project only in memory');
    assert.equal(createFailureFeedbackCheck.openedMatchesCreated, true, 'the newly created project should open after the local snapshot attempt');
    assert.equal(createFailureFeedbackCheck.feedbackIsHonest, true, 'failed server sync must be reported as local-only');
    assert.equal(createFailureFeedbackCheck.webHasBothSpaces, true, 'projects created from Web must also initialize the Design workspace');
    assert.equal(createFailureFeedbackCheck.designCreatedType, 'design', 'the selected Design editor should open initially');
    assert.equal(createFailureFeedbackCheck.designHasBothSpaces, true, 'projects created from Design must also initialize the Web workspace');

    // OAuth local import must obey the same project cap as manual creation.
    const importLimitCheck = await page.evaluate(() => {
      const saved = {
        currentUser,
        projects,
        pendingLocalImportProjects,
        maxProjects,
        saveProjectsToStorage,
        renderProjectsList,
        showToast,
        storePendingLocalImport,
        lsRemove,
        confirm: window.confirm,
        pendingStorage: localStorage.getItem('codelab_xd_pending_local_import_v1')
      };
      try {
        currentUser = { real: true, provider: 'e2e', id: 'import-limit' };
        projects = [{ id: 'existing-project', name: 'Existente', code: { html: '', css: '', js: '' } }];
        pendingLocalImportProjects = [
          { id: 'import-one', name: 'Uno', code: { html: '<p>1</p>' } },
          { id: 'import-two', name: 'Dos', code: { html: '<p>2</p>' } },
          { id: 'import-two', name: 'Dos duplicado', code: { html: '<p>duplicado</p>' } },
          { id: 'import-three', name: 'Tres', code: { html: '<p>3</p>' } }
        ];
        maxProjects = 3;
        let preservedPending = [];
        saveProjectsToStorage = () => {};
        renderProjectsList = () => {};
        showToast = () => {};
        storePendingLocalImport = value => { preservedPending = value; pendingLocalImportProjects = value; return true; };
        lsRemove = () => {};
        window.confirm = () => true;
        maybeOfferLocalImport();
        return { count: projects.length, importedIds: projects.map(project => project.id), preservedPending };
      } finally {
        currentUser = saved.currentUser;
        projects = saved.projects;
        pendingLocalImportProjects = saved.pendingLocalImportProjects;
        maxProjects = saved.maxProjects;
        saveProjectsToStorage = saved.saveProjectsToStorage;
        renderProjectsList = saved.renderProjectsList;
        showToast = saved.showToast;
        storePendingLocalImport = saved.storePendingLocalImport;
        lsRemove = saved.lsRemove;
        window.confirm = saved.confirm;
        if (saved.pendingStorage === null) localStorage.removeItem('codelab_xd_pending_local_import_v1');
        else localStorage.setItem('codelab_xd_pending_local_import_v1', saved.pendingStorage);
      }
    });
    assert.equal(importLimitCheck.count, 3,
      'Local OAuth import must not exceed the configured project cap');
    assert.ok(importLimitCheck.importedIds.includes('existing-project'),
      'Local OAuth import must preserve existing account projects');
    assert.equal(new Set(importLimitCheck.importedIds).size, importLimitCheck.importedIds.length,
      'Local OAuth import must deduplicate IDs within the imported snapshot');
    assert.equal(importLimitCheck.preservedPending.length, 1,
      'Projects omitted because of the cap must remain recoverable for a later import');

    // If overflow cannot be persisted, abort before replacing the original snapshot.
    const failedPendingImportCheck = await page.evaluate(() => {
      const saved = {
        currentUser, projects, pendingLocalImportProjects, maxProjects,
        saveProjectsToStorage, renderProjectsList, showToast,
        storePendingLocalImport, lsRemove, confirm: window.confirm
      };
      let saveCalls = 0;
      let toast = '';
      try {
        currentUser = { real: true, provider: 'e2e', id: 'import-storage-failure' };
        projects = [{ id: 'account-existing', name: 'Existente', code: { html: '' } }];
        pendingLocalImportProjects = [
          { id: 'overflow-one', name: 'Pendiente 1', code: { html: '' } },
          { id: 'overflow-two', name: 'Pendiente 2', code: { html: '' } }
        ];
        maxProjects = 2;
        saveProjectsToStorage = () => { saveCalls++; };
        renderProjectsList = () => {};
        showToast = message => { toast = message; };
        storePendingLocalImport = () => false;
        lsRemove = () => {};
        window.confirm = () => true;
        maybeOfferLocalImport();
        return { ids: projects.map(project => project.id), saveCalls, warned: toast.includes('No se pudo guardar') };
      } finally {
        currentUser = saved.currentUser;
        projects = saved.projects;
        pendingLocalImportProjects = saved.pendingLocalImportProjects;
        maxProjects = saved.maxProjects;
        saveProjectsToStorage = saved.saveProjectsToStorage;
        renderProjectsList = saved.renderProjectsList;
        showToast = saved.showToast;
        storePendingLocalImport = saved.storePendingLocalImport;
        lsRemove = saved.lsRemove;
        window.confirm = saved.confirm;
      }
    });
    assert.deepEqual(failedPendingImportCheck.ids, ['account-existing'],
      'Failed pending-import persistence must abort before mutating account projects');
    assert.equal(failedPendingImportCheck.saveCalls, 0,
      'Failed pending-import persistence must not overwrite the source snapshot');
    assert.equal(failedPendingImportCheck.warned, true,
      'Failed pending-import persistence must explain that the import was aborted');

    // Logout must not erase the account snapshot if neither server sync nor the
    // account-scoped recovery store can preserve unsynced work.
    const failedLogoutRecoveryCheck = await page.evaluate(async () => {
      const saved = {
        currentUser, projects, pendingLocalImportProjects, persistWorkspace,
        storePendingLocalImport, showToast, fetch: window.fetch
      };
      let toast = '';
      let fetchCalls = 0;
      try {
        currentUser = { real: true, provider: 'e2e', id: 'logout-storage-failure' };
        projects = [{ id: 'unsynced-project', name: 'No perder', code: { html: '<p>trabajo</p>' } }];
        pendingLocalImportProjects = null;
        persistWorkspace = async () => false;
        storePendingLocalImport = () => false;
        showToast = message => { toast = message; };
        window.fetch = async () => { fetchCalls++; return { ok: true }; };
        await logoutAuth();
        return {
          stillAuthenticated: !!currentUser && currentUser.real,
          projectIds: projects.map(project => project.id),
          fetchCalls,
          warned: toast.includes('no se pudieron proteger')
        };
      } finally {
        currentUser = saved.currentUser;
        projects = saved.projects;
        pendingLocalImportProjects = saved.pendingLocalImportProjects;
        persistWorkspace = saved.persistWorkspace;
        storePendingLocalImport = saved.storePendingLocalImport;
        showToast = saved.showToast;
        window.fetch = saved.fetch;
      }
    });
    assert.equal(failedLogoutRecoveryCheck.stillAuthenticated, true,
      'Logout must be aborted when unsynced work cannot be persisted for recovery');
    assert.deepEqual(failedLogoutRecoveryCheck.projectIds, ['unsynced-project'],
      'Logout must preserve the active in-memory project list on recovery failure');
    assert.equal(failedLogoutRecoveryCheck.fetchCalls, 0,
      'Logout must not invalidate the server session before recovery is secured');
    assert.equal(failedLogoutRecoveryCheck.warned, true,
      'Aborted logout must explain how to recover safely');

    // 1. Create and open a real design project through the production dashboard.
    await page.locator('button[onclick="openNewProjectModal()"]').click();
    await page.locator('#newProjectNameInput').fill(PROJECT_NAME);
    await page.locator('input[name="newProjectType"][value="design"]').check();
    await page.locator('button[onclick="createNewProjectConfirm()"]').click();
    await page.waitForFunction(() => {
      const studio = document.getElementById('studioView');
      const design = document.getElementById('designStudioPanel');
      return studio && !studio.classList.contains('hidden') &&
        design && !design.classList.contains('hidden');
    }, { timeout: 10000 });
    assert.equal(await page.locator('#designCanvas [data-design-id]').count(), 0,
      'new design project should start with an empty canvas');
    const originalDesignProjectId = await page.evaluate(() => getCurrentProject().id);

    // The second creation choice must open the code editor, not the design studio.
    // Then return to the dashboard and reopen the original design without mixing state.
    await page.evaluate(() => returnToDashboard());
    await page.waitForSelector('#welcomeDashboard:not(.hidden)');
    await page.locator('button[onclick="openNewProjectModal()"]').click();
    await page.locator('#newProjectNameInput').fill('Flujo integral web E2E');
    await page.locator('input[name="newProjectType"][value="web"]').check();
    await page.locator('button[onclick="createNewProjectConfirm()"]').click();
    await page.waitForFunction(() => {
      const studio = document.getElementById('studioView');
      const editor = document.getElementById('editorPanel');
      const design = document.getElementById('designStudioPanel');
      return studio && !studio.classList.contains('hidden') &&
        editor && !editor.classList.contains('hidden') &&
        design && design.classList.contains('hidden') &&
        getCurrentProject()?.type === 'web';
    }, null, { timeout: 10000 });
    assert.equal(await page.locator('#newProjectModal').evaluate(node => node.classList.contains('hidden')), true,
      'creation modal should close after the save attempt settles');

    const renameLimitCheck = await page.evaluate(async () => {
      const originalPrompt = window.prompt;
      const originalToast = showToast;
      const originalName = getCurrentProject().name;
      let toast = '';
      try {
        window.prompt = () => 'x'.repeat(201);
        showToast = message => { toast = message; };
        await editCurrentProjectName();
        return {
          nameUnchanged: getCurrentProject().name === originalName,
          warned: /200 caracteres/i.test(toast)
        };
      } finally {
        window.prompt = originalPrompt;
        showToast = originalToast;
      }
    });
    assert.equal(renameLimitCheck.nameUnchanged, true, 'renaming must enforce the same 200-character limit as creation');
    assert.equal(renameLimitCheck.warned, true, 'an overlong project name must explain the limit');

    // AI output must obey the same per-file limit as manual tools/server saves.
    await page.evaluate(() => {
      window.__e2eOversizedAiOriginals = {
        aiCanUseRemote,
        callRemoteAi
      };
      window.__e2eOversizedAiBefore = getEditorValue('html');
      aiCanUseRemote = () => true;
      callRemoteAi = async () => ({ html: 'x'.repeat(500001), css: '', js: '', message: 'oversized fixture' });
      document.getElementById('aiPromptInput').value = 'Genera una interfaz muy grande';
      processAiInstruction();
    });
    await page.waitForFunction(() =>
      /supera el límite de 500000 caracteres/i.test(document.getElementById('aiChatHistory')?.textContent || ''),
      null, { timeout: 10000 });
    const oversizedAiCheck = await page.evaluate(() => {
      const unchanged = getEditorValue('html') === window.__e2eOversizedAiBefore;
      aiCanUseRemote = window.__e2eOversizedAiOriginals.aiCanUseRemote;
      callRemoteAi = window.__e2eOversizedAiOriginals.callRemoteAi;
      delete window.__e2eOversizedAiOriginals;
      delete window.__e2eOversizedAiBefore;
      return { unchanged };
    });
    assert.equal(oversizedAiCheck.unchanged, true, 'oversized AI output must not mutate the active editor');

    // AI-generated interfaces must await persistence and clearly distinguish a
    // confirmed local save from a server sync that is still pending.
    await page.evaluate(() => {
      window.__e2eAiSaveOriginals = {
        persistWorkspace,
        aiCanUseRemote,
        confirm: window.confirm
      };
      aiCanUseRemote = () => false;
      window.confirm = () => true;
      persistWorkspace = () => {
        saveLocalProjectsSnapshot();
        return Promise.resolve(false);
      };
      document.getElementById('aiPromptInput').value = 'landing';
      processAiInstruction();
    });
    await page.waitForFunction(() =>
      /guardado localmente; la sincronización queda pendiente/i.test(document.getElementById('aiChatHistory')?.textContent || ''),
      null, { timeout: 10000 });
    const generatedInterfaceSaveCheck = await page.evaluate(() => {
      const project = getCurrentProject();
      const snapshot = JSON.parse(localStorage.getItem(STORAGE_KEY_PROJECTS) || 'null');
      const stored = Array.isArray(snapshot) && snapshot.find(item => item && item.id === project?.id);
      const originals = window.__e2eAiSaveOriginals;
      if (originals) {
        persistWorkspace = originals.persistWorkspace;
        aiCanUseRemote = originals.aiCanUseRemote;
        window.confirm = originals.confirm;
        delete window.__e2eAiSaveOriginals;
      }
      return {
        generatedLanding: /Construye el Futuro/.test(project?.code?.html || ''),
        localCopyMatches: /Construye el Futuro/.test(stored?.code?.html || ''),
        honestFeedback: /guardado localmente; la sincronización queda pendiente/i.test(document.getElementById('aiChatHistory')?.textContent || '')
      };
    });
    assert.equal(generatedInterfaceSaveCheck.generatedLanding, true, 'the local interface generator should apply its landing template');
    assert.equal(generatedInterfaceSaveCheck.localCopyMatches, true, 'generated interface code must be present in the durable local snapshot');
    assert.equal(generatedInterfaceSaveCheck.honestFeedback, true, 'the AI panel must not claim server synchronization when the save was local-only');

    await page.evaluate(() => returnToDashboard());
    await page.waitForSelector('#welcomeDashboard:not(.hidden)');
    const webProjectCard = page.locator('#projectsGrid > div').filter({ hasText: 'Flujo integral web E2E' }).first();
    await webProjectCard.locator('button[data-action="dup"]').dblclick();
    await page.waitForFunction(() => {
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || '[]');
      return Array.isArray(snapshot) &&
        snapshot.filter(project => project.name === 'Flujo integral web E2E (Copia)').length === 1 &&
        snapshot.some(project => project.name === 'Flujo integral web E2E (Copia)' &&
          project.type === 'web' && project.hasWebSpace === true && project.hasDesignSpace === true &&
          project.design && Array.isArray(project.design.elements) &&
          /Construye el Futuro/.test(project.code?.html || ''));
    }, null, { timeout: 10000 });
    await page.locator('#projectsGrid > div').filter({ hasText: 'Flujo integral web E2E (Copia)' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#projectsGrid > div').filter({ has: page.locator('h4').getByText(PROJECT_NAME, { exact: true }) }).locator('button[data-action="open"]').click();
    await page.waitForFunction(() => {
      const design = document.getElementById('designStudioPanel');
      return design && !design.classList.contains('hidden') &&
        getCurrentProject()?.type === 'design';
    }, null, { timeout: 10000 });

    // The canvas size controls must be available in the Inspector before any layer is selected.
    assert.equal(await page.locator('#designCanvasWidth').count(), 1, 'Inspector must expose canvas width with no selected layer');
    assert.equal(await page.locator('#designCanvasHeight').count(), 1, 'Inspector must expose canvas height with no selected layer');
    await page.locator('#designCanvasWidth').evaluate(input => {
      input.value = '720';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('designCanvas')?.style.width === '720px');
    await page.locator('#designCanvasHeight').evaluate(input => {
      input.value = '1600';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('designCanvas')?.style.height === '1600px');
    assert.equal(await page.locator('#designCanvasWidth').inputValue(), '720', 'Inspector should retain custom canvas width');
    assert.equal(await page.locator('#designCanvasHeight').inputValue(), '1600', 'Inspector should retain custom canvas height');
    await page.locator('button[onclick="resetDesignCanvasDimensions()"]').click();
    await page.waitForFunction(() => {
      const canvas = document.getElementById('designCanvas');
      return canvas?.style.width === '1440px' && canvas?.style.height === '900px';
    });
    assert.equal(await page.locator('#designCanvasHeight').inputValue(), '', 'reset should restore automatic canvas height');
    // The custom-size edits intentionally create undo history; clear it so the
    // independent layer-limit assertion starts from a clean history state.
    await page.evaluate(() => {
      const project = getCurrentProject();
      project.designUndoStack = [];
      project.designRedoStack = [];
      designUndoStack = [];
      designRedoStack = [];
    });

    const layerLimitCheck = await page.evaluate(() => {
      const project = window.activeDesignProject();
      project.design = [];
      const normalized = window.activeDesignProject();
      const designShapeValid = !Array.isArray(normalized.design) && Array.isArray(normalized.design.elements);
      normalized.design.elements = Array.from({ length: 500 }, (_, index) => ({
        id: 'limit-layer-' + index, type: 'heading', label: 'Layer ' + index, text: 'Layer'
      }));
      window.addDesignElement('heading');
      const countAfterAdd = normalized.design.elements.length;
      selectedDesignElementId = 'limit-layer-0';
      selectedDesignElementIds = ['limit-layer-0'];
      window.duplicateDesignElement();
      const countAfterDuplicate = normalized.design.elements.length;
      normalized.design.elements = [
        { id: 'overlap-a', x: 0, y: 0, width: 200, height: 100 },
        { id: 'overlap-b', x: 10, y: 0, width: 200, height: 100 },
        { id: 'overlap-c', x: 20, y: 0, width: 200, height: 100 }
      ];
      selectedDesignElementIds = ['overlap-a', 'overlap-b', 'overlap-c'];
      designUndoStack = [];
      window.distributeDesignElements('horizontal');
      const undoStepsAfterRejectedDistribution = designUndoStack.length;
      normalized.design.elements = [];
      selectedDesignElementId = null;
      selectedDesignElementIds = [];
      window.renderDesignWorkspace();
      return { countAfterAdd, countAfterDuplicate, designShapeValid, undoStepsAfterRejectedDistribution };
    });
    assert.equal(layerLimitCheck.designShapeValid, true,
      'Malformed array-valued design state must normalize to a valid design object');
    assert.equal(layerLimitCheck.countAfterAdd, 500,
      'Adding a layer beyond the visual-design limit must be blocked without mutating the project');
    assert.equal(layerLimitCheck.countAfterDuplicate, 500,
      'Duplicating a layer beyond the visual-design limit must be blocked too');
    assert.equal(layerLimitCheck.undoStepsAfterRejectedDistribution, 0,
      'A rejected layer distribution must not create a fake undo step');

    // 2. Add an element and edit its real property input.
    await page.locator('button[onclick="addDesignElement(\'heading\')"]').click();
    const element = page.locator('#designCanvas [data-design-id]').first();
    try {
      await element.waitFor({ timeout: 10000 });
    } catch (error) {
      throw new Error('Design element did not render after addDesignElement. Browser errors: ' + failures.join(' | ') + '. ' + error.message);
    }
    const textField = page.locator('#designInspectorProperties input[type="text"]').first();
    await textField.fill('Prueba integral CodeLab');
    await page.waitForFunction(() => {
      const node = document.querySelector('#designCanvas [data-design-id]');
      return node && node.textContent === 'Prueba integral CodeLab';
    });
    assert.equal(await page.locator('#designCanvas [data-design-id]').count(), 1,
      'adding a heading should render one canvas element');

    // 3. Undo/redo the property edit through the visible controls.
    await page.locator('#designUndoBtn').click();
    await page.waitForFunction(() => {
      const node = document.querySelector('#designCanvas [data-design-id]');
      return node && node.textContent === 'Título de tu diseño';
    });
    await page.locator('#designRedoBtn').click();
    await page.waitForFunction(() => {
      const node = document.querySelector('#designCanvas [data-design-id]');
      return node && node.textContent === 'Prueba integral CodeLab';
    });
    // Undo/redo intentionally clears selection; select the layer again before
    // exercising its Inspector controls.
    await element.click();
    await page.locator('#designProperty-width').waitFor({ state: 'visible' });

    // 3b. Exercise responsive position and dimensions through the real Inspector.
    await page.locator('#designProperty-x').fill('25');
    await page.locator('#designProperty-xUnit').selectOption('%');
    await page.waitForFunction(() => document.querySelector('#designCanvas [data-design-id]')?.style.left === '25%');
    await page.locator('#designProperty-y').fill('10');
    await page.locator('#designProperty-yUnit').selectOption('%');
    await page.waitForFunction(() => document.querySelector('#designCanvas [data-design-id]')?.style.top === '10%');
    await page.locator('#designProperty-width').fill('50');
    await page.locator('#designProperty-widthUnit').selectOption('%');
    await page.waitForFunction(() => document.querySelector('#designCanvas [data-design-id]')?.style.width === '50%');
    await page.locator('#designProperty-heightUnit').selectOption('auto');
    await page.waitForFunction(() => document.querySelector('#designCanvas [data-design-id]')?.style.height === 'auto');
    await page.locator('#designProperty-xUnit').selectOption('px');
    await page.locator('#designProperty-x').fill('80');
    await page.locator('#designProperty-yUnit').selectOption('px');
    await page.locator('#designProperty-y').fill('70');
    await page.locator('#designProperty-widthUnit').selectOption('px');
    await page.locator('#designProperty-width').fill('560');
    await page.locator('#designProperty-heightUnit').selectOption('px');
    await page.locator('#designProperty-height').fill('76');
    await page.waitForFunction(() => {
      const node = document.querySelector('#designCanvas [data-design-id]');
      return node?.style.left === '80px' && node?.style.top === '70px' && node?.style.width === '560px' && node?.style.height === '76px';
    });

    // 4. Drag the actual canvas element with pointer events.
    const before = await element.boundingBox();
    assert.ok(before, 'canvas element should have a visible bounding box');
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 45, before.y + before.height / 2 + 32, { steps: 5 });
    await page.mouse.up();
    const moved = await element.evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
    assert.ok(moved.left >= 120, 'drag should update the element x coordinate');
    assert.ok(moved.top >= 95, 'drag should update the element y coordinate');

    // 4a. Snap-to-grid rounds the dragged layer to the configured grid size.
    await page.selectOption('#designGridSize', '16');
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.backgroundSize), '16px 16px',
      'visible grid spacing should match the selected grid size');
    await page.click('#designSnapBtn');
    const snapBefore = await element.boundingBox();
    assert.ok(snapBefore, 'selected layer should be visible before snap drag');
    await page.mouse.move(snapBefore.x + snapBefore.width / 2, snapBefore.y + snapBefore.height / 2);
    await page.mouse.down();
    await page.mouse.move(snapBefore.x + snapBefore.width / 2 + 7, snapBefore.y + snapBefore.height / 2 + 9, { steps: 3 });
    await page.mouse.up();
    const snapped = await element.evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
    assert.equal(snapped.left % 16, 0, 'snapped x coordinate should align to 16 px grid');
    assert.equal(snapped.top % 16, 0, 'snapped y coordinate should align to 16 px grid');
    await page.click('#designSnapBtn');
    await element.focus();

    // 4b. Resize the selected layer directly from its canvas handle.
    const sizeBefore = await element.evaluate(node => ({ width: parseFloat(node.style.width), height: parseFloat(node.style.height) }));
    const resizeHandle = page.locator('[data-design-resize-handle]');
    await resizeHandle.waitFor({ state: 'visible' });
    const handleBox = await resizeHandle.boundingBox();
    assert.ok(handleBox, 'selected canvas layer should expose a visible resize handle');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 32, handleBox.y + handleBox.height / 2 + 24, { steps: 4 });
    await page.mouse.up();
    const sizeAfter = await element.evaluate(node => ({ width: parseFloat(node.style.width), height: parseFloat(node.style.height) }));
    assert.ok(sizeAfter.width >= sizeBefore.width + 25, 'canvas resize handle should increase layer width');
    assert.ok(sizeAfter.height >= sizeBefore.height + 18, 'canvas resize handle should increase layer height');
    await resizeHandle.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    const keyboardSize = await element.evaluate(node => ({ width: parseFloat(node.style.width), height: parseFloat(node.style.height) }));
    assert.equal(keyboardSize.width, sizeAfter.width + 1, 'resize handle ArrowRight should increase width by one pixel');
    assert.equal(keyboardSize.height, sizeAfter.height + 10, 'resize handle Shift+ArrowDown should increase height by ten pixels');

    // 4c. Keyboard nudging and duplication shortcuts operate on the selected layer.
    await element.focus();
    const beforeNudge = await element.evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    const afterNudge = await element.evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
    assert.equal(afterNudge.left, beforeNudge.left + 1, 'ArrowRight should nudge the selected layer by one pixel');
    assert.equal(afterNudge.top, beforeNudge.top + 10, 'Shift+ArrowDown should nudge the selected layer by ten pixels');
    await page.keyboard.press('Control+d');
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 2);
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 1);

    // 4d. Multi-select three layers from the layer list and distribute them evenly.
    const distributionX = [100, 300, 800];
    const distributionY = [420, 500, 600];
    for (let index = 0; index < distributionX.length; index++) {
      await page.locator('button[onclick="addDesignElement(\'rectangle\')"]').click();
      await page.locator('#designProperty-x').fill(String(distributionX[index]));
      await page.locator('#designProperty-y').fill(String(distributionY[index]));
      await page.locator('#designProperty-width').fill('100');
      await page.locator('#designProperty-height').fill('60');
    }
    const layerRows = page.locator('#designLayers [data-design-select]');
    await layerRows.nth(0).click();
    await layerRows.nth(1).click({ modifiers: ['Shift'] });
    await layerRows.nth(2).click({ modifiers: ['Shift'] });
    await page.locator('button[onclick="distributeDesignElements(\'horizontal\')"]').click();
    const distributed = await page.locator('#designCanvas [data-design-id]').evaluateAll(nodes =>
      nodes.map(node => ({ left: parseFloat(node.style.left), width: parseFloat(node.style.width) }))
        .filter(item => item.width === 100 && item.left >= 100 && item.left <= 900)
        .map(item => item.left).sort((a, b) => a - b));
    assert.deepEqual(distributed.slice(0, 3), [100, 450, 800],
      'multi-select distribution should create equal gaps while preserving first/last bounds');
    await page.locator('button[aria-label="Alinear arriba"]').click();
    const alignedTops = await page.locator('#designCanvas [data-design-id]').evaluateAll(nodes =>
      nodes.map(node => ({ top: parseFloat(node.style.top), left: parseFloat(node.style.left), width: parseFloat(node.style.width) }))
        .filter(item => item.width === 100 && item.left >= 100 && item.left <= 900)
        .map(item => item.top));
    assert.deepEqual(alignedTops.slice(0, 3), [420, 420, 420],
      'multi-select alignment should align all selected layer tops to the shared selection edge');

    // 4e. Auto Layout uses direction, spacing and padding to calculate live layer positions.
    await page.locator('#designLayoutMode').selectOption('auto');
    await page.locator('#designLayoutDirection').selectOption('column');
    await page.locator('#designLayoutGap').fill('24');
    await page.locator('#designLayoutGap').dispatchEvent('change');
    await page.locator('#designLayoutPadding').fill('20');
    await page.locator('#designLayoutPadding').dispatchEvent('change');
    const autoLayoutPositions = await page.locator('#designCanvas [data-design-id]').evaluateAll(nodes =>
      nodes.map(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) }))
        .filter(item => item.width === 100).sort((a, b) => a.top - b.top));
    assert.equal(autoLayoutPositions.length, 3, 'Auto Layout should keep all selected layers in the flow');
    assert.ok(autoLayoutPositions.every(item => item.left === 20), 'column Auto Layout should apply left padding');
    assert.equal(autoLayoutPositions[1].top - autoLayoutPositions[0].top - autoLayoutPositions[0].height, 24,
      'column Auto Layout should apply configured spacing between layers');
    assert.equal(autoLayoutPositions[2].top - autoLayoutPositions[1].top - autoLayoutPositions[1].height, 24,
      'column Auto Layout should apply configured spacing consistently');
    await page.selectOption('#designFrameSize', 'mobile');
    await page.locator('#designLayoutDirection').selectOption('row');
    const rowLayoutPositions = await page.locator('#designCanvas [data-design-id]').evaluateAll(nodes =>
      nodes.map(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top), width: parseFloat(node.style.width) }))
        .filter(item => item.width === 100).sort((a, b) => a.left - b.left));
    assert.deepEqual(rowLayoutPositions.map(item => item.left), [20, 144, 268],
      'row Auto Layout should wrap the oversized heading and pack the three smaller layers into the mobile frame');
    assert.equal(rowLayoutPositions[0].top, rowLayoutPositions[2].top,
      'layers fitting on the same row should share a top position');
    await page.selectOption('#designFrameSize', 'desktop');
    await page.locator('#designLayoutDirection').selectOption('column');
    await page.locator('button[onclick="deleteDesignElement()"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 1);
    await element.click();

    // 5. Duplicate and delete through the production layer controls.
    await element.click();
    await page.locator('button[onclick="duplicateDesignElement()"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 2);
    await page.locator('button[onclick="deleteDesignElement()"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 1);
    assert.equal(await page.locator('#designCanvas [data-design-id]').first().innerText(), 'Prueba integral CodeLab');

    // 5b. Add a local image file, edit its alt text, and verify it renders as a real layer.
    await page.locator('button[onclick="addDesignElement(\'image\')"]').click();
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3XcAAAAASUVORK5CYII=';
    await page.locator('#designImageFile').setInputFiles({
      name: 'codelab-fixture.png',
      mimeType: 'image/png',
      buffer: Buffer.from(tinyPng, 'base64')
    });
    await page.waitForFunction(() => {
      const image = document.querySelector('#designCanvas [data-design-id] img');
      return image && image.complete && image.naturalWidth > 0;
    }, null, { timeout: 10000 });
    assert.equal(await page.locator('#designProperty-src').inputValue(), '',
      'embedded image bytes should stay in project state, not be copied into a giant URL input value');
    await page.locator('#designProperty-alt').fill('E2E sample image');
    await page.waitForFunction(() => {
      const image = document.querySelector('#designCanvas [data-design-id] img');
      return image && image.alt === 'E2E sample image';
    });
    assert.equal(await page.locator('#designCanvas [data-design-id]').count(), 2,
      'image should be added as a separate editable layer');

    // 5b. Layer order can be changed from the selected-layer properties panel.
    const layerLabels = () => page.locator('#designCanvas [data-design-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.deepEqual(await layerLabels(), ['Título', 'Imagen']);
    await page.click('#designLayerDown');
    assert.deepEqual(await layerLabels(), ['Imagen', 'Título'], 'sending a layer back should change render order');
    await page.click('#designLayerUp');
    assert.deepEqual(await layerLabels(), ['Título', 'Imagen'], 'bringing a layer forward should restore render order');

    // 5c. Ellipse layers remain oval in the editable canvas.
    await page.locator('button[onclick="addDesignElement(\'ellipse\')"]').click();
    assert.equal(await page.locator('#designCanvas [data-design-id]').count(), 3);
    assert.equal(await page.locator('#designCanvas [data-design-id]').last().evaluate(node => node.style.borderRadius), '50%',
      'ellipse should use a true oval border radius');

    // 5d. Apply a full-page template and undo it without losing the prior design.
    await page.click('#designTemplatesButton');
    await page.waitForSelector('#designTemplatesMenu:not(.hidden)');
    page.once('dialog', dialog => dialog.accept());
    await page.click('#designTemplateDashboard');
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 11);
    assert.ok((await page.locator('#designCanvas').innerText()).includes('Panel de control'),
      'dashboard template should populate a complete starter layout');
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.backgroundColor), 'rgb(248, 250, 252)');
    await page.click('#designUndoBtn');
    await page.waitForFunction(() => {
      const nodes = Array.from(document.querySelectorAll('#designCanvas [data-design-id]'));
      return nodes.length === 3 && nodes.some(node => node.innerText === 'Prueba integral CodeLab') &&
        !!document.querySelector('#designCanvas [data-design-id] img[alt="E2E sample image"]');
    });
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.backgroundColor), 'rgb(255, 255, 255)',
      'undo should restore the original background as well as the original layers');

    // 6. Exercise responsive frame presets and mobile overflow behavior.
    await page.selectOption('#designFrameSize', 'tablet');
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.width), '768px');
    await page.selectOption('#designFrameSize', 'mobile');
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.width), '390px');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await page.evaluate(() => {
      const viewportWidth = window.innerWidth;
      const offenders = [...document.querySelectorAll('body *')]
        .filter(node => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return style.display !== 'none' && style.position !== 'fixed' &&
            rect.width > 0 && (rect.right > viewportWidth + 2 || rect.left < -2) &&
            !node.closest('#designCanvasScroll');
        })
        .slice(0, 20)
        .map(node => ({
          tag: node.tagName,
          id: node.id || '',
          className: typeof node.className === 'string' ? node.className.slice(0, 160) : '',
          left: Math.round(node.getBoundingClientRect().left),
          right: Math.round(node.getBoundingClientRect().right),
          width: Math.round(node.getBoundingClientRect().width)
        }));
      return {
        viewportWidth,
        documentWidth: document.documentElement.scrollWidth,
        canvasWidth: document.getElementById('designCanvas').getBoundingClientRect().width,
        scrollContainerExists: !!document.getElementById('designCanvasScroll'),
        offenders
      };
    });
    assert.ok(mobileLayout.scrollContainerExists, 'mobile canvas scroll container should exist');
    assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 2,
      'mobile app shell should not introduce document-level horizontal overflow: ' + JSON.stringify(mobileLayout));

    // 6b. Exercise the actual AI capture flow and inspect both generated artifacts.
    // Capture the download payloads at the app boundary: Chromium headless blocks
    // multiple automatic downloads, which is unrelated to whether both artifacts were generated.
    await page.evaluate(() => {
      window.__designCaptureArtifacts = [];
      window.__designCaptureBlobs = new Map();
      window.__nativeDesignCreateObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
      window.__nativeDesignCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        const url = window.__nativeDesignCreateObjectURL(blob);
        window.__designCaptureBlobs.set(url, blob);
        return url;
      };
      window.__designCaptureClickHandler = event => {
        const link = event.target && event.target.closest ? event.target.closest('a[download]') : null;
        if (!link) return;
        const blob = window.__designCaptureBlobs.get(link.href);
        if (!blob) return;
        event.preventDefault();
        const artifact = { name: link.download, type: blob.type, size: blob.size };
        window.__designCaptureArtifacts.push(artifact);
        const reader = new FileReader();
        reader.onload = () => {
          const buffer = reader.result;
          if (/\.json$/.test(link.download) || /\.svg$/.test(link.download)) {
            artifact.text = new TextDecoder().decode(buffer);
          } else if (/\.png$/.test(link.download)) {
            const bytes = new Uint8Array(buffer);
            const view = new DataView(buffer);
            artifact.signature = Array.from(bytes.slice(0, 8));
            artifact.width = view.getUint32(16);
            artifact.height = view.getUint32(20);
          }
        };
        reader.readAsArrayBuffer(blob);
      };
      document.addEventListener('click', window.__designCaptureClickHandler, true);
    });
    await page.selectOption('#designCaptureScale', '4');
    await page.locator('button[onclick="captureDesignForAI()"]').click();
    try {
      await page.waitForFunction(() => {
        const artifacts = window.__designCaptureArtifacts || [];
        return artifacts.length >= 2 && artifacts.every(item =>
          item.name.endsWith('-contexto-ia.json') ? !!item.text :
          item.name.endsWith('-captura-ia.png') ? !!item.signature :
          item.name.endsWith('-captura-ia.svg') ? !!item.text : false
        );
      }, null, { timeout: 20000 });
    } catch (error) {
      const debug = await page.evaluate(() => ({
        artifacts: window.__designCaptureArtifacts,
        project: typeof activeDesignProject === 'function' ? !!activeDesignProject()?.design : null,
        toast: document.querySelector('[role="status"]')?.textContent || ''
      }));
      throw new Error('AI capture artifacts not ready: ' + JSON.stringify(debug) + '; ' + error.message);
    }
    const captureFiles = await page.evaluate(() => window.__designCaptureArtifacts);
    const contextFile = captureFiles.find(file => /-contexto-ia\.json$/.test(file.name));
    const imageFile = captureFiles.find(file => /-captura-ia\.(png|svg)$/.test(file.name));
    assert.ok(contextFile, 'AI capture should export structured context JSON');
    assert.ok(imageFile, 'AI capture should produce a visual artifact (PNG or SVG fallback)');
    const captureContext = JSON.parse(contextFile.text);
    assert.equal(captureContext.format, 'codelab-ai-design-capture');
    assert.equal(captureContext.layout.mode, 'auto', 'AI context should record Auto Layout mode');
    assert.equal(captureContext.layout.direction, 'column', 'AI context should record Auto Layout direction');
    assert.equal(captureContext.layout.gap, 24, 'AI context should record Auto Layout spacing');
    assert.equal(captureContext.layout.padding, 20, 'AI context should record Auto Layout padding');
    assert.ok(captureContext.elementCount >= 1, 'capture context should include the canvas element');
    assert.ok(captureContext.elements.some(item => item.type === 'image' && item.image && item.image.alt === 'E2E sample image'),
      'AI context should preserve image alt text without embedding the base64 payload again');
    assert.equal(captureContext.canvas.scale, 4, 'design capture context should record the selected maximum 4× resolution');
    assert.equal(captureContext.canvas.pixelWidth, captureContext.canvas.width * 4, 'context pixel width should match the selected scale');
    assert.equal(captureContext.canvas.pixelHeight, captureContext.canvas.height * 4, 'context pixel height should match the selected scale');
    assert.ok(captureContext.elements.some(item => item.text === 'Prueba integral CodeLab'),
      'capture context should preserve the actual edited element text');
    if (/\.png$/.test(imageFile.name)) {
      assert.deepEqual(imageFile.signature, [137, 80, 78, 71, 13, 10, 26, 10],
        'successful PNG capture should produce a valid PNG signature');
      assert.equal(imageFile.width, captureContext.canvas.pixelWidth, 'PNG width should match capture context');
      assert.equal(imageFile.height, captureContext.canvas.pixelHeight, 'PNG height should match capture context');
    } else {
      assert.match(imageFile.text, /<svg[\s>]/i, 'SVG fallback should contain an SVG document');
    }

    await page.evaluate(() => {
      document.removeEventListener('click', window.__designCaptureClickHandler, true);
      if (window.__nativeDesignCreateObjectURLDescriptor) Object.defineProperty(URL, 'createObjectURL', window.__nativeDesignCreateObjectURLDescriptor);
      else delete URL.createObjectURL;
    });

    // 6c. Configure a safe button destination to exercise prototype navigation.
    await page.locator('button[onclick="addDesignElement(\'button\')"]').click();
    const internalTarget = await page.locator('#designPrototypeTarget option').nth(1).getAttribute('value');
    assert.ok(internalTarget && internalTarget.startsWith('#layer-'), 'prototype editor should offer internal layer destinations');
    await page.locator('#designPrototypeTarget').selectOption(internalTarget);
    assert.equal(await page.evaluate(() => window.activeDesignProject().design.elements.find(item => item.type === 'button')?.href || ''),
      internalTarget, 'choosing an internal target should update the prototype button');
    await page.click('#designExportMenuButton');
    await page.waitForSelector('#designExportMenu:not(.hidden)');
    await page.evaluate(() => {
      window.__capturedHtmlExport = null;
      window.__htmlExportBlobs = new Map();
      window.__htmlExportUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
      window.__htmlExportCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        const url = window.__htmlExportCreateObjectURL(blob);
        window.__htmlExportBlobs.set(url, blob);
        return url;
      };
      window.__htmlExportClickHandler = event => {
        const link = event.target && event.target.closest ? event.target.closest('a[download$=".html"]') : null;
        if (!link) return;
        const blob = window.__htmlExportBlobs.get(link.href);
        if (!blob) return;
        event.preventDefault();
        const reader = new FileReader();
        reader.onload = () => { window.__capturedHtmlExport = new TextDecoder().decode(reader.result); };
        reader.readAsArrayBuffer(blob);
      };
      document.addEventListener('click', window.__htmlExportClickHandler, true);
    });
    await page.locator('#designExportMenu [role="menuitem"]').filter({ hasText: 'HTML adaptable' }).click();
    await page.waitForFunction(() => typeof window.__capturedHtmlExport === 'string' && window.__capturedHtmlExport.length > 0);
    const internalHtml = await page.evaluate(() => window.__capturedHtmlExport);
    await page.evaluate(() => {
      document.removeEventListener('click', window.__htmlExportClickHandler, true);
      if (window.__htmlExportUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', window.__htmlExportUrlDescriptor);
      else delete URL.createObjectURL;
    });
    assert.ok(internalHtml.includes('href="' + internalTarget + '"'), 'HTML export should preserve internal layer navigation');
    assert.ok(internalHtml.includes('id="' + internalTarget.slice(1) + '"'), 'HTML export should assign stable anchor IDs to target layers');
    await page.locator('#designProperty-href').fill('javascript:alert(1)');
    assert.equal(await page.evaluate(() => window.activeDesignProject().design.elements.find(item => item.type === 'button')?.href || ''),
      '', 'prototype destinations must reject javascript URLs');
    await page.locator('#designProperty-href').fill('https://example.com/docs');
    assert.equal(await page.evaluate(() => {
      const project = window.activeDesignProject();
      return project.design.elements.find(item => item.type === 'button')?.href || '';
    }), 'https://example.com/docs', 'prototype buttons should keep normalized HTTP(S) destinations only');

    // 6d. Verify the three explicit export formats through the real UI.
    await page.click('#designExportMenuButton');
    await page.waitForSelector('#designExportMenu:not(.hidden)');
    const htmlExportReady = page.waitForEvent('download');
    await page.locator('#designExportMenu [role="menuitem"]').filter({ hasText: 'HTML adaptable' }).click();
    const htmlExport = await htmlExportReady;
    assert.match(htmlExport.suggestedFilename(), /\.html$/i, 'HTML export should have an HTML filename');
    const htmlExportPath = await htmlExport.path();
    const exportedHtml = await fs.readFile(htmlExportPath, 'utf8');
    assert.match(exportedHtml, /<!doctype html>/i, 'HTML export should contain a standalone document');
    assert.match(exportedHtml, /class="design-viewport"/, 'HTML export should use a viewport wrapper');
    assert.match(exportedHtml, /addEventListener\("resize",fit/, 'HTML export should recalculate scale on resize');
    assert.match(exportedHtml, /f\.style\.transform/, 'HTML export should apply a visual scale to the fixed design canvas');
    assert.match(exportedHtml, /class="design-frame auto-layout"/, 'HTML export should preserve Auto Layout mode');
    assert.match(exportedHtml, /display:flex;flex-direction:column/, 'HTML export should use a flow layout instead of absolute positioning');
    assert.match(exportedHtml, /gap:24px;padding:20px/, 'HTML export should preserve Auto Layout spacing and padding');
    assert.match(exportedHtml, /window\.innerWidth\/w/, 'HTML export should calculate scale from the current viewport width');
    assert.match(exportedHtml, /<img\b[^>]*\bsrc="data:image\/png;base64,/, 'HTML export should include the embedded image asset regardless of safe attribute ordering');
    assert.match(exportedHtml, /alt="E2E sample image"/, 'HTML export should preserve the image alt text');
    assert.match(exportedHtml, /border-radius:50%/, 'HTML export should preserve ellipse geometry');
    assert.match(exportedHtml, /href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer"/,
      'HTML export should preserve the safe prototype destination with safe new-tab attributes');

    await page.click('#designExportMenuButton');
    await page.waitForSelector('#designExportMenu:not(.hidden)');
    const svgExportReady = page.waitForEvent('download');
    await page.click('#exportDesignSvgOption');
    const svgExport = await svgExportReady;
    assert.match(svgExport.suggestedFilename(), /\.svg$/i, 'SVG export should have an SVG filename');
    assert.match(await fs.readFile(await svgExport.path(), 'utf8'), /<svg[\s>]/i, 'SVG export should preserve vector markup');
    assert.match(await fs.readFile(await svgExport.path(), 'utf8'), /<image href="data:image\/png;base64,/, 'SVG export should preserve the embedded image layer');
    assert.match(await fs.readFile(await svgExport.path(), 'utf8'), /<ellipse cx=/, 'SVG export should preserve ellipse geometry');

    // Keep the JSON backup's button pointed at an internal layer so import can
    // prove that layer IDs are remapped rather than left pointing at the source.
    await page.locator('#designProperty-href').fill(internalTarget);
    await page.waitForFunction(value =>
      getCurrentProject()?.design.elements.find(item => item.type === 'button')?.href === value,
      internalTarget, { timeout: 3000 });

    await page.click('#designExportMenuButton');
    await page.waitForSelector('#designExportMenu:not(.hidden)');
    const jsonExportReady = page.waitForEvent('download');
    await page.click('#exportDesignJsonOption');
    const jsonExport = await jsonExportReady;
    assert.match(jsonExport.suggestedFilename(), /-proyecto\.json$/i, 'Project backup should have a JSON filename');
    const projectBackup = JSON.parse(await fs.readFile(await jsonExport.path(), 'utf8'));
    assert.equal(projectBackup.format, 'codelab-design-project');
    assert.equal(projectBackup.project.type, 'design');
    assert.ok(Array.isArray(projectBackup.project.design.elements), 'JSON backup should preserve editable design elements');
    assert.equal(projectBackup.project.design.elements.find(item => item.type === 'image')?.alt, 'E2E sample image',
      'JSON backup should preserve image metadata');
    const responsiveBackupLayer = projectBackup.project.design.elements.find(item => item.type === 'heading') || projectBackup.project.design.elements[0];
    responsiveBackupLayer.x = 25;
    responsiveBackupLayer.xUnit = '%';
    responsiveBackupLayer.y = 10;
    responsiveBackupLayer.yUnit = '%';
    responsiveBackupLayer.width = 50;
    responsiveBackupLayer.widthUnit = '%';
    responsiveBackupLayer.heightUnit = 'auto';

    // Restore the original project's external prototype target; only the
    // downloaded backup fixture should retain the internal layer link.
    await page.locator('#designProperty-href').fill('https://example.com/docs');
    await page.waitForFunction(() =>
      getCurrentProject()?.design.elements.find(item => item.type === 'button')?.href === 'https://example.com/docs',
      null, { timeout: 3000 });

    // The exported backup must be restorable as a separate project, including
    // image metadata and remapped internal prototype links.
    await page.locator('#designProjectJsonFile').setInputFiles({
      name: 'design-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(projectBackup))
    });
    await page.waitForFunction(({ name, count }) => {
      const project = getCurrentProject();
      return project && project.type === 'design' && project.name === name + ' (Importado)' &&
        project.hasWebSpace === true && project.hasDesignSpace === true &&
        !!project.code && Array.isArray(project.design?.elements) && project.design.elements.length === count;
    }, { name: PROJECT_NAME, count: projectBackup.project.design.elements.length }, { timeout: 10000 });
    const restoredBackupCheck = await page.evaluate(() => {
      const project = getCurrentProject();
      const button = project.design.elements.find(item => item.type === 'button');
      const responsiveLayer = project.design.elements.find(item => item.type === 'heading') || project.design.elements[0];
      const targetId = /^#layer-(.+)$/.exec(button?.href || '')?.[1];
      return {
        imageAlt: project.design.elements.find(item => item.type === 'image')?.alt,
        internalLinkRestored: !!targetId && project.design.elements.some(item => item.id === targetId),
        xUnit: responsiveLayer?.xUnit || 'px',
        yUnit: responsiveLayer?.yUnit || 'px',
        widthUnit: responsiveLayer?.widthUnit || 'px',
        heightUnit: responsiveLayer?.heightUnit || 'px',
        sourceProjectStillExists: projects.some(item => item.name === project.name.replace(/ \(Importado\)$/, ''))
      };
    });
    assert.equal(restoredBackupCheck.imageAlt, 'E2E sample image', 'backup import must preserve image metadata');
    assert.equal(restoredBackupCheck.internalLinkRestored, true, 'backup import must remap internal prototype links to the imported layer IDs');
    assert.equal(restoredBackupCheck.xUnit, '%', 'backup import must preserve percentage X units');
    assert.equal(restoredBackupCheck.yUnit, '%', 'backup import must preserve percentage Y units');
    assert.equal(restoredBackupCheck.widthUnit, '%', 'backup import must preserve percentage width units');
    assert.equal(restoredBackupCheck.heightUnit, 'auto', 'backup import must preserve Auto height units');
    assert.equal(restoredBackupCheck.sourceProjectStillExists, true, 'restoring a backup must create a separate project, not overwrite the source');

    // Return to the original project before testing recovery after reload.
    await page.evaluate(() => returnToDashboard());
    await page.waitForSelector('#welcomeDashboard:not(.hidden)');
    await page.locator('#projectsGrid > div').filter({
      has: page.locator('h4').getByText(PROJECT_NAME, { exact: true })
    }).locator('button[data-action="open"]').click();
    await page.waitForFunction(name => getCurrentProject()?.name === name && getCurrentProject()?.type === 'design', PROJECT_NAME);

    // 7. Verify recovery of newer local edits and an offline deletion after reload.
    await page.selectOption('#designFrameSize', 'desktop');
    await waitForPersistedProject(page, PROJECT_NAME);
    const deletedDefaultId = await page.evaluate(name => {
      const projects = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || '[]');
      const storedProject = projects.find(item => item.name === name);
      const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : storedProject;
      const starter = projects.find(item => item.name === 'Mi Primer Proyecto');
      if (!project || !project.design || !project.design.elements.length || !starter) return null;
      // Mutate both the live in-memory project and its local snapshot, so the
      // page's beforeunload handler preserves the simulated offline edit.
      project.design.elements[0].text = 'Edición local recuperada';
      project.updatedAt = new Date().toISOString();
      if (storedProject) {
        storedProject.design = JSON.parse(JSON.stringify(project.design));
        storedProject.updatedAt = project.updatedAt;
      }
      localStorage.setItem('codelab_xd_projects_v2', JSON.stringify(projects));
      // Simulate a deletion that has not yet been confirmed by the server.
      localStorage.setItem('codelab_xd_deleted_project_id_for_e2e', starter.id);
      localStorage.setItem('codelab_xd_deleted_projects_v1', JSON.stringify({
        workspaceId: localStorage.getItem('codelab_xd_workspace_v4'),
        ids: [starter.id]
      }));
      return starter.id;
    }, PROJECT_NAME);
    assert.ok(deletedDefaultId, 'fixture should include the starter project and design project');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    const projectCard = page.locator('#projectsGrid > div').filter({
      has: page.locator('h4').getByText(PROJECT_NAME, { exact: true })
    });
    await projectCard.locator('button[data-action="open"]').click();
    await page.waitForFunction(() => {
      const design = document.getElementById('designStudioPanel');
      return design && !design.classList.contains('hidden') &&
        document.querySelector('#designCanvas [data-design-id]');
    }, { timeout: 10000 });
    assert.equal(await page.locator('#designCanvas [data-design-id]').first().innerText(), 'Edición local recuperada',
      'a newer local edit must not be overwritten by the server snapshot');
    // Selection is intentionally not persisted; hide the overlay before clicking the canvas element beneath it.
    await page.locator('#designStudioPanel button[aria-label="Cerrar panel de opciones"]').click();
    await page.locator('#designCanvas [data-design-id]').first().click();
    await page.locator('#designInspectorProperties input[type="text"]').first().fill('Prueba integral CodeLab');
    await page.waitForFunction(() => document.querySelector('#designCanvas [data-design-id]')?.textContent === 'Prueba integral CodeLab');
    await waitForPersistedProject(page, PROJECT_NAME);
    await page.waitForFunction(async id => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        return !(data.projects || []).some(project => project.id === id);
      } catch (_) { return false; }
    }, deletedDefaultId, { timeout: 10000 });
    await page.evaluate(() => localStorage.removeItem('codelab_xd_deleted_project_id_for_e2e'));

    // 8. Conversion must enforce the per-file HTML safety limit, then update
    // the Web workspace in-place (without a project-count cap or duplicate).
    const conversionGuardCheck = await page.evaluate(async () => {
      const previousToast = showToast;
      const before = projects.length;
      const project = activeDesignProject();
      const element = project && project.design.elements.find(item => item.type === 'heading') || project?.design.elements[0];
      if (!project || !element) throw new Error('conversion guard fixture needs a design element');
      const projectId = project.id;
      const previousText = element.text;
      let toast = '';
      try {
        showToast = message => { toast = message; };
        element.text = 'x'.repeat(500001);
        await convertDesignToWeb();
        const oversizedBlocked = projects.length === before && project.id === projectId && project.type === 'design';
        const sizeWarning = /500000 caracteres/i.test(toast);
        return { oversizedBlocked, sizeWarning };
      } finally {
        element.text = previousText;
        showToast = previousToast;
        await saveProjectsToStorage();
        renderDesignWorkspace();
      }
    });
    assert.equal(conversionGuardCheck.oversizedBlocked, true, 'oversized generated HTML must be rejected without changing the project');
    assert.equal(conversionGuardCheck.sizeWarning, true, 'the size rejection must explain the HTML limit');
    const reopenOptions = page.locator('#designOptionsReopen');
    if (await reopenOptions.isVisible()) await reopenOptions.click();
    await page.locator('button[onclick="convertDesignToWeb()"]').click();
    await page.waitForFunction(() => {
      const design = document.getElementById('designStudioPanel');
      const editor = document.getElementById('editorPanel');
      return design && design.classList.contains('hidden') && editor && !editor.classList.contains('hidden');
    }, { timeout: 10000 });
    await page.evaluate(id => { window.__e2eOriginalDesignProjectId = id; }, originalDesignProjectId);
    const convertedHandle = await page.waitForFunction(async name => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        const matchingProjects = (data.projects || []).filter(project => project.name === name);
        if (matchingProjects.length !== 1 || matchingProjects[0].id !== window.__e2eOriginalDesignProjectId) return false;
        return matchingProjects.find(project =>
          project.type === 'web' &&
          project.code &&
          project.code.html.includes('Prueba integral CodeLab')
        ) || false;
      } catch (_) {
        return false;
      }
    }, PROJECT_NAME, { timeout: 15000 });
    const converted = await convertedHandle.jsonValue();
    assert.equal(converted.id, originalDesignProjectId, 'conversion must preserve the original project ID');
    assert.equal(converted.type, 'web');
    assert.equal(converted.name, PROJECT_NAME, 'conversion must preserve the original project name');
    assert.match(converted.code.html, /Prueba integral CodeLab/,
      'converted web project should include the edited design content');
    assert.match(converted.code.html, /name="viewport"/,
      'converted web project should include a responsive viewport meta tag');
    assert.match(converted.code.html, /<img\b[^>]*\bsrc="data:image\/png;base64,/,
      'design-to-web conversion should preserve embedded image layers regardless of safe attribute ordering');
    assert.match(converted.code.html, /border-radius:50%/,
      'design-to-web conversion should preserve ellipse geometry');
    assert.match(converted.code.html, /addEventListener\("resize",fit/,
      'converted page should resize its design frame to the viewport');
    assert.match(converted.code.html, /class="design-frame auto-layout"/,
      'design-to-web conversion should preserve Auto Layout mode');
    assert.match(converted.code.html, /flex-direction:column/,
      'design-to-web conversion should preserve the flow direction');
    assert.match(converted.code.html, /href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer"/,
      'design-to-web conversion should preserve the safe prototype navigation destination');

    // Monaco loads asynchronously; wait until the editor reflects the active project
    // rather than asserting against the previous design project's stale editor contents.
    await page.waitForFunction(() => {
      const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : null;
      if (!project || project.type !== 'web' || !project.code || typeof window.getEditorValue !== 'function') return false;
      const editorHtml = window.getEditorValue('html');
      // Monaco may normalize line endings/formatting, so compare the real content
      // marker instead of requiring byte-for-byte equality with the stored string.
      return typeof editorHtml === 'string' &&
        project.code.html.includes('Prueba integral CodeLab') &&
        editorHtml.includes('Prueba integral CodeLab');
    }, null, { timeout: 15000 });

    // 9. Return to the dashboard (where the component-library entry point lives),
    // keeping the converted project selected for insertion and persistence checks.
    await page.locator('button[onclick="returnToDashboard()"]').click();
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible' });
    // 9a. Save design tokens through the real dialog, verify server persistence,
    // reload the app, and ensure the UI restores the server-backed settings.
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'visible' });
    await page.locator('#systemName').fill('Sistema integral E2E');
    await page.locator('#colorPrimary').evaluate(input => {
      input.value = '#123abc';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#saveDesignSystem').click();
    await page.waitForFunction(async expected => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/design-system', {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        return data.settings && data.settings.name === expected && data.settings.primary === '#123abc';
      } catch (_) { return false; }
    }, 'Sistema integral E2E', { timeout: 15000 });
    // Validate the export artifact as part of the same user journey.
    await page.locator('#designToolsTab-tokens').click();
    const tokenDownloadPromise = page.waitForEvent('download');
    await page.locator('#exportDesignSystemJson').click();
    const tokenDownload = await tokenDownloadPromise;
    const tokenPath = await tokenDownload.path();
    const exportedTokens = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
    assert.equal(exportedTokens.format, 'codelab-design-system');
    assert.equal(exportedTokens.name, 'Sistema integral E2E');
    assert.equal(exportedTokens.colors.primary, '#123abc');

    // Verify export → edit → import round-trip through the actual UI and workspace.
    await page.locator('#colorPrimary').evaluate(input => {
      input.value = '#654321';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#designSystemJsonFile').setInputFiles({
      name: 'codelab-design-system.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(exportedTokens))
    });
    await page.waitForFunction(() =>
      document.getElementById('systemName')?.value === 'Sistema integral E2E' &&
      document.getElementById('colorPrimary')?.value.toLowerCase() === '#123abc'
    , null, { timeout: 10000 });
    await page.waitForFunction(async () => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/design-system', {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        return data.settings && data.settings.primary === '#123abc';
      } catch (_) { return false; }
    }, null, { timeout: 15000 });

    await page.locator('#designToolsCloseFooter').click();
    // Remove the browser fallback so the next page load must recover these
    // values from the server-backed workspace design-system endpoint.
    await page.evaluate(() => localStorage.removeItem('codelab-design-system-v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      document.getElementById('systemName')?.value === 'Sistema integral E2E' &&
      document.getElementById('colorPrimary')?.value.toLowerCase() === '#123abc'
    , null, { timeout: 10000 });
    await page.locator('#designToolsCloseFooter').click();

    // A reload intentionally resets the active editor selection. Re-open the
    // converted project explicitly before testing component insertion so this
    // journey verifies project selection as well as the component dialog.
    const convertedProjectCard = page.locator('#projectsGrid > div').filter({
      has: page.locator('h4').getByText(PROJECT_NAME, { exact: true })
    });
    await convertedProjectCard.locator('button[data-action="open"]').click();
    await page.waitForFunction(async name => {
      const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : null;
      return project && project.name === name && project.type === 'web' &&
        typeof window.getEditorValue === 'function' &&
        window.getEditorValue('html') === project.code.html;
    }, PROJECT_NAME, { timeout: 15000 });
    await page.locator('button[onclick="returnToDashboard()"]').click();
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible' });

    // Exercise the real component-library integration on the converted web project.
    await page.locator('#openComponentLibrary').click();
    await page.locator('#componentLibraryModal').waitFor({ state: 'visible' });
    // A zero-result filter must not leave a stale component available to insert/export.
    // The editor panel is hidden on the dashboard, so its current editor value
    // may be stale/empty. Compare the active project's persisted code instead.
    const htmlBeforeEmptyFilter = await page.evaluate(() => {
      const project = window.getCurrentProject();
      return project && project.code ? project.code.html : '';
    });
    await page.locator('#componentLibrarySearch').fill('no-such-component-should-match');
    await page.waitForFunction(() => document.getElementById('componentLibraryCode')?.value === '');
    for (const id of ['componentLibraryCopy', 'componentLibraryDownload', 'componentLibraryInsert']) {
      assert.equal(await page.locator('#' + id).isDisabled(), true,
        id + ' must be disabled when component search has no results');
    }
    assert.equal(await page.evaluate(() => {
      const project = window.getCurrentProject();
      return project && project.code ? project.code.html : '';
    }), htmlBeforeEmptyFilter,
      'Searching for a missing component must not mutate the active project');
    await page.locator('#componentLibrarySearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#componentLibraryList [data-component-id]').length === 8);
    assert.equal(await page.locator('#componentLibraryInsert').isDisabled(), false,
      'Restoring results should re-enable component insertion');
    // Simulate one server-side rate limit and verify the client retries the real save.
    let injectedWorkspaceRateLimit = false;
    let injectedWorkspaceTooLarge = false;
    let allowWorkspaceTooLarge = false;
    let injectedWorkspaceValidationError = false;
    let allowWorkspaceValidationError = false;
    let workspacePutRequests = 0;
    await page.route('**/api/workspace/**', async route => {
      if (route.request().method() === 'PUT') {
        workspacePutRequests += 1;
        if (allowWorkspaceTooLarge && !injectedWorkspaceTooLarge) {
          injectedWorkspaceTooLarge = true;
          await route.fulfill({
            status: 413,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'payload_too_large' })
          });
          return;
        }
        if (allowWorkspaceValidationError && !injectedWorkspaceValidationError) {
          injectedWorkspaceValidationError = true;
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'invalid_payload', detail: 'duplicate_project_id' })
          });
          return;
        }
        if (!injectedWorkspaceRateLimit) {
          injectedWorkspaceRateLimit = true;
          await route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'rate_limited', message: 'Test rate limit' })
          });
          return;
        }
      }
      await route.continue();
    });
    await page.locator('#componentLibraryInsert').click();
    const insertedHtml = await page.evaluate(() => window.getEditorValue('html'));
    assert.match(insertedHtml, /cl-hero/,
      'component insertion should update the real HTML editor');
    await page.locator('#closeComponentLibrary').click();
    await page.waitForFunction(async name => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        const project = (data.projects || []).find(item => item.name === name && item.type === 'web');
        return !!(project && project.code && project.code.html && /cl-hero/.test(project.code.html));
      } catch (_) {
        return false;
      }
    }, PROJECT_NAME, { timeout: 15000 });

    // A 413 is a payload-size condition, not a connectivity outage. The local
    // copy must remain available and a later smaller save must restore sync.
    allowWorkspaceTooLarge = true;
    await page.evaluate(async () => { await window.persistWorkspace(); });
    await page.waitForFunction(() =>
      document.getElementById('dashSyncBadge')?.textContent.includes('Solo local')
    , null, { timeout: 5000 });
    assert.equal(injectedWorkspaceTooLarge, true, 'E2E should inject one workspace payload-size response');
    allowWorkspaceTooLarge = false;
    await page.evaluate(async () => { await window.persistWorkspace(); });
    await page.waitForFunction(() =>
      !document.getElementById('dashSyncBadge')?.textContent.includes('Solo local')
    , null, { timeout: 5000 });

    // A 400 payload-validation response means the server is reachable. The
    // client must keep sync recoverable and succeed when the next save is valid.
    allowWorkspaceValidationError = true;
    await page.evaluate(async () => { await window.persistWorkspace(); });
    await page.waitForFunction(() =>
      document.getElementById('dashSyncBadge')?.textContent.includes('Sincronización pendiente')
    , null, { timeout: 5000 });
    assert.equal(injectedWorkspaceValidationError, true, 'E2E should inject one workspace validation response');
    allowWorkspaceValidationError = false;
    await page.evaluate(async () => { await window.persistWorkspace(); });
    await page.waitForFunction(() =>
      !document.getElementById('dashSyncBadge')?.textContent.includes('Sincronización pendiente')
    , null, { timeout: 5000 });

    await page.unroute('**/api/workspace/**');
    assert.equal(injectedWorkspaceRateLimit, true, 'E2E should inject one workspace rate limit');
    assert.ok(workspacePutRequests >= 3, 'E2E should observe saves, retry, and size-limit recovery');

    // Ctrl+S must reflect the actual persistence result rather than announcing
    // success while the workspace save is rejected.
    const keyboardSaveCheck = await page.evaluate(async () => {
      const saved = {
        inCopyBranch, currentProjectId,
        saveCurrentCodeToActiveProject: window.saveCurrentCodeToActiveProject,
        showToast: window.showToast
      };
      let toast = '', kind = '';
      try {
        const activeProject = getCurrentProject() || projects[0];
        if (!activeProject) return { toast: 'no active project', kind: 'error' };
        currentProjectId = activeProject.id;
        inCopyBranch = false;
        window.saveCurrentCodeToActiveProject = async () => false;
        window.showToast = (message, severity) => { toast = message; kind = severity || ''; };
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 's', ctrlKey: true, bubbles: true, cancelable: true
        }));
        await new Promise(resolve => setTimeout(resolve, 0));
        return { toast, kind };
      } finally {
        inCopyBranch = saved.inCopyBranch;
        currentProjectId = saved.currentProjectId;
        window.saveCurrentCodeToActiveProject = saved.saveCurrentCodeToActiveProject;
        window.showToast = saved.showToast;
      }
    });
    assert.match(keyboardSaveCheck.toast, /no se confirmó el guardado\/sincronización/i,
      'Ctrl+S must not report a successful save when persistence returns false');
    assert.equal(keyboardSaveCheck.kind, 'warn',
      'an unconfirmed Ctrl+S save should be shown as a warning');

    // Branch creation must not announce server synchronization when persistence fails.
    const branchCreationCheck = await page.evaluate(async () => {
      const project = getCurrentProject();
      if (!project) return { hasProject: false, toast: '' };
      const saved = {
        inCopyBranch, projectBranch: project.branch, copyBaseCode, copyProjectCode,
        copyBranchId, isCopyBranchCreated,
        saveCurrentCodeToActiveProject: window.saveCurrentCodeToActiveProject,
        persistBranch: window.persistBranch,
        updateBranchButtons: window.updateBranchButtons,
        showToast: window.showToast
      };
      let toast = '', kind = '';
      try {
        inCopyBranch = false;
        window.saveCurrentCodeToActiveProject = async () => true;
        window.persistBranch = async () => false;
        window.updateBranchButtons = () => {};
        window.showToast = (message, severity) => { toast = message; kind = severity || ''; };
        await duplicateProject();
        return { hasProject: true, toast, kind };
      } finally {
        inCopyBranch = saved.inCopyBranch;
        if (saved.projectBranch === undefined) delete project.branch;
        else project.branch = saved.projectBranch;
        copyBaseCode = saved.copyBaseCode;
        copyProjectCode = saved.copyProjectCode;
        copyBranchId = saved.copyBranchId;
        isCopyBranchCreated = saved.isCopyBranchCreated;
        window.saveCurrentCodeToActiveProject = saved.saveCurrentCodeToActiveProject;
        window.persistBranch = saved.persistBranch;
        window.updateBranchButtons = saved.updateBranchButtons;
        window.showToast = saved.showToast;
      }
    });
    assert.equal(branchCreationCheck.hasProject, true, 'branch-creation regression requires an active project');
    assert.match(branchCreationCheck.toast, /no se confirmó la sincronización/i,
      'branch creation should warn when server persistence is not confirmed');
    assert.equal(branchCreationCheck.kind, 'warn',
      'unconfirmed branch persistence should use warning severity');

    // A merge must stop if the branch could not be saved or the main workspace
    // could not be refreshed; otherwise a stale server snapshot can discard edits.
    const mergeGuard = await page.evaluate(async () => {
      const project = getCurrentProject();
      const saved = {
        inCopyBranch,
        projectBranch: project && project.branch,
        saveInCopyBranch: window.saveInCopyBranch,
        refreshWorkspaceFromServer: window.refreshWorkspaceFromServer,
        showToast: window.showToast
      };
      let refreshCalled = false;
      let toast = '';
      try {
        if (!project) return { refreshCalled: false, toast: 'no active project' };
        project.branch = { id: 'merge-guard-fixture' };
        inCopyBranch = true;
        window.saveInCopyBranch = async () => false;
        window.refreshWorkspaceFromServer = async () => { refreshCalled = true; return true; };
        window.showToast = message => { toast = message; };
        await mergeToMainProject();
        return { refreshCalled, toast };
      } finally {
        inCopyBranch = saved.inCopyBranch;
        if (project) {
          if (saved.projectBranch === undefined) delete project.branch;
          else project.branch = saved.projectBranch;
        }
        window.saveInCopyBranch = saved.saveInCopyBranch;
        window.refreshWorkspaceFromServer = saved.refreshWorkspaceFromServer;
        window.showToast = saved.showToast;
      }
    });
    assert.equal(mergeGuard.refreshCalled, false,
      'merge must not replace local state with a server snapshot when branch save fails');
    assert.match(mergeGuard.toast, /sincroniza la copia/i,
      'merge should explain why it stopped');

    // Malformed array envelopes must not be treated as account/workspace maps:
    // assigning named keys to arrays is lost by JSON.stringify and would erase
    // deletion tombstones or pending imports on the next write.
    const malformedMapChecks = await page.evaluate(() => {
      const deletedKey = 'codelab_xd_deleted_projects_v1';
      const pendingKey = 'codelab_xd_pending_local_import_v1';
      const oldDeleted = localStorage.getItem(deletedKey);
      const oldPending = localStorage.getItem(pendingKey);
      const deletedRecoveryKey = 'codelab_xd_deleted_projects_recovery_v1';
      const pendingRecoveryKey = 'codelab_xd_pending_import_recovery_v1';
      const oldDeletedRecovery = localStorage.getItem(deletedRecoveryKey);
      const oldPendingRecovery = localStorage.getItem(pendingRecoveryKey);
      const oldUser = currentUser;
      const oldPendingProjects = pendingLocalImportProjects;
      const oldSnapshotWriteBlocked = localProjectsSnapshotWriteBlocked;
      try {
        const malformedDeletedRaw = JSON.stringify({ byWorkspace: [] });
        const malformedPendingRaw = JSON.stringify({ byUser: [] });
        localStorage.setItem(deletedKey, malformedDeletedRaw);
        localStorage.setItem(pendingKey, malformedPendingRaw);
        currentUser = { real: true, provider: 'github', id: 'malformed-map-test' };
        const deletedMap = readDeletedProjectMap();
        const pendingMap = readPendingLocalImportMap();
        recordDeletedProjectId('malformed-map-test-id');
        storePendingLocalImport([{ id: 'pending-map-test-project', name: 'Recovery fixture' }]);
        const persistedDeleted = JSON.parse(localStorage.getItem(deletedKey) || '{}');
        const deletedRecovery = JSON.parse(localStorage.getItem(deletedRecoveryKey) || 'null');
        const pendingRecovery = JSON.parse(localStorage.getItem(pendingRecoveryKey) || 'null');
        localStorage.setItem(deletedKey, JSON.stringify({ byWorkspace: { 'broken-workspace': 'not-an-array', 'valid-workspace': ['keep-tombstone'] } }));
        localStorage.setItem(pendingKey, JSON.stringify({ byUser: { 'broken-user': 'not-an-array', 'valid-user': [] } }));
        const normalizedDeletedMap = readDeletedProjectMap();
        const normalizedPendingMap = readPendingLocalImportMap();
        const nestedDeletedMapNormalized = !('broken-workspace' in normalizedDeletedMap) &&
          normalizedDeletedMap['valid-workspace']?.includes('keep-tombstone');
        const nestedPendingMapNormalized = !('broken-user' in normalizedPendingMap) &&
          Array.isArray(normalizedPendingMap['valid-user']);
        localStorage.setItem(deletedKey, malformedDeletedRaw);
        const deletedClearResult = clearDeletedProjectIds(workspaceId);
        const deletedKeyRemovedAfterBackup = localStorage.getItem(deletedKey) === null;
        localStorage.setItem(pendingKey, malformedPendingRaw);
        const pendingClearResult = clearPendingLocalImport();
        const pendingKeyRemovedAfterBackup = localStorage.getItem(pendingKey) === null;
        return {
          deletedMapIsObject: !Array.isArray(deletedMap) && Object.keys(deletedMap).length === 0,
          pendingMapIsObject: !Array.isArray(pendingMap) && Object.keys(pendingMap).length === 0,
          tombstonePersisted: Array.isArray(persistedDeleted.byWorkspace?.[workspaceId]) &&
            persistedDeleted.byWorkspace[workspaceId].includes('malformed-map-test-id'),
          deletedRawPreserved: deletedRecovery && deletedRecovery.raw === malformedDeletedRaw,
          pendingRawPreserved: pendingRecovery && pendingRecovery.raw === malformedPendingRaw,
          nestedDeletedMapNormalized, nestedPendingMapNormalized,
          deletedClearResult, deletedKeyRemovedAfterBackup, pendingClearResult, pendingKeyRemovedAfterBackup
        };
      } finally {
        currentUser = oldUser;
        pendingLocalImportProjects = oldPendingProjects;
        localProjectsSnapshotWriteBlocked = oldSnapshotWriteBlocked;
        if (oldDeleted === null) localStorage.removeItem(deletedKey); else localStorage.setItem(deletedKey, oldDeleted);
        if (oldPending === null) localStorage.removeItem(pendingKey); else localStorage.setItem(pendingKey, oldPending);
        if (oldDeletedRecovery === null) localStorage.removeItem(deletedRecoveryKey); else localStorage.setItem(deletedRecoveryKey, oldDeletedRecovery);
        if (oldPendingRecovery === null) localStorage.removeItem(pendingRecoveryKey); else localStorage.setItem(pendingRecoveryKey, oldPendingRecovery);
      }
    });
    assert.equal(malformedMapChecks.deletedMapIsObject, true, 'deleted-project map reader should reject array envelopes');
    assert.equal(malformedMapChecks.pendingMapIsObject, true, 'pending-import map reader should reject array envelopes');
    assert.equal(malformedMapChecks.tombstonePersisted, true, 'a malformed deleted-project map must not make new tombstones disappear');
    assert.equal(malformedMapChecks.deletedRawPreserved, true, 'a malformed tombstone map must be backed up before replacement');
    assert.equal(malformedMapChecks.pendingRawPreserved, true, 'a malformed pending-import map must be backed up before replacement');
    assert.equal(malformedMapChecks.nestedDeletedMapNormalized, true, 'invalid workspace tombstone entries should be removed after backing up the raw map');
    assert.equal(malformedMapChecks.nestedPendingMapNormalized, true, 'invalid account import entries should be removed after backing up the raw map');
    assert.equal(malformedMapChecks.deletedClearResult, true, 'clearing malformed tombstones should succeed only after preserving the raw map');
    assert.equal(malformedMapChecks.deletedKeyRemovedAfterBackup, true, 'malformed tombstones may be cleared after a durable recovery backup exists');
    assert.equal(malformedMapChecks.pendingClearResult, true, 'clearing malformed pending imports should preserve the raw map first');
    assert.equal(malformedMapChecks.pendingKeyRemovedAfterBackup, true, 'malformed pending imports may be cleared after a durable recovery backup exists');

    // Deletion must never remove the only visible copy if neither a durable
    // tombstone nor a confirmed server save is available.
    const deletionSafety = await page.evaluate(async () => {
      const saved = {
        projects, currentProjectId, inCopyBranch, isCopyBranchCreated,
        recordDeletedProjectId, saveProjectsToStorage, saveLocalProjectsSnapshot,
        renderProjectsList, showToast, confirm: window.confirm
      };
      const fixture = { id: 'delete-safety-fixture', name: 'Delete safety fixture', code: { html: '', css: '', js: '' } };
      let toast = '';
      try {
        projects = [fixture];
        currentProjectId = null;
        inCopyBranch = false;
        isCopyBranchCreated = false;
        window.confirm = () => true;
        recordDeletedProjectId = () => false;
        saveProjectsToStorage = async () => false;
        saveLocalProjectsSnapshot = () => true;
        renderProjectsList = () => {};
        showToast = message => { toast = message; };
        await deleteProject(fixture.id);
        const retainedWithoutDurability = projects.some(project => project.id === fixture.id);
        projects = [fixture];
        recordDeletedProjectId = () => true;
        await deleteProject(fixture.id);
        const removedWithDurableTombstone = !projects.some(project => project.id === fixture.id);
        return { retainedWithoutDurability, removedWithDurableTombstone, toast };
      } finally {
        projects = saved.projects;
        currentProjectId = saved.currentProjectId;
        inCopyBranch = saved.inCopyBranch;
        isCopyBranchCreated = saved.isCopyBranchCreated;
        recordDeletedProjectId = saved.recordDeletedProjectId;
        saveProjectsToStorage = saved.saveProjectsToStorage;
        saveLocalProjectsSnapshot = saved.saveLocalProjectsSnapshot;
        renderProjectsList = saved.renderProjectsList;
        showToast = saved.showToast;
        window.confirm = saved.confirm;
      }
    });
    assert.equal(deletionSafety.retainedWithoutDurability, true,
      'deletion should roll back if neither local tombstone nor server persistence succeeds');
    assert.equal(deletionSafety.removedWithDurableTombstone, true,
      'deletion may remain local when a durable tombstone protects it from resurrection');
    assert.match(deletionSafety.toast, /marca de eliminación quedó guardada/i,
      'offline deletion should explain that its tombstone is durable');

    // Multiple malformed snapshots must each remain recoverable. Keep the first
    // legacy backup in place and append subsequent raw snapshots without duplicates.
    const multipleRecoveryBackups = await page.evaluate(() => {
      const key = 'codelab_xd_projects_recovery_v1';
      const oldRecovery = localStorage.getItem(key);
      try {
        localStorage.setItem(key, JSON.stringify({
          version: 1, savedAt: '2026-10-01T00:00:00.000Z',
          reason: 'first_invalid_json', raw: '{first-damaged}'
        }));
        const firstWrite = preserveInvalidLocalProjectsSnapshot('{second-damaged}', 'second_invalid_json');
        const secondWrite = preserveInvalidLocalProjectsSnapshot('{second-damaged}', 'second_invalid_json');
        const stored = JSON.parse(localStorage.getItem(key));
        return {
          firstWrite, secondWrite, primaryRaw: stored.raw,
          backups: Array.isArray(stored.backups) ? stored.backups : []
        };
      } finally {
        if (oldRecovery === null) localStorage.removeItem(key);
        else localStorage.setItem(key, oldRecovery);
      }
    });
    assert.equal(multipleRecoveryBackups.firstWrite, true,
      'a second malformed snapshot should be preserved without replacing the first recovery copy');
    assert.equal(multipleRecoveryBackups.secondWrite, true,
      're-preserving the same damaged snapshot should be idempotent');
    assert.equal(multipleRecoveryBackups.primaryRaw, '{first-damaged}',
      'the original recovery backup must remain byte-for-byte intact');
    assert.equal(multipleRecoveryBackups.backups.length, 1,
      'the second recovery snapshot should be stored once, without duplicates');
    assert.equal(multipleRecoveryBackups.backups[0].raw, '{second-damaged}',
      'the additional malformed snapshot must remain recoverable');

    const unreadableRecoverySlot = await page.evaluate(() => {
      const key = 'codelab_xd_projects_recovery_v1';
      const oldRecovery = localStorage.getItem(key);
      try {
        const unreadable = '{recovery-slot-is-corrupt';
        localStorage.setItem(key, unreadable);
        const preserved = preserveInvalidLocalProjectsSnapshot('{new-damaged}', 'invalid_json');
        return { preserved, stored: localStorage.getItem(key), original: unreadable };
      } finally {
        if (oldRecovery === null) localStorage.removeItem(key);
        else localStorage.setItem(key, oldRecovery);
      }
    });
    assert.equal(unreadableRecoverySlot.preserved, false,
      'an unreadable recovery slot must block replacement rather than risking the previous recovery data');
    assert.equal(unreadableRecoverySlot.stored, unreadableRecoverySlot.original,
      'a malformed recovery slot must remain untouched when a safe merge is impossible');

    // Corrupt local project snapshots must be backed up byte-for-byte before
    // normal startup replaces the active snapshot with an empty/default project.
    for (const damagedSnapshot of [
      { raw: '{"projects":"not-an-array"}', reason: 'projects_not_array' },
      { raw: '{"broken-json":', reason: 'invalid_json' }
    ]) {
      const recoveryContext = await browser.newContext({ viewport: { width: 900, height: 700 } });
      const recoveryPage = await recoveryContext.newPage();
      await recoveryPage.addInitScript(({ raw }) => {
        localStorage.setItem('codelab_xd_projects_v2', raw);
      }, damagedSnapshot);
      await recoveryPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await recoveryPage.waitForFunction(() =>
        document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
      const recovery = await recoveryPage.evaluate(() => {
        const raw = localStorage.getItem('codelab_xd_projects_recovery_v1');
        return raw ? JSON.parse(raw) : null;
      });
      assert.ok(recovery, 'damaged local project snapshot should have a recovery backup');
      assert.equal(recovery.raw, damagedSnapshot.raw,
        'recovery must preserve the exact original local snapshot');
      assert.equal(recovery.reason, damagedSnapshot.reason,
        'recovery should classify malformed snapshot data');
      await recoveryContext.close();
    }

    // Pairwise cross-product: every supported layer type in every responsive
    // frame, with the real visible add/duplicate/delete/undo/redo controls.
    // Arbitrary user states are unbounded; this matrix covers finite type × frame combinations.
    await page.setViewportSize({ width: 1365, height: 900 });
    const originalDesignCard = page.locator('#projectsGrid > div').filter({
      has: page.locator('h4').getByText(PROJECT_NAME, { exact: true })
    });
    await originalDesignCard.locator('button[data-action="open"]').click();
    // Design → Web conversion intentionally keeps the same project and its
    // current workspace type. Reopen that project, then explicitly switch back
    // to Design before asserting the design canvas state.
    await page.locator('#switchToDesignBtn').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#switchToDesignBtn').click();
    await page.waitForFunction(name => {
      const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : null;
      const canvasCount = document.querySelectorAll('#designCanvas [data-design-id]').length;
      const projectCount = Array.isArray(project?.design?.elements) ? project.design.elements.length : 0;
      return project && project.name === name && project.type === 'design' &&
        !document.getElementById('designStudioPanel')?.classList.contains('hidden') &&
        canvasCount === projectCount;
    }, PROJECT_NAME, { timeout: 15000 });

    const matrixBaselineCount = await page.locator('#designCanvas [data-design-id]').count();
    const matrix = { frames: ['desktop', 'tablet', 'mobile'], types: ['heading', 'text', 'button', 'rectangle', 'ellipse', 'image'], cases: 0 };
    for (const frame of matrix.frames) {
      await page.selectOption('#designFrameSize', frame);
      for (const type of matrix.types) {
        const countBefore = await page.locator('#designCanvas [data-design-id]').count();
        await page.locator(`button[onclick="addDesignElement('${type}')"]`).click();
        await page.waitForFunction(expected => document.querySelectorAll('#designCanvas [data-design-id]').length === expected, countBefore + 1);
        const addedLayerId = await page.locator('#designCanvas [data-design-id]').last().getAttribute('data-design-id');
        assert.ok(addedLayerId, type + ' layer should expose its stable ID in ' + frame + ' frame');
        assert.equal(await page.locator('#designInspectorProperties').isVisible(), true,
          type + ' properties must be visible after adding it in ' + frame + ' frame');

        await page.locator('button[onclick="duplicateDesignElement()"]').click();
        await page.waitForFunction(expected => document.querySelectorAll('#designCanvas [data-design-id]').length === expected, countBefore + 2);
        await page.locator('button[onclick="deleteDesignElement()"]').click();
        await page.waitForFunction(expected => document.querySelectorAll('#designCanvas [data-design-id]').length === expected, countBefore + 1);
        await page.locator('#designUndoBtn').click();
        await page.waitForFunction(expected => document.querySelectorAll('#designCanvas [data-design-id]').length === expected, countBefore + 2);
        await page.locator('#designRedoBtn').click();
        await page.waitForFunction(expected => document.querySelectorAll('#designCanvas [data-design-id]').length === expected, countBefore + 1);
        await page.locator('#designCanvas [data-design-id="' + addedLayerId + '"]').click();
        await page.locator('button[onclick="deleteDesignElement()"]').click();
        await page.waitForFunction(expected => document.querySelectorAll('#designCanvas [data-design-id]').length === expected, countBefore);
        matrix.cases += 1;
      }
    }
    assert.equal(matrix.cases, 18, 'all 6 layer types must complete add/duplicate/delete/undo/redo in all 3 responsive frames');
    assert.equal(await page.locator('#designCanvas [data-design-id]').count(), matrixBaselineCount,
      'the matrix must clean up temporary layers without changing the original design content');
    await page.evaluate(async () => {
      if (typeof saveCurrentCodeToActiveProject === 'function') await saveCurrentCodeToActiveProject(true);
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    // The app intentionally returns to the dashboard after reload instead of
    // persisting editor selection; reopen the design before checking durability.
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible', timeout: 10000 });
    const reloadedDesignCard = page.locator('#projectsGrid > div').filter({
      has: page.locator('h4').getByText(PROJECT_NAME, { exact: true })
    });
    await reloadedDesignCard.locator('button[data-action="open"]').click();
    await page.waitForFunction(expected => {
      const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : null;
      return project && project.name === expected.name && project.type === 'design' &&
        document.querySelectorAll('#designCanvas [data-design-id]').length === expected.count;
    }, { name: PROJECT_NAME, count: matrixBaselineCount }, { timeout: 15000 });

    // End-to-end node graph: a specific option routes to another design page,
    // and conversion emits both connected pages as a working single-page web app.
    const sourceProjectId = await page.evaluate(() => getCurrentProject().id);
    await page.locator(`button[onclick="addDesignElement('button')"]`).click();
    const flowButtonId = await page.evaluate(() => getCurrentProject().design.elements.filter(el => el.type === 'button').at(-1)?.id);
    await page.locator('#studioView button').filter({ hasText: 'Proyectos' }).first().click();
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible' });
    const targetName = 'Página destino de nodos ' + Date.now();
    await page.getByRole('button', { name: /Crear proyecto/i }).click();
    await page.locator('#newProjectNameInput').fill(targetName);
    await page.locator('input[name="newProjectType"][value="design"]').check();
    await page.locator('#newProjectModal button').filter({ hasText: 'Crear Proyecto' }).click();
    await page.locator('#designStudioPanel').waitFor({ state: 'visible', timeout: 15000 });
    const targetProjectId = await page.evaluate(() => getCurrentProject().id);
    await page.locator(`button[onclick="addDesignElement('heading')"]`).click();
    await page.locator('#openDesignFlowGraph').click();
    await page.locator('#designFlowGraphModal').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#designFlowChoose').click();
    await page.locator('[data-flow-action="' + flowButtonId + '"][data-flow-source-project="' + sourceProjectId + '"]').click();
    await page.waitForFunction(id => document.querySelector('[data-flow-action="' + id + '"]')?.className.includes('border-yellow-300'), flowButtonId, { timeout: 5000 });
    const flowSource = page.locator('[data-flow-source-port="' + flowButtonId + '"]');
    const flowTarget = page.locator('[data-flow-target-project="' + targetProjectId + '"]');
    await flowSource.waitFor({ state: 'visible' });
    // Use real pointer coordinates: locator.dragTo may trigger HTML drag events
    // without reliably reproducing the editor's pointer-driven connection gesture.
    const sourceBox = await flowSource.boundingBox();
    const targetBox = await flowTarget.boundingBox();
    assert.ok(sourceBox && targetBox, 'source port and destination page must have visible bounds');
    const startX = sourceBox.x + sourceBox.width / 2;
    const startY = sourceBox.y + sourceBox.height / 2;
    const endX = targetBox.x + Math.min(160, targetBox.width - 10);
    const endY = targetBox.y + 25;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(({ sourceProjectId, flowButtonId, targetProjectId }) => {
      const source = projects.find(item => item.id === sourceProjectId);
      return source?.design?.flowConnections?.some(c => c.sourceElementId === flowButtonId && c.targetProjectId === targetProjectId);
    }, { sourceProjectId, flowButtonId, targetProjectId }, { timeout: 10000 });
    // Invalid self-links must be rejected and must not overwrite the valid route.
    const selfSource = await page.locator('[data-flow-source-port="' + flowButtonId + '"][data-flow-project="' + sourceProjectId + '"]').boundingBox();
    const selfCard = await page.locator('[data-flow-target-project="' + sourceProjectId + '"]').boundingBox();
    assert.ok(selfSource && selfCard, 'source port and same-page target bounds must exist for invalid-link test');
    await page.mouse.move(selfSource.x + selfSource.width / 2, selfSource.y + selfSource.height / 2);
    await page.mouse.down();
    await page.mouse.move(selfCard.x + selfCard.width / 2, selfCard.y + selfCard.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.evaluate(({ sourceProjectId, flowButtonId }) => {
      const source = projects.find(item => item.id === sourceProjectId);
      const outgoing = source?.design?.flowConnections?.filter(c => c.sourceElementId === flowButtonId) || [];
      return outgoing.length === 1 && outgoing[0].targetProjectId !== sourceProjectId;
    }, { sourceProjectId, flowButtonId }), true, 'self-links must be rejected without replacing the existing valid connection');
    assert.equal(await page.evaluate(({ sourceProjectId, flowButtonId }) => {
      const source = projects.find(item => item.id === sourceProjectId);
      return source?.design?.flowConnections?.filter(c => c.sourceElementId === flowButtonId).length || 0;
    }, { sourceProjectId, flowButtonId }), 1, 'one drag must create exactly one outgoing connection');
    // Verify the connection reaches durable server storage, not only the in-memory UI.
    // Long-run option endurance: repeatedly remove and recreate the same route
    // through visible UI controls, asserting exactly one route remains each time.
    for (let cycle = 1; cycle <= 15; cycle += 1) {
      await page.locator('[data-flow-remove="' + flowButtonId + '"][data-flow-project="' + sourceProjectId + '"][data-flow-target="' + targetProjectId + '"]').click();
      await page.waitForFunction(({ sourceProjectId, flowButtonId }) => {
        const source = projects.find(item => item.id === sourceProjectId);
        return !(source?.design?.flowConnections || []).some(connection => connection.sourceElementId === flowButtonId);
      }, { sourceProjectId, flowButtonId }, { timeout: 5000 });
      const repeatSource = await page.locator('[data-flow-source-port="' + flowButtonId + '"][data-flow-project="' + sourceProjectId + '"]').boundingBox();
      const repeatTarget = await page.locator('[data-flow-target-project="' + targetProjectId + '"]').boundingBox();
      assert.ok(repeatSource && repeatTarget, 'repeated option cycle ' + cycle + ' must retain source and target controls');
      await page.mouse.move(repeatSource.x + repeatSource.width / 2, repeatSource.y + repeatSource.height / 2);
      await page.mouse.down();
      await page.mouse.move(repeatTarget.x + Math.min(160, repeatTarget.width - 10), repeatTarget.y + 25, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(({ sourceProjectId, flowButtonId, targetProjectId }) => {
        const source = projects.find(item => item.id === sourceProjectId);
        const routes = (source?.design?.flowConnections || []).filter(connection => connection.sourceElementId === flowButtonId);
        return routes.length === 1 && routes[0].targetProjectId === targetProjectId;
      }, { sourceProjectId, flowButtonId, targetProjectId }, { timeout: 5000 });
    }
    console.log('Option endurance passed: 15 remove/reconnect cycles without duplicate or lost routes.');

    // Run a touch-enabled browser context against the same persisted workspace.
    // CDP touch events exercise the pointer-driven node connection gesture as a touchscreen would.
    const touchContext = await browser.newContext({
      viewport: { width: 844, height: 900 }, isMobile: true, hasTouch: true,
      storageState: await context.storageState()
    });
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', error => failures.push('touch: ' + (error.stack || error.message)));
    await touchPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await touchPage.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    const touchSourceCard = touchPage.locator('#projectsGrid > div').filter({ has: touchPage.locator('h4').getByText(PROJECT_NAME, { exact: true }) });
    await touchSourceCard.locator('button[data-action="open"]').click();
    await touchPage.waitForFunction(id => getCurrentProject()?.id === id, sourceProjectId, { timeout: 15000 });
    if (await touchPage.locator('#switchToDesignBtn').isVisible()) {
      await touchPage.locator('#switchToDesignBtn').click();
      await touchPage.waitForFunction(id => getCurrentProject()?.id === id && getCurrentProject()?.type === 'design', sourceProjectId, { timeout: 10000 });
    }
    await touchPage.locator('#openDesignFlowGraph').click();
    await touchPage.locator('#designFlowGraphModal').waitFor({ state: 'visible', timeout: 10000 });
    await touchPage.locator('#designFlowChoose').click();
    await touchPage.locator('[data-flow-action="' + flowButtonId + '"][data-flow-source-project="' + sourceProjectId + '"]').click();
    const touchPort = touchPage.locator('[data-flow-source-port="' + flowButtonId + '"][data-flow-project="' + sourceProjectId + '"]');
    const touchTarget = touchPage.locator('[data-flow-target-project="' + targetProjectId + '"]');
    await touchPort.waitFor({ state: 'visible', timeout: 10000 });
    const touchSourceBox = await touchPort.boundingBox();
    const touchTargetBox = await touchTarget.boundingBox();
    assert.ok(touchSourceBox && touchTargetBox, 'touch graph must expose source and destination bounds');
    const cdp = await touchContext.newCDPSession(touchPage);
    const touchX = touchSourceBox.x + touchSourceBox.width / 2;
    const touchY = touchSourceBox.y + touchSourceBox.height / 2;
    const destX = touchTargetBox.x + Math.min(140, touchTargetBox.width - 10);
    const destY = touchTargetBox.y + 25;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: touchY, id: 1 }] });
    for (let step = 1; step <= 10; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: touchX + (destX - touchX) * step / 10,
        y: touchY + (destY - touchY) * step / 10, id: 1
      }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touchPage.waitForFunction(({ sourceProjectId, flowButtonId, targetProjectId }) => {
      const source = projects.find(item => item.id === sourceProjectId);
      return source?.design?.flowConnections?.some(connection => connection.sourceElementId === flowButtonId && connection.targetProjectId === targetProjectId);
    }, { sourceProjectId, flowButtonId, targetProjectId }, { timeout: 10000 });
    await touchContext.close();
    console.log('Touchscreen node-connection E2E passed in touch-enabled 844×900 mobile-browser context.');

    await page.waitForFunction(async ({ sourceProjectId, flowButtonId, targetProjectId }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), { headers: { 'x-workspace-token': token } });
        if (!response.ok) return false;
        const data = await response.json();
        const source = data.projects?.find(item => item.id === sourceProjectId);
        return source?.design?.flowConnections?.some(c => c.sourceElementId === flowButtonId && c.targetProjectId === targetProjectId) === true;
      } catch (_) { return false; }
    }, { sourceProjectId, flowButtonId, targetProjectId }, { timeout: 15000 });
    await page.locator('#designFlowClose').click();
    // A full browser reload must restore the connection from persisted workspace data.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible', timeout: 15000 });
    const sourceCard = page.locator('#projectsGrid > div').filter({ has: page.locator('h4').getByText(PROJECT_NAME, { exact: true }) });
    await sourceCard.locator('button[data-action="open"]').click();
    await page.waitForFunction(expected => getCurrentProject()?.id === expected, sourceProjectId, { timeout: 15000 });
    await page.locator('button[onclick="convertDesignToWeb()"]').click();
    await page.waitForFunction(() => document.getElementById('designStudioPanel')?.classList.contains('hidden') &&
      !document.getElementById('studioView')?.classList.contains('hidden') && typeof getCurrentProject === 'function' &&
      getCurrentProject()?.type === 'web', null, { timeout: 15000 });
    const generatedFlowHtml = await page.evaluate(() => getCurrentProject().code.html);
    assert.ok(generatedFlowHtml.includes('data-page-id="' + sourceProjectId + '"'), 'generated web must include the source design page');
    assert.ok(generatedFlowHtml.includes('data-page-id="' + targetProjectId + '"'), 'generated web must include the connected destination page');
    assert.ok(generatedFlowHtml.includes('data-flow-to="' + targetProjectId + '"'), 'generated option must navigate to the connected destination');
    // Execute the generated standalone web app and verify the actual route, not just its markup.
    const flowPreview = await context.newPage();
    flowPreview.on('pageerror', error => failures.push(error.message));
    await flowPreview.setContent(generatedFlowHtml);
    await flowPreview.locator('[data-page-id="' + sourceProjectId + '"]:not([hidden])').waitFor({ state: 'visible' });
    await flowPreview.locator('[data-flow-to="' + targetProjectId + '"]').first().click();
    await flowPreview.waitForFunction(id => {
      const target = Array.from(document.querySelectorAll('[data-page-id]')).find(section => section.getAttribute('data-page-id') === id);
      return !!target && !target.hidden;
    }, targetProjectId, { timeout: 5000 });
    assert.equal(await flowPreview.locator('[data-page-id="' + sourceProjectId + '"]').evaluate(el => el.hidden), true,
      'navigating to the connected page must hide the source page');
    await flowPreview.close();

    // Conversion updates the web space on the same project; switching editors
    // must preserve identity and both the design document and generated web.
    const sharedProjectId = await page.evaluate(() => getCurrentProject().id);
    assert.equal(sharedProjectId, sourceProjectId, 'design-to-web conversion must not create a second project');
    assert.ok(await page.evaluate(() => !!getCurrentProject().design), 'the source design document must remain attached');
    // The conversion exposes type='web' before its awaited persistence settles.
    // Wait for its mutation lock to release before issuing another workspace action.
    await page.waitForFunction(() => typeof creatingProjectInFlight !== 'undefined' && !creatingProjectInFlight,
      null, { timeout: 15000 });
    await page.locator('#switchToDesignBtn').click();
    try {
      await page.waitForFunction(expected => getCurrentProject()?.id === expected && getCurrentProject()?.type === 'design',
        sourceProjectId, { timeout: 10000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        project: typeof getCurrentProject === 'function' ? { id: getCurrentProject()?.id, type: getCurrentProject()?.type } : null,
        mutationLock: typeof creatingProjectInFlight !== 'undefined' ? creatingProjectInFlight : 'unavailable',
        syncStatus: document.getElementById('syncStatus')?.innerText || '',
        visibleToasts: Array.from(document.querySelectorAll('[role=alert], [data-toast], .toast')).map(el => el.innerText).filter(Boolean).slice(-5)
      }));
      throw new Error('Workspace switch to design did not complete: ' + JSON.stringify(state) + '; ' + error.message);
    }
    await page.waitForFunction(() => !document.getElementById('designStudioPanel')?.classList.contains('hidden'));
    // Workspace type changes before the async persistence lock is released.
    await page.waitForFunction(() => typeof creatingProjectInFlight !== 'undefined' && !creatingProjectInFlight,
      null, { timeout: 15000 });
    await page.locator('#switchToWebBtn').click();
    await page.waitForFunction(expected => getCurrentProject()?.id === expected && getCurrentProject()?.type === 'web',
      sourceProjectId, { timeout: 10000 });
    assert.ok((await page.evaluate(() => getCurrentProject().code.html)).includes('data-page-id="' + targetProjectId + '"'),
      'web code must remain on the shared project after switching editors');
    assert.ok(await page.evaluate(() => !!getCurrentProject().design), 'design data must survive web/design switching');

    // Long-run workspace-switch endurance: alternate Web/Design repeatedly and
    // verify the same project retains both representations after every cycle.
    for (let cycle = 1; cycle <= 12; cycle += 1) {
      await page.locator('#switchToDesignBtn').click();
      await page.waitForFunction(id => getCurrentProject()?.id === id && getCurrentProject()?.type === 'design' &&
        Array.isArray(getCurrentProject()?.design?.elements), sourceProjectId, { timeout: 10000 });
      await page.waitForFunction(() => typeof creatingProjectInFlight !== 'undefined' && !creatingProjectInFlight,
        null, { timeout: 15000 });
      await page.locator('#switchToWebBtn').click();
      await page.waitForFunction(id => getCurrentProject()?.id === id && getCurrentProject()?.type === 'web' &&
        typeof getCurrentProject()?.code?.html === 'string', sourceProjectId, { timeout: 10000 });
      const retained = await page.evaluate(({ sourceProjectId, targetProjectId }) => {
        const project = projects.find(item => item.id === sourceProjectId);
        return {
          designElements: project?.design?.elements?.length || 0,
          hasDesignButton: project?.design?.elements?.some(element => element.id && element.type === 'button') || false,
          hasWebTarget: String(project?.code?.html || '').includes('data-page-id="' + targetProjectId + '"')
        };
      }, { sourceProjectId, targetProjectId });
      assert.ok(retained.designElements > 0 && retained.hasDesignButton && retained.hasWebTarget,
        'workspace cycle ' + cycle + ' must retain design layers and generated web pages');
      await page.waitForFunction(() => typeof creatingProjectInFlight !== 'undefined' && !creatingProjectInFlight,
        null, { timeout: 15000 });
    }
    console.log('Workspace-switch endurance passed: 12 consecutive Web ↔ Design cycles preserved design and web content.');

    // Deleting a destination page must remove inbound graph links durably,
    // without deleting the already-generated standalone web page content.
    await page.locator('#studioView button').filter({ hasText: 'Proyectos' }).first().click();
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible', timeout: 10000 });
    const targetCard = page.locator('#projectsGrid > div').filter({ has: page.locator('h4').getByText(targetName, { exact: true }) });
    page.once('dialog', dialog => dialog.accept());
    await targetCard.locator('button[data-action="delete"]').click();
    await page.waitForFunction(id => !projects.some(project => project.id === id), targetProjectId, { timeout: 10000 });
    assert.equal(await page.evaluate(({ sourceProjectId, targetProjectId }) => {
      const source = projects.find(project => project.id === sourceProjectId);
      return (source?.design?.flowConnections || []).some(connection => connection.targetProjectId === targetProjectId);
    }, { sourceProjectId, targetProjectId }), false, 'deleted destination must not leave a dangling connection in the source design');
    await page.waitForFunction(async ({ sourceProjectId, targetProjectId }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), { headers: { 'x-workspace-token': token } });
        if (!response.ok) return false;
        const data = await response.json();
        const source = data.projects?.find(project => project.id === sourceProjectId);
        return !(source?.design?.flowConnections || []).some(connection => connection.targetProjectId === targetProjectId);
      } catch (_) { return false; }
    }, { sourceProjectId, targetProjectId }, { timeout: 15000 });

    // Persistence endurance after real mutations: repeatedly reopen the same
    // project after the destination page is deleted, confirming that the source
    // design, generated web code, and graph cleanup survive server round-trips.
    const durableSourceName = PROJECT_NAME;
    for (let reloadCycle = 1; reloadCycle <= 6; reloadCycle += 1) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
      await page.locator('#welcomeDashboard').waitFor({ state: 'visible', timeout: 15000 });
      const durableCard = page.locator('#projectsGrid > div').filter({
        has: page.locator('h4').getByText(durableSourceName, { exact: true })
      });
      await durableCard.locator('button[data-action="open"]').click();
      await page.waitForFunction(id => getCurrentProject()?.id === id, sourceProjectId, { timeout: 15000 });
      const durableState = await page.evaluate(({ sourceProjectId, targetProjectId }) => {
        const project = projects.find(item => item.id === sourceProjectId);
        return {
          sameProject: getCurrentProject()?.id === sourceProjectId,
          hasDesignLayers: (project?.design?.elements || []).some(element => element.type === 'button'),
          hasGeneratedWeb: String(project?.code?.html || '').includes('data-page-id="' + targetProjectId + '"'),
          hasDanglingConnection: (project?.design?.flowConnections || []).some(connection => connection.targetProjectId === targetProjectId)
        };
      }, { sourceProjectId, targetProjectId });
      assert.equal(durableState.sameProject, true, 'reload cycle ' + reloadCycle + ' must reopen the original project identity');
      assert.equal(durableState.hasDesignLayers, true, 'reload cycle ' + reloadCycle + ' must retain design layers');
      assert.equal(durableState.hasGeneratedWeb, true, 'reload cycle ' + reloadCycle + ' must retain generated web output');
      assert.equal(durableState.hasDanglingConnection, false, 'reload cycle ' + reloadCycle + ' must not restore deleted-page links');
      await page.waitForFunction(() => typeof creatingProjectInFlight !== 'undefined' && !creatingProjectInFlight,
        null, { timeout: 15000 });
      console.log('Persistence/reload endurance passed: ' + reloadCycle + '/6 cycles.');
      await page.evaluate(() => returnToDashboard());
      await page.locator('#welcomeDashboard').waitFor({ state: 'visible', timeout: 10000 });
    }
    console.log('Persistence endurance passed: six full reload/reopen cycles retained both workspaces and graph cleanup.');

    assert.deepEqual(failures, [], 'production page should not throw uncaught JavaScript errors');
    console.log('Full CodeLab system E2E passed: design create/edit → responsive canvas → AI PNG/JSON capture → reload/offline recovery → web conversion → workspace design-system save/export/reload → component insertion → 429 retry → 413 recovery → 400 validation recovery → server persistence.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Full design workflow E2E failed:', error);
  process.exitCode = 1;
});
