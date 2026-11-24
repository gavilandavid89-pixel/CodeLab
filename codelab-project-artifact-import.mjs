import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { installCodeLabPackage } from './codelab-project-package-installer.mjs';

const execFileAsync = promisify(execFile);

const MAX_CODELAB_ARTIFACT_BYTES = 100 * 1024 * 1024;

export function canonicalCodeLabArtifactFilename(filename, editorId) {
  const suffixByEditor = { web: 'web', design: 'design', pixelforge: 'pixelforge' };
  const suffix = suffixByEditor[String(editorId || '').toLowerCase()];
  if (!suffix) throw new Error('Unsupported CodeLab artifact editor: ' + String(editorId || ''));
  const base = path.basename(String(filename || 'project.codelab')).slice(0, 180) || 'project.codelab';
  const typed = base.match(/^(.*)\.codelab-(web|design|pixelforge)$/i);
  if (typed) {
    if (typed[2].toLowerCase() !== suffix) {
      throw new Error('Artifact filename editor suffix does not match the import request editor_id.');
    }
    return typed[1] + '.codelab-' + suffix;
  }
  if (/\.codelab$/i.test(base)) return base + '-' + suffix;
  throw new Error('CodeLab artifact filename must end in .codelab or .codelab-' + suffix + '.');
}

async function queryChecked(pool, label, text, values) {
  const placeholderMatches = [...text.matchAll(/\$(\d+)/g)];
  const maxPlaceholder = placeholderMatches.reduce((m, match) => Math.max(m, Number(match[1])), 0);
  if (maxPlaceholder !== values.length) {
    throw new Error(`SQL parameter mismatch in ${label}: query requires ${maxPlaceholder}, values supplied ${values.length}`);
  }
  try {
    return await pool.query(text, values);
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function stableJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(item => stableJsonStringify(item) ?? 'null').join(',') + ']';
  }
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableJsonStringify(value[key])).join(',') + '}';
}

export function assertCodelabPackageEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('Invalid CodeLab package entry list.');
  const normalizedEntries = new Set();
  for (const entry of entries) {
    if (!assertSafePath(entry)) throw new Error(`Unsafe path in CodeLab package: ${entry}`);
    const normalized = entry.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalizedEntries.has(normalized)) throw new Error(`Duplicate entry in CodeLab package: ${entry}`);
    normalizedEntries.add(normalized);
  }
  const markers = ['project.codelab', 'project.codelab-web', 'project.codelab-design', 'project.codelab-pixelforge']
    .filter(marker => normalizedEntries.has(marker));
  if (!markers.length) {
    throw new Error('Not a CodeLab project: root editor-specific project.codelab marker is missing.');
  }
  if (markers.length > 1) throw new Error('Invalid CodeLab package: multiple editor marker files are present.');
  if (!normalizedEntries.has('manifest.json') || !normalizedEntries.has('project.json')) {
    throw new Error('Invalid CodeLab project: root manifest.json and project.json are required.');
  }
  return true;
}

async function assertZipArchive(buffer, tempRoot) {
  const archive = path.join(tempRoot, 'integrity-check.codelab');
  await fs.writeFile(archive, buffer);
  try {
    await execFileAsync('unzip', ['-tq', archive], { timeout: 30_000 });
  } catch {
    throw new Error('The .codelab artifact is corrupted or incomplete and cannot be imported.');
  }
}

function assertSafePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) return false;
  return true;
}

function contentTypeForPath(filePath) {
  const lower = filePath.toLowerCase();
  const extension = lower.split('.').at(-1);
  const types = {
    json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', rtf: 'application/rtf',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    css: 'text/css', scss: 'text/x-scss', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript', html: 'text/html', htm: 'text/html',
    csv: 'text/csv', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', fbx: 'application/octet-stream',
  };
  return types[extension] || 'application/octet-stream';
}

async function extractCodelabArchive(buffer, tempRoot) {
  const archive = path.join(tempRoot, 'project.codelab');
  const extractDir = path.join(tempRoot, 'project');
  await fs.mkdir(extractDir, { recursive: true });
  await fs.writeFile(archive, buffer);

  const { stdout } = await execFileAsync('unzip', ['-Z1', archive], { timeout: 30_000 });
  const entries = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  assertCodelabPackageEntries(entries);

  await execFileAsync('unzip', ['-oq', archive, '-d', extractDir], { timeout: 30_000 });
  return extractDir;
}

async function collectProjectFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (!assertSafePath(relative)) throw new Error(`Unsafe extracted path: ${relative}`);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in CodeLab packages: ${relative}`);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && !['project.codelab', 'project.codelab-web', 'project.codelab-design', 'project.codelab-pixelforge', 'manifest.json', 'project.json'].includes(relative)) {
        files.push({ absolute, relative });
      } else if (!entry.isFile()) throw new Error(`Unsupported filesystem entry in CodeLab package: ${relative}`);
    }
  }
  return files;
}

async function readProjectPackage(buffer, tempRoot) {
  const root = await extractCodelabArchive(buffer, tempRoot);
  const manifestPath = path.join(root, 'manifest.json');
  const projectPath = path.join(root, 'project.json');
  const [manifestText, projectText] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.readFile(projectPath, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  const project = JSON.parse(projectText);
  const rootEntries = await fs.readdir(root);
  const marker = rootEntries.find(name => ['project.codelab', 'project.codelab-web', 'project.codelab-design', 'project.codelab-pixelforge'].includes(name));
  const markerEditor = marker && marker !== 'project.codelab' ? marker.slice('project.codelab-'.length) : null;
  if (markerEditor && markerEditor !== String(manifest.editor)) {
    throw new Error('CodeLab package marker editor does not match manifest.editor.');
  }
  if (manifest.format !== 'codelab' || ![1, 2].includes(Number(manifest.version))) {
    throw new Error('Unsupported .codelab package format.');
  }
  if (Number(manifest.version) === 2 && (Number(manifest.schemaVersion) !== 2 || manifest.layout !== 'structured')) {
    throw new Error('CodeLab v2 packages must declare schemaVersion=2 and layout=structured.');
  }
  if (!['pixelforge', 'web', 'design'].includes(String(manifest.editor))) {
    throw new Error('The .codelab manifest must declare an active editor explicitly.');
  }
  if (manifest.entry !== 'project.json') {
    throw new Error('The .codelab manifest entry must be project.json.');
  }
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error('project.json is invalid.');
  }
  return { manifest, project };
}

export async function publishImportedCodeLabProjectToWorkspace(pool, workspaceId, project, editorId) {
  if (!['web', 'design'].includes(String(editorId))) {
    return { published: false, reason: 'editor_uses_dedicated_workspace' };
  }
  if (!workspaceId || !project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error('Imported CodeLab project cannot be published to an invalid workspace.');
  }
  if (typeof project.id !== 'string' || !project.id.trim() || project.id.length > 80) {
    throw new Error('Imported CodeLab project ID is not valid for the editor workspace.');
  }
  if (typeof project.name !== 'string' || !project.name.trim() || project.name.length > 200) {
    throw new Error('Imported CodeLab project name is not valid for the editor workspace.');
  }
  if (!project.code || typeof project.code !== 'object' || Array.isArray(project.code)) {
    throw new Error('Imported CodeLab project has no normalized code document.');
  }
  for (const field of ['html', 'css', 'js']) {
    if (typeof project.code[field] !== 'string' || project.code[field].length > 500_000) {
      throw new Error('Imported CodeLab project contains an invalid code.' + field + ' field.');
    }
  }
  if (editorId === 'design') {
    if (!project.design || !Array.isArray(project.design.elements) || project.design.elements.length > 2000) {
      throw new Error('Imported Design project has an invalid element list.');
    }
    const elementIds = new Set();
    for (const element of project.design.elements) {
      if (!element || typeof element !== 'object' || Array.isArray(element) ||
          typeof element.id !== 'string' || !element.id.trim() || element.id.length > 100 ||
          elementIds.has(element.id)) {
        throw new Error('Imported Design project contains an invalid or duplicate element ID.');
      }
      elementIds.add(element.id);
    }
  }

  // Compare-and-swap protects concurrent editor saves while making the imported
  // document visible in the same workspace that the normal CodeLab UI loads.
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await queryChecked(pool, 'workspace_publish_read',
      'SELECT state, revision FROM public.codelab_workspace_states WHERE workspace_id=$1',
      [workspaceId]
    );
    if (!current.rowCount) throw new Error('Target CodeLab workspace does not exist: ' + workspaceId);
    const stored = current.rows[0].state && typeof current.rows[0].state === 'object'
      ? current.rows[0].state : {};
    const projects = Array.isArray(stored.projects) ? [...stored.projects] : [];
    const existingIndex = projects.findIndex(item => item && item.id === project.id);
    if (existingIndex >= 0) projects[existingIndex] = project;
    else {
      if (projects.length >= 50) throw new Error('Target CodeLab workspace has reached its 50-project limit.');
      projects.unshift(project);
    }
    const revision = Number(current.rows[0].revision) || 0;
    const updatedAt = new Date().toISOString();
    const nextState = {
      ...stored,
      version: 5,
      revision: revision + 1,
      updatedAt,
      projects,
    };
    const updated = await queryChecked(pool, 'workspace_publish_write',
      'UPDATE public.codelab_workspace_states SET revision=$2,state=$3::jsonb,updated_at=$4 WHERE workspace_id=$1 AND revision=$5 RETURNING revision',
      [workspaceId, revision + 1, JSON.stringify(nextState), updatedAt, revision]
    );
    if (updated.rowCount) {
      return {
        published: true,
        workspaceId,
        workspaceRevision: revision + 1,
        projectCount: projects.length,
        replacedExisting: existingIndex >= 0,
      };
    }
  }
  throw new Error('CodeLab workspace changed repeatedly during project import; retry the import.');
}

export async function importCodeLabArtifact(pool, {
  importRequestId,
  workspaceId,
  pixelForgeWorkspaceId,
  targetWorkspaceId = null,
  artifactBase64 = null,
  artifactBuffer = null,
  artifactFilename = 'project.codelab',
  artifactContentType = 'application/zip',
}) {
  if (!importRequestId) throw new Error('import_request_id is required.');

  const requestResult = await queryChecked(pool, 'import_sql', 
    'SELECT import_request_id, workspace_id, editor_id, source_project_id, source_sha256, manifest, status, confirmation_required, confirmation_received, work_score FROM public.codelab_project_import_requests WHERE import_request_id=$1',
    [importRequestId]
  );
  if (!requestResult.rowCount) throw new Error('Import request not found: ' + importRequestId);

  const request = requestResult.rows[0];
  artifactFilename = canonicalCodeLabArtifactFilename(artifactFilename, request.editor_id);
  if (request.workspace_id !== workspaceId) throw new Error('Import request workspace is not authorized for this bridge.');
  const destinationWorkspaceId = targetWorkspaceId || request.workspace_id || pixelForgeWorkspaceId;
  if (typeof destinationWorkspaceId !== 'string' || !/^ws_[a-zA-Z0-9_-]{1,140}$/.test(destinationWorkspaceId)) {
    throw new Error('Import target workspace is invalid.');
  }
  if (request.confirmation_required && !request.confirmation_received && request.status !== 'approved') {
    return {
      status: 'awaiting_confirmation',
      importRequestId,
      editorId: request.editor_id,
      message: 'Confirmation is required before this import can rewrite a similar project.',
    };
  }
  if (!['queued', 'approved'].includes(request.status)) {
    throw new Error('Import request is not importable in status: ' + request.status);
  }

  // Inline transport fallback: durable command payload -> Neon BYTEA.
  // This keeps the artifact self-contained in Postgres and avoids any S3/Object Storage dependency.
  const suppliedArtifactBuffer = Buffer.isBuffer(artifactBuffer)
    ? artifactBuffer
    : (artifactBase64 ? (() => {
        if (typeof artifactBase64 !== 'string' || artifactBase64.length > 140_000_000) {
          throw new Error('Inline .codelab artifact exceeds the transport envelope.');
        }
        return Buffer.from(artifactBase64, 'base64');
      })() : null);

  if (suppliedArtifactBuffer) {
    if (!suppliedArtifactBuffer.length) throw new Error('Inline .codelab artifact is empty.');
    if (suppliedArtifactBuffer.length > MAX_CODELAB_ARTIFACT_BYTES) {
      throw new Error(`Artifact exceeds maximum supported size of ${MAX_CODELAB_ARTIFACT_BYTES} bytes.`);
    }
    const inlineSha = sha256(suppliedArtifactBuffer);
    await queryChecked(pool, 'inline_artifact_sql',
      `INSERT INTO public.codelab_project_artifacts
        (artifact_id, import_request_id, workspace_id, editor_id, source_project_id, filename, content_type, sha256, byte_size, artifact, status, created_at, updated_at)
       SELECT gen_random_uuid(), import_request_id, workspace_id, editor_id, source_project_id, $2, $3, $4, $5, $6, 'uploaded', now(), now()
       FROM public.codelab_project_import_requests
       WHERE import_request_id=$1`,
      [importRequestId, artifactFilename, artifactContentType, inlineSha, suppliedArtifactBuffer.length, suppliedArtifactBuffer]
    );
  }

  const artifactResult = await queryChecked(pool, 'import_sql', 
    'SELECT artifact_id, filename, content_type, sha256, byte_size, artifact FROM public.codelab_project_artifacts WHERE import_request_id=$1 AND status=\'uploaded\' ORDER BY created_at DESC LIMIT 1',
    [importRequestId]
  );
  if (!artifactResult.rowCount) throw new Error('No uploaded .codelab artifact is attached to import request ' + importRequestId);

  const artifact = artifactResult.rows[0];
  const buffer = artifact.artifact;
  if (!buffer) throw new Error('Artifact bytes are missing from Neon.');
  if (buffer.length > MAX_CODELAB_ARTIFACT_BYTES) throw new Error(`Artifact exceeds maximum supported size of ${MAX_CODELAB_ARTIFACT_BYTES} bytes.`);
  if (Number(artifact.byte_size) !== buffer.length) throw new Error('Artifact byte size mismatch.');
  const actualSha = sha256(buffer);
  if (actualSha !== artifact.sha256 || (request.source_sha256 && request.source_sha256 !== actualSha)) {
    throw new Error('Artifact SHA-256 verification failed.');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-import-'));
  try {
    await assertZipArchive(buffer, tempRoot);
    await queryChecked(pool, 'import_sql', 
      'UPDATE public.codelab_project_import_requests SET status=\'running\', updated_at=now() WHERE import_request_id=$1',
      [importRequestId]
    );
    await queryChecked(pool, 'import_sql', 
      'UPDATE public.codelab_project_artifacts SET status=\'claimed\', updated_at=now() WHERE artifact_id=$1',
      [artifact.artifact_id]
    );

    const { manifest, project: sourceProject } = await readProjectPackage(buffer, tempRoot);
    const packageRoot = path.join(tempRoot, 'project');
    const packageFiles = await collectProjectFiles(packageRoot);
    const packageFileMap = new Map();
    for (const file of packageFiles) packageFileMap.set(file.relative, await fs.readFile(file.absolute));
    const project = structuredClone(sourceProject);
    const installation = installCodeLabPackage({ manifest, project, files: packageFileMap });
    const destinationPathByPath = new Map(installation.destinations.map(item => [item.path, item.destinationPath]));
    if (manifest.editor !== request.editor_id) {
      throw new Error('Manifest editor does not match the import request editor_id.');
    }
    if (manifest.projectType !== request.editor_id) {
      throw new Error('Manifest projectType does not match the import request editor_id.');
    }

    const projectId = String(project.id || request.source_project_id);
    const name = String(project.name || projectId).slice(0, 100);
    // Keep the revision embedded in the imported document aligned with the
    // dedicated PixelForge row. The editor sends project.serverRevision back
    // on its first save, so a DB revision of 1 paired with JSON revision 0
    // would make a freshly imported document conflict with its own first save.
    let pixelForgeServerRevision = null;
    if (request.editor_id === 'pixelforge') {
      const existingPixelForge = await queryChecked(pool, 'pixelforge_import_revision_read',
        'SELECT server_revision FROM public.codelab_pixelforge_projects WHERE workspace_id=$1 AND project_id=$2',
        [destinationWorkspaceId, projectId]
      );
      pixelForgeServerRevision = existingPixelForge.rowCount
        ? Number(existingPixelForge.rows[0].server_revision || 0) + 1
        : 1;
      project.serverRevision = pixelForgeServerRevision;
    }
    const serialized = JSON.stringify(project);
    const contentSha = sha256(Buffer.from(stableJsonStringify(project)));
    const now = Date.now();
    const workScore = Number(request.work_score ?? 0);

    await queryChecked(pool, 'import_sql', 
      `INSERT INTO public.codelab_project_registry
        (workspace_id, project_id, editor_id, name, project, content_sha256, work_score, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,now())
       ON CONFLICT (workspace_id, project_id) DO UPDATE SET
         editor_id=EXCLUDED.editor_id,
         name=EXCLUDED.name,
         project=EXCLUDED.project,
         content_sha256=EXCLUDED.content_sha256,
         work_score=EXCLUDED.work_score,
         updated_at=now()`,
      [destinationWorkspaceId, projectId, request.editor_id, name, serialized, contentSha, workScore]
    );

    if (packageFiles.length) {
      for (const file of packageFiles) {
        const fileBuffer = packageFileMap.get(file.relative);
        const fileSha = sha256(fileBuffer);
        await queryChecked(pool, 'import_sql', `
          INSERT INTO public.codelab_project_files
            (workspace_id, project_id, editor_id, file_path, content_type, byte_size, sha256, content, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (workspace_id, project_id, file_path) DO UPDATE SET
            editor_id=EXCLUDED.editor_id,
            content_type=EXCLUDED.content_type,
            byte_size=EXCLUDED.byte_size,
            sha256=EXCLUDED.sha256,
            content=EXCLUDED.content,
            updated_at=EXCLUDED.updated_at`,
          [destinationWorkspaceId, projectId, request.editor_id,
            destinationPathByPath.get(file.relative),
            contentTypeForPath(file.relative), fileBuffer.length, fileSha, fileBuffer, now]
        );
      }
    }

    // Persistence is the next source of truth: re-read what CodeLab just stored instead of
    // trusting the transferred in-memory payload for the remainder of the import.
    const rereadProjectResult = await queryChecked(pool, 'import_roundtrip_project_sql',
      'SELECT project, content_sha256 FROM public.codelab_project_registry WHERE workspace_id=$1 AND project_id=$2 AND editor_id=$3',
      [destinationWorkspaceId, projectId, request.editor_id]
    );
    if (rereadProjectResult.rowCount !== 1) throw new Error('Persisted CodeLab project could not be re-read after import.');
    const rereadProject = rereadProjectResult.rows[0].project;
    const rereadSha = sha256(Buffer.from(stableJsonStringify(rereadProject)));
    if (rereadSha !== contentSha || rereadProjectResult.rows[0].content_sha256 !== contentSha) {
      throw new Error('Persisted CodeLab project round-trip SHA-256 verification failed.');
    }
    const rereadFilesResult = await queryChecked(pool, 'import_roundtrip_files_sql',
      'SELECT file_path, byte_size, sha256, content FROM public.codelab_project_files WHERE workspace_id=$1 AND project_id=$2 AND editor_id=$3 ORDER BY file_path',
      [destinationWorkspaceId, projectId, request.editor_id]
    );
    const expectedFiles = packageFiles
      .map(file => ({ path: destinationPathByPath.get(file.relative), bytes: packageFileMap.get(file.relative) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (rereadFilesResult.rows.length !== expectedFiles.length) {
      throw new Error('Persisted CodeLab file count does not match the imported package.');
    }
    for (let index = 0; index < expectedFiles.length; index++) {
      const expected = expectedFiles[index];
      const actual = rereadFilesResult.rows[index];
      const expectedSha = sha256(expected.bytes);
      if (actual.file_path !== expected.path || Number(actual.byte_size) !== expected.bytes.length ||
          actual.sha256 !== expectedSha || !Buffer.from(actual.content).equals(expected.bytes)) {
        throw new Error('Persisted CodeLab file round-trip verification failed for ' + expected.path + '.');
      }
    }
    const persistedProject = rereadProject;
    const workspacePublication = await publishImportedCodeLabProjectToWorkspace(
      pool, destinationWorkspaceId, persistedProject, request.editor_id
    );
    if (Number(manifest.version) === 2 && persistedProject.codelabSchema?.version !== 2) {
      throw new Error('Persisted structured CodeLab project lost its schema declaration.');
    }
    const persistedAnimationFrameCount = Array.isArray(persistedProject.animation?.frames)
      ? persistedProject.animation.frames.length : 0;
    const persistedReferenceCount = Array.isArray(persistedProject.drawingModel?.referenceCenter?.entries)
      ? persistedProject.drawingModel.referenceCenter.entries.length : 0;

    if (request.editor_id === 'pixelforge') {
      const width = Number(project.width || 128);
      const height = Number(project.height || 128);
      const byteSize = Buffer.byteLength(serialized, 'utf8');
      await queryChecked(pool, 'import_sql', 
        `INSERT INTO public.codelab_pixelforge_projects
          (workspace_id, project_id, name, width, height, updated_at, last_opened_at, project, byte_size, server_revision, content_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7::jsonb,$8,$10,$9)
         ON CONFLICT (workspace_id, project_id) DO UPDATE SET
           name=EXCLUDED.name,
           width=EXCLUDED.width,
           height=EXCLUDED.height,
           updated_at=EXCLUDED.updated_at,
           last_opened_at=EXCLUDED.last_opened_at,
           project=EXCLUDED.project,
           byte_size=EXCLUDED.byte_size,
           server_revision=EXCLUDED.server_revision,
           content_sha256=EXCLUDED.content_sha256`,
        [destinationWorkspaceId, projectId, name, width, height, now, serialized, byteSize, contentSha, pixelForgeServerRevision]
      );
    }

    await queryChecked(pool, 'import_sql', 
      `INSERT INTO public.codelab_project_imports
        (workspace_id, project_id, editor_id, format, format_version, manifest, source_sha256, payload, status, result)
       VALUES ($1,$2,$3,'codelab',1,$4::jsonb,$5,$6::jsonb,'succeeded',$7::jsonb)`,
      [
        destinationWorkspaceId,
        projectId,
        request.editor_id,
        JSON.stringify(manifest),
        actualSha,
        serialized,
        JSON.stringify({ importedFromArtifactId: artifact.artifact_id, importRequestId, contentSha256: contentSha, reloadedFromPersistence: true, persistedAnimationFrameCount, persistedReferenceCount }),
      ]
    );

    await queryChecked(pool, 'import_sql', 
      `UPDATE public.codelab_project_import_requests
       SET status='succeeded', updated_at=now()
       WHERE import_request_id=$1`,
      [importRequestId]
    );
    await queryChecked(pool, 'import_sql', 
      `UPDATE public.codelab_project_artifacts
       SET status='imported', updated_at=now()
       WHERE artifact_id=$1`,
      [artifact.artifact_id]
    );

    return {
      status: 'succeeded',
      importRequestId,
      artifactId: artifact.artifact_id,
      editorId: request.editor_id,
      projectId,
      contentSha256: contentSha,
      sourceSha256: actualSha,
      installedResources: installation.installed,
      resourceSummary: installation.resources,
      resourceDestinations: installation.destinations,
      reloadedFromPersistence: true,
      persistedAnimationFrameCount,
      persistedReferenceCount,
      workspacePublication,
    };
  } catch (error) {
    error.message = `codelab_artifact_import_failed: ${error.message}`;
    await queryChecked(pool, 'import_sql', 
      'UPDATE public.codelab_project_import_requests SET status=\'failed\', updated_at=now() WHERE import_request_id=$1',
      [importRequestId]
    ).catch(() => {});
    await queryChecked(pool, 'import_sql', 
      'UPDATE public.codelab_project_artifacts SET status=\'failed\', updated_at=now() WHERE artifact_id=$1',
      [artifact.artifact_id]
    ).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
