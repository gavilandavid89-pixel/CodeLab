const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_BUCKET = process.env.NEON_PIXelfORGE_EVIDENCE_BUCKET || process.env.NEON_PIXelforge_EVIDENCE_BUCKET || 'codelab-captures-public';
const STORAGE_ENDPOINT = (process.env.NEON_STORAGE_ENDPOINT || '').replace(/\/$/, '');
const STORAGE_REGION = process.env.NEON_STORAGE_REGION || 'us-east-2';
const STORAGE_ACCESS_KEY = process.env.NEON_STORAGE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
const STORAGE_SECRET_KEY = process.env.NEON_STORAGE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';

function storageConfigured() {
  return !!(STORAGE_ENDPOINT && STORAGE_ACCESS_KEY && STORAGE_SECRET_KEY);
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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

function signingKey(secret, date, region, service) {
  const kDate = hmac(Buffer.from('AWS4' + secret), date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function encodePath(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalQuery(params) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => encodePath(k) + '=' + encodePath(String(v)))
    .join('&');
}

function presignStorageObject({ bucket = DEFAULT_BUCKET, objectKey, contentType, expiresInSeconds = 900 }) {
  if (!storageConfigured()) throw new Error('neon_storage_credentials_missing');
  if (!objectKey || objectKey.includes('..') || objectKey.startsWith('/')) throw new Error('invalid_object_key');

  const endpoint = new URL(STORAGE_ENDPOINT);
  const host = endpoint.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\\.\\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const credential = STORAGE_ACCESS_KEY + '/' + dateStamp + '/' + STORAGE_REGION + '/s3/aws4_request';
  const expires = Math.min(604800, Math.max(1, Number(expiresInSeconds) || 900));
  const signedHeaders = 'content-type;host';
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': expires,
    'X-Amz-SignedHeaders': signedHeaders
  };
  const canonicalUri = '/' + encodePath(bucket) + '/' + objectKey.split('/').map(encodePath).join('/');
  const query = canonicalQuery(params);
  const canonicalHeaders = 'content-type:' + String(contentType || 'application/octet-stream') + '\n' + 'host:' + host + '\n';
  const canonicalRequest = ['PUT', canonicalUri, query, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = dateStamp + '/' + STORAGE_REGION + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(STORAGE_SECRET_KEY, dateStamp, STORAGE_REGION, 's3'), stringToSign, 'hex');
  return {
    method: 'PUT',
    url: STORAGE_ENDPOINT + canonicalUri + '?' + query + '&X-Amz-Signature=' + signature,
    headers: { 'content-type': String(contentType || 'application/octet-stream') },
    expiresAt: new Date(now.getTime() + expires * 1000).toISOString(),
    bucket,
    objectKey
  };
}

async function attachEvidence(pool, { workspaceId, eventId, kind, objectKey, publicUrl }) {
  const column = kind === 'image' ? 'image_key' : 'video_key';
  const urlColumn = kind === 'image' ? 'image_url' : 'video_url';
  const status = kind === 'video' ? 'complete' : 'awaiting-video';
  const result = await pool.query(
    `UPDATE codelab_pixelforge_change_events
     SET ${column} = $3, ${urlColumn} = $4, status = $5, updated_at = NOW()
     WHERE workspace_id = $1 AND event_id = $2
     RETURNING event_id AS "eventId", status, ${column} AS "objectKey", ${urlColumn} AS url`,
    [workspaceId, eventId, objectKey, publicUrl || null, status]
  );
  return result.rows[0] || null;
}

module.exports = {
  DEFAULT_BUCKET,
  storageConfigured,
  ensureEvidenceSchema,
  createChangeEvent,
  getChangeEvent,
  presignStorageObject,
  attachEvidence
};
