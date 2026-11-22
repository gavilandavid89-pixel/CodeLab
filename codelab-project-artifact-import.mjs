import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function assertSafePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\0') && !value.startsWith('/') && !value.includes('..');
}

async function extractCodelabArchive(buffer, tempRoot) {
  const archive = path.join(tempRoot, 'project.codelab');
  const extractDir = path.join(tempRoot, 'project');
  await fs.mkdir(extractDir, { recursive: true });
  await fs.writeFile(archive, buffer);
  await execFileAsync('unzip', ['-oq', archive, '-d', extractDir], { timeout: 30_000 });
  return extractDir;
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
  if (manifest.format !== 'codelab' || Number(manifest.version) !== 1) {
    throw new Error('Unsupported .codelab package format.');
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

export async function importCodeLabArtifact(pool, {
  importRequestId,
  workspaceId,
  pixelForgeWorkspaceId,
}) {
  if (!importRequestId) throw new Error('import_request_id is required.');

  const requestResult = await pool.query(
    'SELECT import_request_id, workspace_id, editor_id, source_project_id, source_sha256, manifest, status, confirmation_required, confirmation_received, work_score FROM public.codelab_project_import_requests WHERE import_request_id=$1',
    [importRequestId]
  );
  if (!requestResult.rowCount) throw new Error('Import request not found: ' + importRequestId);

  const request = requestResult.rows[0];
  if (request.workspace_id !== workspaceId) throw new Error('Import request workspace is not authorized for this bridge.');
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

  const artifactResult = await pool.query(
    'SELECT artifact_id, filename, content_type, sha256, byte_size, artifact FROM public.codelab_project_artifacts WHERE import_request_id=$1 AND status=\'uploaded\' ORDER BY created_at DESC LIMIT 1',
    [importRequestId]
  );
  if (!artifactResult.rowCount) throw new Error('No uploaded .codelab artifact is attached to import request ' + importRequestId);

  const artifact = artifactResult.rows[0];
  const buffer = artifact.artifact;
  if (Number(artifact.byte_size) !== buffer.length) throw new Error('Artifact byte size mismatch.');
  const actualSha = sha256(buffer);
  if (actualSha !== artifact.sha256 || (request.source_sha256 && request.source_sha256 !== actualSha)) {
    throw new Error('Artifact SHA-256 verification failed.');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-import-'));
  try {
    await pool.query(
      'UPDATE public.codelab_project_import_requests SET status=\'running\', updated_at=now() WHERE import_request_id=$1',
      [importRequestId]
    );
    await pool.query(
      'UPDATE public.codelab_project_artifacts SET status=\'claimed\', updated_at=now() WHERE artifact_id=$1',
      [artifact.artifact_id]
    );

    const { manifest, project } = await readProjectPackage(buffer, tempRoot);
    if (manifest.editor !== request.editor_id) {
      throw new Error('Manifest editor does not match the import request editor_id.');
    }
    if (manifest.projectType !== request.editor_id) {
      throw new Error('Manifest projectType does not match the import request editor_id.');
    }

    const projectId = String(project.id || request.source_project_id);
    const name = String(project.name || projectId).slice(0, 100);
    const serialized = JSON.stringify(project);
    const contentSha = sha256(Buffer.from(serialized));
    const now = Date.now();
    const workScore = Number(request.work_score ?? 0);

    await pool.query(
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
      [request.workspace_id, projectId, request.editor_id, name, serialized, Number(request.work_score || 0)]
    );

    if (request.editor_id === 'pixelforge') {
      const width = Number(project.width || 128);
      const height = Number(project.height || 128);
      const byteSize = Buffer.byteLength(serialized, 'utf8');
      await pool.query(
        `INSERT INTO public.codelab_pixelforge_projects
          (workspace_id, project_id, name, width, height, updated_at, last_opened_at, project, byte_size, server_revision, content_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7::jsonb,$8,1,$9)
         ON CONFLICT (workspace_id, project_id) DO UPDATE SET
           name=EXCLUDED.name,
           width=EXCLUDED.width,
           height=EXCLUDED.height,
           updated_at=EXCLUDED.updated_at,
           last_opened_at=EXCLUDED.last_opened_at,
           project=EXCLUDED.project,
           byte_size=EXCLUDED.byte_size,
           server_revision=public.codelab_pixelforge_projects.server_revision+1,
           content_sha256=EXCLUDED.content_sha256`,
        [request.workspace_id || pixelForgeWorkspaceId, projectId, name, width, height, now, serialized, byteSize, contentSha]
      );
    }

    await pool.query(
      `INSERT INTO public.codelab_project_imports
        (workspace_id, project_id, editor_id, format, format_version, manifest, source_sha256, payload, status, result)
       VALUES ($1,$2,$3,'codelab',1,$4::jsonb,$5,$6::jsonb,'succeeded',$7::jsonb)`,
      [
        request.workspace_id,
        projectId,
        request.editor_id,
        JSON.stringify(manifest),
        actualSha,
        serialized,
        JSON.stringify({ importedFromArtifactId: artifact.artifact_id, importRequestId, contentSha256: contentSha }),
      ]
    );

    await pool.query(
      `UPDATE public.codelab_project_import_requests
       SET status='succeeded', updated_at=now()
       WHERE import_request_id=$1`,
      [importRequestId]
    );
    await pool.query(
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
    };
  } catch (error) {
    error.message = `codelab_artifact_import_failed: ${error.message}`;
    await pool.query(
      'UPDATE public.codelab_project_import_requests SET status=\'failed\', updated_at=now() WHERE import_request_id=$1',
      [importRequestId]
    ).catch(() => {});
    await pool.query(
      'UPDATE public.codelab_project_artifacts SET status=\'failed\', updated_at=now() WHERE artifact_id=$1',
      [artifact.artifact_id]
    ).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
