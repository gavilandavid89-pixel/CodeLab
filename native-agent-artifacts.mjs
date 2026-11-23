import { createHash, randomUUID } from 'node:crypto';

export const NATIVE_ARTIFACT_CHUNK_BYTES = 1024 * 1024;
export const NATIVE_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
const ALLOWED_KINDS = new Set([
  'pixelforge_zip_upload',
  'pixelforge_zip_export',
  'pixelforge_composer_video',
  'pixelforge_composer_png',
  'codelab_zip_upload',
  'codelab_project_png'
]);

export async function ensureNativeArtifactSchema(pool) {
  const schema = [
    "CREATE TABLE IF NOT EXISTS public.codelab_agent_artifacts (",
    "  artifact_id TEXT PRIMARY KEY,",
    "  workspace_id TEXT NOT NULL,",
    "  kind TEXT NOT NULL,",
    "  filename TEXT NOT NULL,",
    "  content_type TEXT NOT NULL,",
    "  total_bytes BIGINT NOT NULL CHECK (total_bytes > 0 AND total_bytes <= 268435456),",
    "  total_chunks INTEGER NOT NULL CHECK (total_chunks > 0 AND total_chunks <= 256),",
    "  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),",
    "  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,",
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),",
    "  expires_at TIMESTAMPTZ NOT NULL",
    ");",
    "CREATE INDEX IF NOT EXISTS codelab_agent_artifacts_workspace_idx ON public.codelab_agent_artifacts (workspace_id, created_at DESC);",
    "CREATE TABLE IF NOT EXISTS public.codelab_agent_artifact_chunks (",
    "  artifact_id TEXT NOT NULL REFERENCES public.codelab_agent_artifacts(artifact_id) ON DELETE CASCADE,",
    "  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),",
    "  chunk_data BYTEA NOT NULL,",
    "  chunk_sha256 TEXT NOT NULL CHECK (chunk_sha256 ~ '^[a-f0-9]{64}$'),",
    "  PRIMARY KEY (artifact_id, chunk_index)",
    ");"
  ].join('\n');
  await pool.query(schema);
  const migration = [
    "DO $native_artifact_migration$",
    "BEGIN",
    "  IF NOT EXISTS (",
    "    SELECT 1 FROM pg_constraint",
    "     WHERE conrelid = 'public.codelab_agent_artifacts'::regclass",
    "       AND conname = 'codelab_agent_artifacts_kind_check'",
    "       AND pg_get_constraintdef(oid) LIKE '%pixelforge_composer_video%'",
    "       AND pg_get_constraintdef(oid) LIKE '%pixelforge_composer_png%'",
    "  ) THEN",
    "    ALTER TABLE public.codelab_agent_artifacts DROP CONSTRAINT IF EXISTS codelab_agent_artifacts_kind_check;",
    "    ALTER TABLE public.codelab_agent_artifacts",
    "      ADD CONSTRAINT codelab_agent_artifacts_kind_check",
    "      CHECK (kind = ANY (ARRAY['pixelforge_zip_upload','pixelforge_zip_export','pixelforge_composer_video','pixelforge_composer_png','codelab_zip_upload','codelab_project_png']));",
    "  END IF;",
    "END",
    "$native_artifact_migration$;"
  ].join('\n');
  await pool.query(migration);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function stageNativeArtifact(pool, {
  workspaceId,
  kind,
  filename,
  contentType = 'application/octet-stream',
  bytes,
  metadata = {},
  ttlMs = 60 * 60 * 1000,
  artifactId = randomUUID().replaceAll('-', '')
}) {
  if (typeof workspaceId !== 'string' || !workspaceId || !ALLOWED_KINDS.has(kind)) {
    throw new TypeError('A valid workspace and native artifact kind are required.');
  }
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!data.length || data.length > NATIVE_ARTIFACT_MAX_BYTES) {
    throw new RangeError('Native artifacts must be between 1 byte and 256 MiB.');
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) {
    throw new RangeError('Native artifact TTL must be between 1 minute and 24 hours.');
  }
  if (!/^[a-f0-9]{32}$/.test(artifactId)) throw new TypeError('Native artifact ID is invalid.');
  const totalChunks = Math.ceil(data.length / NATIVE_ARTIFACT_CHUNK_BYTES);
  const digest = sha256(data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [workspaceId + ':native-artifacts']);
    await client.query('DELETE FROM public.codelab_agent_artifacts WHERE expires_at <= now()');
    const active = await client.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(total_bytes),0)::bigint AS bytes FROM public.codelab_agent_artifacts WHERE workspace_id=$1 AND kind=$2',
      [workspaceId, kind]
    );
    if (Number(active.rows[0].count) >= 2 ||
        Number(active.rows[0].bytes) + data.length > NATIVE_ARTIFACT_MAX_BYTES) {
      throw new Error('Native artifact staging quota reached. Consume or expire an existing artifact first.');
    }
    const insertArtifact = "INSERT INTO public.codelab_agent_artifacts (artifact_id,workspace_id,kind,filename,content_type,total_bytes,total_chunks,sha256,metadata,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now()+($10::bigint * interval '1 millisecond'))";
    await client.query(insertArtifact, [
      artifactId, workspaceId, kind, String(filename || 'pixelforge.zip').slice(0, 180),
      contentType, data.length, totalChunks, digest, JSON.stringify(metadata), ttlMs
    ]);
    for (let index = 0; index < totalChunks; index++) {
      const chunk = data.subarray(
        index * NATIVE_ARTIFACT_CHUNK_BYTES,
        Math.min(data.length, (index + 1) * NATIVE_ARTIFACT_CHUNK_BYTES)
      );
      await client.query(
        'INSERT INTO public.codelab_agent_artifact_chunks (artifact_id,chunk_index,chunk_data,chunk_sha256) VALUES ($1,$2,$3,$4)',
        [artifactId, index, chunk, sha256(chunk)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return {
    artifactId,
    kind,
    filename: String(filename || 'pixelforge.zip').slice(0, 180),
    contentType,
    sizeBytes: data.length,
    chunkCount: totalChunks,
    sha256: digest
  };
}

export async function readNativeArtifact(pool, workspaceId, artifactId, expectedKind) {
  if (typeof artifactId !== 'string' || !/^[a-f0-9]{32}$/.test(artifactId)) {
    throw new TypeError('Native artifact ID is invalid.');
  }
  const meta = await pool.query(
    'SELECT * FROM public.codelab_agent_artifacts WHERE artifact_id=$1 AND workspace_id=$2 AND expires_at>now()',
    [artifactId, workspaceId]
  );
  if (!meta.rowCount) throw new Error('Native artifact is missing, expired, or belongs to another workspace.');
  const row = meta.rows[0];
  if (expectedKind && row.kind !== expectedKind) throw new Error('Native artifact kind does not match this operation.');
  const chunks = await pool.query(
    'SELECT chunk_index,chunk_data,chunk_sha256 FROM public.codelab_agent_artifact_chunks WHERE artifact_id=$1 ORDER BY chunk_index',
    [artifactId]
  );
  if (chunks.rowCount !== Number(row.total_chunks)) throw new Error('Native artifact is incomplete.');
  const parts = [];
  let total = 0;
  for (let index = 0; index < chunks.rows.length; index++) {
    const chunk = chunks.rows[index];
    if (Number(chunk.chunk_index) !== index) throw new Error('Native artifact chunk sequence is incomplete.');
    const bytes = Buffer.from(chunk.chunk_data);
    if (sha256(bytes) !== chunk.chunk_sha256) throw new Error('Native artifact chunk failed SHA-256 verification.');
    parts.push(bytes);
    total += bytes.length;
  }
  const data = Buffer.concat(parts);
  if (total !== Number(row.total_bytes) || sha256(data) !== row.sha256) {
    throw new Error('Native artifact failed full-file integrity verification.');
  }
  return {
    bytes: data,
    metadata: {
      artifactId,
      kind: row.kind,
      filename: row.filename,
      contentType: row.content_type,
      sizeBytes: total,
      sha256: row.sha256,
      metadata: row.metadata
    }
  };
}

export async function deleteNativeArtifact(pool, workspaceId, artifactId) {
  await pool.query(
    'DELETE FROM public.codelab_agent_artifacts WHERE artifact_id=$1 AND workspace_id=$2',
    [artifactId, workspaceId]
  );
}
