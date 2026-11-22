-- Keep persisted .codelab artifact metadata derived from the stored BYTEA.
-- This prevents manual or partial metadata updates from desynchronizing
-- byte_size/sha256 from the actual artifact bytes.
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

-- Repair legacy rows whose metadata drifted from the bytes already stored.
UPDATE public.codelab_project_artifacts
SET artifact = artifact
WHERE artifact IS NOT NULL;
