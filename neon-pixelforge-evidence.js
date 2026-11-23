const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_BUCKET = process.env.NEON_PIXelfORGE_EVIDENCE_BUCKET || process.env.NEON_PIXelforge_EVIDENCE_BUCKET || 'codelab-captures-public';
const CLOUDFLARE_EVIDENCE_BASE_URL = (process.env.CLOUDFLARE_EVIDENCE_BASE_URL || '').replace(/\/$/, '');
const CLOUDFLARE_EVIDENCE_SECRET = process.env.CLOUDFLARE_EVIDENCE_SIGNING_SECRET || '';

function cloudflareEvidenceConfigured() {
  return !!(CLOUDFLARE_EVIDENCE_BASE_URL && CLOUDFLARE_EVIDENCE_SECRET);
}

function storageConfigured() {
  return cloudflareEvidenceConfigured();
}
function presignStorageObject({ objectKey, contentType, expiresInSeconds = 900, operation = 'upload' }) {
  if (!cloudflareEvidenceConfigured()) throw new Error('cloudflare_evidence_storage_required');
  if (operation !== 'upload') throw new Error('cloudflare_evidence_download_presign_not_supported');
  return presignCloudflareEvidenceObject({ objectKey, contentType, expiresInSeconds });
}

