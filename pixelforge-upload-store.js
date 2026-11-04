'use strict';

const crypto = require('node:crypto');

const CHUNK_BYTES = 6 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

class PixelForgeUploadError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function ensureSchema(pool) {
  await pool.query("ALTER TABLE codelab_pixelforge_projects ADD COLUMN IF NOT EXISTS content_sha256 TEXT");
  await pool.query("CREATE TABLE IF NOT EXISTS codelab_pixelforge_project_uploads (upload_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, expected_server_revision BIGINT NOT NULL, total_bytes BIGINT NOT NULL, total_chunks INTEGER NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, committed BOOLEAN NOT NULL DEFAULT FALSE, receipt JSONB)");
  await pool.query("CREATE INDEX IF NOT EXISTS codelab_pixelforge_upload_expiry_idx ON codelab_pixelforge_project_uploads (expires_at)");
  await pool.query("CREATE TABLE IF NOT EXISTS codelab_pixelforge_project_upload_chunks (upload_id TEXT NOT NULL REFERENCES codelab_pixelforge_project_uploads(upload_id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, chunk_data BYTEA NOT NULL, chunk_sha256 TEXT NOT NULL, PRIMARY KEY (upload_id, chunk_index))");
}

async function beginUpload(pool, workspaceId, body, maxProjectBytes, maxAccountBytes, maxProjects) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !/^[a-f0-9]{32}$/.test(body.uploadId || '') ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(body.projectId || '') ||
      !Number.isSafeInteger(body.expectedServerRevision) || body.expectedServerRevision < 0 ||
      !Number.isSafeInteger(body.totalBytes) || body.totalBytes < 1 || body.totalBytes > maxProjectBytes ||
      !Number.isInteger(body.totalChunks) || body.totalChunks !== Math.ceil(body.totalBytes / CHUNK_BYTES)) {
    throw new PixelForgeUploadError('invalid_pixelforge_upload', 400);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [workspaceId]);
    const now = Date.now();
    await client.query('DELETE FROM codelab_pixelforge_project_uploads WHERE expires_at <= $1', [now]);
    const prior = await client.query('SELECT * FROM codelab_pixelforge_project_uploads WHERE upload_id = $1 FOR UPDATE', [body.uploadId]);
    if (prior.rowCount) {
      const row = prior.rows[0];
      const same = row.workspace_id === workspaceId && row.project_id === body.projectId &&
        Number(row.expected_server_revision) === body.expectedServerRevision &&
        Number(row.total_bytes) === body.totalBytes && Number(row.total_chunks) === body.totalChunks;
      if (!same) throw new PixelForgeUploadError('pixelforge_upload_conflict', 409);
      await client.query('COMMIT');
      return row.committed
        ? { status: 200, committed: true, receipt: row.receipt }
        : { status: 200, uploadId: body.uploadId, chunkSize: CHUNK_BYTES, totalChunks: body.totalChunks };
    }
    const existing = await client.query(
      "SELECT server_revision, project->>'serverRevision' AS legacy_revision FROM codelab_pixelforge_projects WHERE workspace_id = $1 AND project_id = $2",
      [workspaceId, body.projectId]
    );
    const currentRevision = existing.rowCount
      ? Number(existing.rows[0].server_revision || existing.rows[0].legacy_revision || 0) : 0;
    if (currentRevision !== body.expectedServerRevision) {
      throw new PixelForgeUploadError('pixelforge_revision_conflict', 409, { revision: currentRevision });
    }
    const usage = await client.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(byte_size),0)::bigint AS bytes FROM codelab_pixelforge_projects WHERE workspace_id = $1 AND project_id <> $2',
      [workspaceId, body.projectId]
    );
    if (!existing.rowCount && Number(usage.rows[0].count) >= maxProjects) {
      throw new PixelForgeUploadError('pixelforge_project_limit', 409, { maxProjects });
    }
    if (Number(usage.rows[0].bytes) + body.totalBytes > maxAccountBytes) {
      throw new PixelForgeUploadError('pixelforge_account_storage_limit', 413, { maxBytes: maxAccountBytes });
    }
    await client.query(
      'INSERT INTO codelab_pixelforge_project_uploads (upload_id,workspace_id,project_id,expected_server_revision,total_bytes,total_chunks,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [body.uploadId, workspaceId, body.projectId, body.expectedServerRevision, body.totalBytes, body.totalChunks, now, now + UPLOAD_TTL_MS]
    );
    await client.query('COMMIT');
    return { status: 201, uploadId: body.uploadId, chunkSize: CHUNK_BYTES, totalChunks: body.totalChunks, expiresInMs: UPLOAD_TTL_MS };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function putChunk(pool, workspaceId, uploadId, index, body) {
  if (!/^[a-f0-9]{32}$/.test(uploadId || '') || !Number.isInteger(index) ||
      !body || typeof body.chunk !== 'string' || !/^[a-f0-9]{64}$/i.test(body.sha256 || '')) {
    throw new PixelForgeUploadError('invalid_pixelforge_chunk', 400);
  }
  const result = await pool.query(
    'SELECT total_bytes,total_chunks,expires_at,committed FROM codelab_pixelforge_project_uploads WHERE upload_id = $1 AND workspace_id = $2',
    [uploadId, workspaceId]
  );
  if (!result.rowCount || Number(result.rows[0].expires_at) <= Date.now()) {
    throw new PixelForgeUploadError('pixelforge_upload_not_found', 404);
  }
  const upload = result.rows[0];
  if (upload.committed) throw new PixelForgeUploadError('pixelforge_upload_committed', 409);
  if (index < 0 || index >= Number(upload.total_chunks)) throw new PixelForgeUploadError('invalid_pixelforge_chunk', 400);
  const bytes = Buffer.from(body.chunk, 'base64');
  if (!bytes.length || bytes.toString('base64') !== body.chunk || bytes.length > CHUNK_BYTES) {
    throw new PixelForgeUploadError('invalid_pixelforge_chunk', 400);
  }
  const expectedLength = index === Number(upload.total_chunks) - 1
    ? Number(upload.total_bytes) - CHUNK_BYTES * (Number(upload.total_chunks) - 1)
    : CHUNK_BYTES;
  const actualHash = sha256(bytes);
  if (bytes.length !== expectedLength || actualHash !== body.sha256.toLowerCase()) {
    throw new PixelForgeUploadError('pixelforge_chunk_integrity_failed', 400);
  }
  await pool.query(
    'INSERT INTO codelab_pixelforge_project_upload_chunks (upload_id,chunk_index,chunk_data,chunk_sha256) VALUES ($1,$2,$3,$4) ON CONFLICT (upload_id,chunk_index) DO NOTHING',
    [uploadId, index, bytes, actualHash]
  );
  const stored = await pool.query(
    'SELECT chunk_sha256,octet_length(chunk_data) AS bytes FROM codelab_pixelforge_project_upload_chunks WHERE upload_id = $1 AND chunk_index = $2',
    [uploadId, index]
  );
  if (!stored.rowCount || stored.rows[0].chunk_sha256 !== actualHash || Number(stored.rows[0].bytes) !== bytes.length) {
    throw new PixelForgeUploadError('pixelforge_chunk_conflict', 409);
  }
  const count = await pool.query('SELECT COUNT(*)::int AS received FROM codelab_pixelforge_project_upload_chunks WHERE upload_id = $1', [uploadId]);
  return { uploadId, receivedChunks: Number(count.rows[0].received), totalChunks: Number(upload.total_chunks) };
}

async function assembleUpload(pool, workspaceId, uploadId) {
  const uploadResult = await pool.query(
    'SELECT * FROM codelab_pixelforge_project_uploads WHERE upload_id = $1 AND workspace_id = $2',
    [uploadId, workspaceId]
  );
  if (!uploadResult.rowCount) throw new PixelForgeUploadError('pixelforge_upload_not_found', 404);
  const upload = uploadResult.rows[0];
  if (Number(upload.expires_at) <= Date.now()) throw new PixelForgeUploadError('pixelforge_upload_expired', 410);
  if (upload.committed) return { committed: true, receipt: upload.receipt, upload };
  const count = await pool.query(
    'SELECT COUNT(*)::int AS count, COALESCE(SUM(octet_length(chunk_data)),0)::bigint AS bytes FROM codelab_pixelforge_project_upload_chunks WHERE upload_id = $1',
    [uploadId]
  );
  if (Number(count.rows[0].count) !== Number(upload.total_chunks) ||
      Number(count.rows[0].bytes) !== Number(upload.total_bytes)) {
    throw new PixelForgeUploadError('pixelforge_upload_incomplete', 409, {
      receivedChunks: Number(count.rows[0].count), totalChunks: Number(upload.total_chunks)
    });
  }
  const digest = crypto.createHash('sha256');
  let serialized = '';
  for (let index = 0; index < Number(upload.total_chunks); index++) {
    const result = await pool.query(
      'SELECT chunk_data,chunk_sha256 FROM codelab_pixelforge_project_upload_chunks WHERE upload_id = $1 AND chunk_index = $2',
      [uploadId, index]
    );
    if (!result.rowCount) throw new PixelForgeUploadError('pixelforge_upload_incomplete', 409);
    const bytes = result.rows[0].chunk_data;
    const actualHash = sha256(bytes);
    if (actualHash !== result.rows[0].chunk_sha256) throw new PixelForgeUploadError('pixelforge_chunk_integrity_failed', 400);
    digest.update(bytes);
    serialized += bytes.toString('utf8');
  }
  if (Buffer.byteLength(serialized, 'utf8') !== Number(upload.total_bytes)) {
    throw new PixelForgeUploadError('pixelforge_upload_size_mismatch', 400);
  }
  return { committed: false, upload, serialized, contentSha256: digest.digest('hex') };
}

async function markCommitted(pool, uploadId, receipt) {
  const now = Date.now();
  await pool.query(
    'UPDATE codelab_pixelforge_project_uploads SET committed = TRUE, receipt = $2::jsonb, expires_at = $3 WHERE upload_id = $1',
    [uploadId, JSON.stringify(receipt), now + UPLOAD_TTL_MS]
  );
  await pool.query('DELETE FROM codelab_pixelforge_project_upload_chunks WHERE upload_id = $1', [uploadId]);
}

module.exports = { CHUNK_BYTES, UPLOAD_TTL_MS, PixelForgeUploadError, ensureSchema, beginUpload, putChunk, assembleUpload, markCommitted };
