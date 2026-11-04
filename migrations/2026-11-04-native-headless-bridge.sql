-- CodeLab native Headless bridge command mailbox.
-- Commands are submitted through the owner-controlled Neon connection; the
-- web app exposes no public enqueue endpoint or raw SQL capability.
CREATE TABLE public.codelab_agent_commands (
  command_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  action text NOT NULL CHECK (action IN (
    'status','pixelforge_list','pixelforge_inspect',
    'pixelforge_propose','pixelforge_approve','pixelforge_discard'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','running','awaiting_approval','succeeded',
    'rejected','failed','expired'
  )),
  result jsonb,
  proposal jsonb,
  proposal_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX codelab_agent_commands_queue_idx
  ON public.codelab_agent_commands (status, created_at)
  WHERE status = 'queued';
CREATE INDEX codelab_agent_commands_workspace_idx
  ON public.codelab_agent_commands (workspace_id, created_at DESC);
