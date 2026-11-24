-- Durable CodeLab project artifact import storage.
-- Keep this schema available to isolated CI databases as well as hosted Postgres.
-- All statements are idempotent; this migration creates schema only, never project data.

CREATE TABLE IF NOT EXISTS public.codelab_project_import_requests (
  import_request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  editor_id TEXT NOT NULL,
  source_project_id TEXT,
  source_sha256 TEXT,
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  confirmation_required BOOLEAN NOT NULL DEFAULT false,
  confirmation_received BOOLEAN NOT NULL DEFAULT false,
  work_score NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.codelab_project_artifacts (
  artifact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_request_id TEXT NOT NULL REFERENCES public.codelab_project_import_requests(import_request_id),
  workspace_id TEXT NOT NULL,
  editor_id TEXT NOT NULL,
  source_project_id TEXT,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  artifact BYTEA,
  status TEXT NOT NULL DEFAULT 'uploaded',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS codelab_project_artifacts_import_idx
  ON public.codelab_project_artifacts (import_request_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.codelab_project_registry (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  editor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  project JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_sha256 TEXT NOT NULL,
  work_score NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id)
);

CREATE TABLE IF NOT EXISTS public.codelab_project_files (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  editor_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  content BYTEA NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, file_path)
);

CREATE TABLE IF NOT EXISTS public.codelab_project_imports (
  import_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  editor_id TEXT NOT NULL,
  format TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  manifest JSONB NOT NULL,
  source_sha256 TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS codelab_project_imports_project_idx
  ON public.codelab_project_imports (workspace_id, project_id, created_at DESC);

-- Match hosted artifact integrity behavior: metadata is derived from the stored bytes.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.codelab_sync_artifact_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.byte_size := octet_length(NEW.artifact);
  NEW.sha256 := encode(digest(NEW.artifact, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS codelab_project_artifacts_integrity
  ON public.codelab_project_artifacts;

CREATE TRIGGER codelab_project_artifacts_integrity
BEFORE INSERT OR UPDATE OF artifact
ON public.codelab_project_artifacts
FOR EACH ROW
EXECUTE FUNCTION public.codelab_sync_artifact_integrity();
