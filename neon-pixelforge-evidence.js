const crypto = require('crypto');
const { URL } = require('url');

const CLOUDFLARE_EVIDENCE_BASE_URL = (process.env.CLOUDFLARE_EVIDENCE_BASE_URL || '').replace(/\/$/, '');
const CLOUDFLARE_EVIDENCE_SECRET = process.env.CLOUDFLARE_EVIDENCE_SIGNING_SECRET || '';

function cloudflareEvidenceConfigured() {
  return !!(CLOUDFLARE_EVIDENCE_BASE_URL && CLOUDFLARE_EVIDENCE_SECRET);
}

function storageConfigured() {
  return cloudflareEvidenceConfigured();
}

function presignCloudflareEvidenceObject({ objectKey, contentType, expiresInSeconds = 900 }) {
  if (!cloudflareEvidenceConfigured()) throw new Error('cloudflare_evidence_config_missing');
  if (!objectKey || objectKey.includes('..') || objectKey.startsWith('/')) throw new Error('invalid_object_key');
  const now = Math.floor(Date.now() / 1000);
  const expires = now + Math.min(604800, Math.max(1, Number(expiresInSeconds) || 900));
  const type = String(contentType || 'application/octet-stream');
  const payload = ['PUT', objectKey, String(expires), type].join('\n');
  const signature = hmac(CLOUDFLARE_EVIDENCE_SECRET, payload, 'hex');
  return {
    method: 'PUT',
    url: CLOUDFLARE_EVIDENCE_BASE_URL + '/evidence/' + objectKey.split('/').map(encodePath).join('/') +
      '?expires=' + expires + '&sig=' + signature,
    headers: { 'content-type': type },
    expiresAt: new Date(expires * 1000).toISOString(),
    bucket: 'cloudflare-r2',
    objectKey,
    publicUrl: CLOUDFLARE_EVIDENCE_BASE_URL + '/evidence/' + objectKey.split('/').map(encodePath).join('/')
  };
}

async function ensureEvidenceSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS codelab_pixelforge_change_events (
      event_id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      change_kind TEXT NOT NULL DEFAULT 'project-save',
      image_key TEXT,
      video_key TEXT,
      image_url TEXT,
      video_url TEXT,
      status TEXT NOT NULL DEFAULT 'awaiting-evidence',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      image_data BYTEA,
      video_data BYTEA,
      image_mime_type TEXT,
      video_mime_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE codelab_pixelforge_change_events
      ADD COLUMN IF NOT EXISTS image_data BYTEA,
      ADD COLUMN IF NOT EXISTS video_data BYTEA,
      ADD COLUMN IF NOT EXISTS image_mime_type TEXT,
      ADD COLUMN IF NOT EXISTS video_mime_type TEXT
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS codelab_pixelforge_events_project_idx
    ON codelab_pixelforge_change_events (workspace_id, project_id, revision DESC, created_at DESC)
  `);
}

async function createChangeEvent(pool, { workspaceId, projectId, revision, changeKind = 'project-save', metadata = {} }) {
  const eventId = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO codelab_pixelforge_change_events
      (event_id, workspace_id, project_id, revision, change_kind, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING event_id AS "eventId", created_at AS "createdAt"`,
    [eventId, workspaceId, projectId, revision, changeKind, JSON.stringify(metadata)]
  );
  return result.rows[0];
}

async function getChangeEvent(pool, workspaceId, eventId) {
  const result = await pool.query(
    `SELECT event_id AS "eventId", project_id AS "projectId", revision,
            change_kind AS "changeKind", image_key AS "imageKey",
            video_key AS "videoKey", image_url AS "imageUrl",
            video_url AS "videoUrl", status, metadata,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM codelab_pixelforge_change_events
     WHERE workspace_id = $1 AND event_id = $2`,
    [workspaceId, eventId]
  );
  return result.rows[0] || null;
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encodePath(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function presignStorageObject({ objectKey, contentType, expiresInSeconds = 900, operation = 'upload' }) {
  if (!cloudflareEvidenceConfigured()) throw new Error('cloudflare_evidence_storage_required');
  if (operation !== 'upload') throw new Error('cloudflare_evidence_download_presign_not_supported');
  return presignCloudflareEvidenceObject({ objectKey, contentType, expiresInSeconds });
}

async function attachEvidence(pool, { workspaceId, eventId, kind, objectKey = null, publicUrl = null, data = null, mimeType = null }) {
  const column = kind === 'image' ? 'image_key' : 'video_key';
  const urlColumn = kind === 'image' ? 'image_url' : 'video_url';
  const dataColumn = kind === 'image' ? 'image_data' : 'video_data';
  const mimeColumn = kind === 'image' ? 'image_mime_type' : 'video_mime_type';
  const status = kind === 'video' ? 'complete' : 'awaiting-video';
  const result = await pool.query(
    `UPDATE codelab_pixelforge_change_events
     SET ${column} = $3, ${urlColumn} = $4, ${dataColumn} = $5, ${mimeColumn} = $6, status = $7, updated_at = NOW()
     WHERE workspace_id = $1 AND event_id = $2
     RETURNING event_id AS "eventId", status, ${column} AS "objectKey", ${urlColumn} AS url,
               octet_length(${dataColumn}) AS "inlineBytes"`,
    [workspaceId, eventId, objectKey, publicUrl || null, data, mimeType || null, status]
  );
  return result.rows[0] || null;
}

module.exports = {
  storageConfigured,
  cloudflareEvidenceConfigured,
  ensureEvidenceSchema,
  createChangeEvent,
  getChangeEvent,
  presignStorageObject,
  attachEvidence
};
