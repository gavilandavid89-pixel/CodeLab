-- CodeLab core PostgreSQL schema used by native accounts and workspace persistence.
-- Safe to apply repeatedly and suitable for CI/bootstrap databases.

CREATE TABLE IF NOT EXISTS public.codelab_accounts (
  username text PRIMARY KEY,
  id text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'user',
  salt text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz,
  must_change_password boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.codelab_workspace_states (
  workspace_id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  owner jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(state) = 'object'),
  CHECK (owner IS NULL OR jsonb_typeof(owner) = 'object')
);

CREATE INDEX IF NOT EXISTS codelab_workspace_states_updated_idx
  ON public.codelab_workspace_states (updated_at DESC);
