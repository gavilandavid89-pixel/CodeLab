-- Native assistant artifact storage and the three PixelForge integration commands.
-- Artifacts are scoped to the ADMIN mailbox workspace and stored in verified 1 MiB chunks.

CREATE TABLE IF NOT EXISTS public.codelab_agent_artifacts (
  artifact_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = ANY (ARRAY['pixelforge_zip_upload','pixelforge_zip_export','pixelforge_composer_video','pixelforge_composer_png','codelab_zip_upload'])),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  total_bytes BIGINT NOT NULL CHECK (total_bytes > 0 AND total_bytes <= 268435456),
  total_chunks INTEGER NOT NULL CHECK (total_chunks > 0 AND total_chunks <= 256),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS codelab_agent_artifacts_workspace_idx
  ON public.codelab_agent_artifacts (workspace_id, created_at DESC);

DO $native_artifact_migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.codelab_agent_artifacts'::regclass
       AND conname = 'codelab_agent_artifacts_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%pixelforge_composer_video%'
       AND pg_get_constraintdef(oid) LIKE '%pixelforge_composer_png%'
       AND pg_get_constraintdef(oid) LIKE '%codelab_zip_upload%'
  ) THEN
    ALTER TABLE public.codelab_agent_artifacts
      DROP CONSTRAINT IF EXISTS codelab_agent_artifacts_kind_check;
    ALTER TABLE public.codelab_agent_artifacts
      ADD CONSTRAINT codelab_agent_artifacts_kind_check
      CHECK (kind = ANY (ARRAY[
        'pixelforge_zip_upload','pixelforge_zip_export',
        'pixelforge_composer_video','pixelforge_composer_png','codelab_zip_upload'
      ]));
  END IF;
END
$native_artifact_migration$;

CREATE TABLE IF NOT EXISTS public.codelab_agent_artifact_chunks (
  artifact_id TEXT NOT NULL REFERENCES public.codelab_agent_artifacts(artifact_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_data BYTEA NOT NULL,
  chunk_sha256 TEXT NOT NULL CHECK (chunk_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (artifact_id, chunk_index)
);

ALTER TABLE public.codelab_agent_commands
  DROP CONSTRAINT IF EXISTS codelab_agent_commands_action_check;

ALTER TABLE public.codelab_agent_commands
  ADD CONSTRAINT codelab_agent_commands_action_check
  CHECK (action = ANY (ARRAY[
    'status',
    'pixelforge_create','pixelforge_list','pixelforge_inspect',
    'pixelforge_propose','pixelforge_approve','pixelforge_discard',
    'pixelforge_animation_frame_context','pixelforge_export_image',
    'pixelforge_capture_interface','pixelforge_export_animation_video',
    'pixelforge_intelligence','pixelforge_preview_evidence_video',
    'pixelforge_import_zip','pixelforge_export_zip','pixelforge_video_composer',
    'codelab_project_create','codelab_project_convert_to_web',
    'codelab_project_inspect','codelab_project_connect',
    'codelab_project_get_code','codelab_project_update_code',
    'codelab_project_capture_png','codelab_project_record_video',
    'codelab_ui_execute','codelab_validate','codelab_project_import',
    'neon_function_invoke'
  ]));
