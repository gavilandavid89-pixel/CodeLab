-- Allow the Neon bridge worker to execute .codelab artifact imports.
ALTER TABLE public.codelab_agent_commands
  DROP CONSTRAINT IF EXISTS codelab_agent_commands_action_check;

ALTER TABLE public.codelab_agent_commands
  ADD CONSTRAINT codelab_agent_commands_action_check
  CHECK (action = ANY (ARRAY[
    'status',
    'pixelforge_create',
    'pixelforge_list',
    'pixelforge_inspect',
    'pixelforge_propose',
    'pixelforge_approve',
    'pixelforge_discard',
    'pixelforge_animation_frame_context',
    'pixelforge_export_image',
    'pixelforge_capture_interface',
    'pixelforge_export_animation_video',
    'pixelforge_intelligence',
    'codelab_project_create',
    'codelab_project_convert_to_web',
    'codelab_project_inspect',
    'codelab_project_connect',
    'codelab_project_get_code',
    'codelab_project_update_code',
    'codelab_project_capture_png',
    'codelab_project_record_video',
    'codelab_ui_execute',
    'codelab_validate',
    'codelab_project_import',
    'neon_function_invoke'
  ]));
