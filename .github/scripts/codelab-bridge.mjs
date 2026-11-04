import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePreviewUpload } from '../../headless/preview-upload.js';
import codeChunks from '../../headless/code-chunks.js';
const { splitCodeChunks, MAX_CODE_CHUNK_CHARS } = codeChunks;

const repo = process.env.GITHUB_REPOSITORY;
const issueNumber = Number(process.env.ISSUE_NUMBER);
const token = process.env.GITHUB_TOKEN;
const targetUrl = new URL(process.env.TARGET_URL || 'https://codelab-pbw9.onrender.com/');
const commandSource = process.env.COMMAND_SOURCE || 'issue';

if (targetUrl.origin !== 'https://codelab-pbw9.onrender.com') {
  throw new Error('Target origin is not allowlisted.');
}

function parseCommand(raw) {
  if (typeof raw !== 'string' || raw.length > 60000) throw new Error('Issue body missing or too large.');
  const cleaned = raw.trim().replace(/^\u0060\u0060\u0060(?:json)?\s*/i, '').replace(/\s*\u0060\u0060\u0060$/, '');
  const command = JSON.parse(cleaned);
  if (command.protocol !== 'codelab-agent-bridge/v1') throw new Error('Unsupported protocol.');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(command.command_id || ''))) throw new Error('Invalid command_id.');
  const allowed = new Set(['headless_batch', 'headless_query', 'headless_design_system', 'design_capture_png', 'status', 'read_page', 'list_controls', 'connections_status', 'ai_ping', 'preview_diagnostics', 'preview_interact', 'preview_editor_smoke_test', 'click', 'read_element', 'fill', 'select', 'sequence', 'project_list', 'project_rename', 'project_save', 'branch_status', 'branch_create', 'branch_resume', 'branch_save', 'branch_merge', 'branch_undo_merge', 'workspace_inspect', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'project_code_transfer', 'design_image_transfer', 'component_search', 'component_inspect', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete', 'design_elements_delete', 'design_element_duplicate', 'design_layer_move', 'design_layer_reorder', 'design_elements_align', 'design_elements_distribute', 'design_prototype_target_set', 'design_layout_configure', 'design_canvas_configure', 'design_element_duplicate', 'design_layer_move', 'design_elements_align', 'design_layout_configure', 'design_canvas_configure', 'project_create', 'project_duplicate', 'project_delete', 'design_template_apply', 'design_history', 'accessibility_audit', 'design_tokens_generate', 'design_export', 'design_import_json', 'design_system_import_json', 'design_system_export_json', 'ai_settings_inspect', 'design_flow_read', 'design_flow_connect', 'design_flow_disconnect', 'ai_generate', 'headless_ai_generate', 'project_convert_design_to_web', 'project_export_html', 'pixelforge_headless_inspect', 'pixelforge_headless_batch', 'pixelforge_headless_export_animation', 'pixelforge_headless_export_png', 'pixelforge_headless_export_project', 'pixelforge_headless_export_layers']);
  if (command.use_admin_session !== undefined && typeof command.use_admin_session !== 'boolean') throw new Error('use_admin_session must be a boolean.');
  if (!allowed.has(command.action)) throw new Error('Action is not allowlisted.');
  // Comments are a read-only mailbox. Mutating interactions remain available only through explicit issue commands.
  if (commandSource === 'comment' && !['status', 'connections_status', 'list_controls', 'preview_diagnostics'].includes(command.action)) {
    throw new Error('Comment mailbox is read-only; use a separately approved issue command for interactions.');
  }
  if (!command.expires_at || !Number.isFinite(Date.parse(command.expires_at))) throw new Error('A valid expires_at is required.');
  if (Date.parse(command.expires_at) < Date.now()) throw new Error('Command expired.');
  const args = command.args && typeof command.args === 'object' && !Array.isArray(command.args) ? command.args : {};
  if (args.self_test !== undefined && typeof args.self_test !== 'boolean') throw new Error('args.self_test must be a boolean.');
  const projectActions = ['headless_design_system', 'headless_query', 'headless_ai_generate', 'pixelforge_headless_inspect', 'pixelforge_headless_batch', 'pixelforge_headless_export_animation', 'pixelforge_headless_export_png', 'pixelforge_headless_export_project', 'pixelforge_headless_export_layers', 'design_capture_png', 'project_list', 'project_rename', 'project_save', 'branch_status', 'branch_create', 'branch_resume', 'branch_save', 'branch_merge', 'branch_undo_merge', 'workspace_inspect', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'project_code_transfer', 'design_image_transfer', 'design_import_json', 'design_system_import_json', 'design_system_export_json', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete', 'design_elements_delete', 'design_element_duplicate', 'design_layer_move', 'design_layer_reorder', 'design_elements_align', 'design_elements_distribute', 'design_prototype_target_set', 'design_layout_configure', 'design_canvas_configure', 'project_create', 'project_duplicate', 'project_delete', 'design_template_apply', 'design_history', 'accessibility_audit', 'design_export', 'design_capture_png', 'design_flow_read', 'design_flow_connect', 'design_flow_disconnect', 'ai_generate', 'project_convert_design_to_web', 'project_export_html', 'headless_batch'];
  if (projectActions.includes(command.action) && command.use_admin_session !== true) {
    throw new Error('Project and branch tools require use_admin_session: true.');
  }
  if (['project_rename', 'project_save', 'branch_status', 'branch_create', 'branch_resume', 'branch_save', 'branch_merge', 'branch_undo_merge', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'project_code_transfer', 'design_image_transfer', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete', 'design_element_duplicate', 'design_layer_move', 'design_elements_align', 'design_elements_distribute', 'design_prototype_target_set', 'design_layout_configure', 'design_canvas_configure', 'project_duplicate', 'project_delete', 'design_template_apply', 'design_history', 'accessibility_audit', 'design_export', 'design_capture_png', 'design_flow_read', 'design_flow_connect', 'design_flow_disconnect', 'ai_generate', 'project_convert_design_to_web', 'project_export_html'].includes(command.action) &&
      (typeof args.project_id !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(args.project_id))) {
    throw new Error('This project action requires a valid args.project_id.');
  }
  if (['pixelforge_headless_inspect', 'pixelforge_headless_batch', 'pixelforge_headless_export_animation', 'pixelforge_headless_export_png', 'pixelforge_headless_export_project', 'pixelforge_headless_export_layers'].includes(command.action) &&
      (typeof args.project_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.project_id))) {
    throw new Error(command.action + ' requires a valid PixelForge args.project_id.');
  }
  if (command.action === 'pixelforge_headless_export_animation') {
    if (args.columns !== undefined && (!Number.isInteger(args.columns) || args.columns < 1 || args.columns > 240)) {
      throw new Error('PixelForge animation export columns must be an integer from 1 to 240.');
    }
    if (args.padding !== undefined && (!Number.isInteger(args.padding) || args.padding < 0 || args.padding > 64)) {
      throw new Error('PixelForge animation export padding must be an integer from 0 to 64.');
    }
  }
  if (['pixelforge_headless_export_png', 'pixelforge_headless_export_project', 'pixelforge_headless_export_layers'].includes(command.action) && command.approval !== 'approved') {
    throw new Error('PixelForge raster/project export requires approval: "approved".');
  }
  if (command.action === 'pixelforge_headless_export_layers') {
    if (args.columns !== undefined && (!Number.isInteger(args.columns) || args.columns < 1 || args.columns > 240)) {
      throw new Error('PixelForge layer export columns must be an integer from 1 to 240.');
    }
    if (args.padding !== undefined && (!Number.isInteger(args.padding) || args.padding < 0 || args.padding > 32)) {
      throw new Error('PixelForge layer export padding must be an integer from 0 to 32.');
    }
  }
  if (command.action === 'pixelforge_headless_batch') {
    if (!Array.isArray(args.actions) || args.actions.length < 1 || args.actions.length > 500) {
      throw new Error('pixelforge_headless_batch requires 1 to 500 allowlisted actions.');
    }
    const readOnlyPixelForgeActions = new Set([
      'document.get_summary', 'canvas.get_pixel', 'canvas.preview_transform_region',
      'animation.get_summary', 'canvas.copy_region',
    ]);
    const hasProjectMutation = args.actions.some(action =>
      !action || typeof action.name !== 'string' || !readOnlyPixelForgeActions.has(action.name)
    );
    if (hasProjectMutation && command.approval !== 'approved') {
      throw new Error('PixelForge Headless edits require approval: "approved".');
    }
    if (JSON.stringify(args.actions).length > 40000) throw new Error('PixelForge Headless actions exceed 40000 characters.');
    if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 500) {
      throw new Error('pixelforge_headless_batch requires a short proposal summary.');
    }
  }
  if (['branch_merge', 'branch_undo_merge'].includes(command.action) && command.approval !== 'approved') {
    throw new Error(command.action + ' changes the main project state; approval: "approved" is required.');
  }
  if (command.action === 'headless_batch') {
    if (!Number.isInteger(args.base_revision) || args.base_revision < 0) throw new Error('headless_batch requires a non-negative base_revision.');
    if (typeof args.operation_id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(args.operation_id)) throw new Error('headless_batch requires a safe operation_id.');
    if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 100) throw new Error('headless_batch requires 1 to 100 operations.');
    if (JSON.stringify(args.operations).length > 50000) throw new Error('headless_batch operations exceed 50000 characters.');
    if (args.operations.some(operation => operation && operation.type === 'project.delete') && command.approval !== 'approved') throw new Error('Headless project deletion requires approval: "approved".');
    if (args.operations.some(operation => operation && ['branch.merge', 'branch.undo_merge'].includes(operation.type)) && command.approval !== 'approved') throw new Error('Headless branch merge/undo requires approval: "approved".');
    if (args.operations.some(operation => operation && operation.type === 'branch.create' && operation.replaceExisting === true) && command.approval !== 'approved') throw new Error('Replacing an existing headless branch requires approval: "approved".');
    if (args.operations.some(operation => operation && operation.type === 'design.template.apply' && operation.replaceExisting === true) && command.approval !== 'approved') throw new Error('Replacing existing design layers with a template requires approval: "approved".');
  }
  if (command.action === 'headless_ai_generate') {
    if (command.approval !== 'approved') throw new Error('Headless AI generation consumes provider quota and changes project code; approval: "approved" is required.');
    if (typeof args.project_id !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(args.project_id)) throw new Error('headless_ai_generate requires a valid project_id.');
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000) throw new Error('headless_ai_generate prompt must contain 1 to 4000 characters.');
    if (!Number.isInteger(args.base_revision) || args.base_revision < 0) throw new Error('headless_ai_generate requires a non-negative base_revision.');
    if (typeof args.operation_id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(args.operation_id)) throw new Error('headless_ai_generate requires a safe operation_id.');
    if (args.source !== undefined && !['main', 'branch'].includes(args.source)) throw new Error('headless_ai_generate source must be main or branch.');
    if (args.max_tokens !== undefined && (!Number.isInteger(args.max_tokens) || args.max_tokens < 256 || args.max_tokens > 32768)) throw new Error('headless_ai_generate max_tokens must be from 256 to 32768.');
  }
  if (command.action === 'headless_design_system') {
    if (!['read', 'write', 'import', 'export'].includes(args.operation)) throw new Error('headless_design_system operation must be read, write, import, or export.');
    if (['write', 'import'].includes(args.operation)) {
      if (command.approval !== 'approved') throw new Error('Changing workspace design-system settings requires approval: "approved".');
      if (!Number.isInteger(args.base_revision) || args.base_revision < 0) throw new Error('headless_design_system writes require a non-negative base_revision.');
    }
    if (args.operation === 'write' && (!args.settings || typeof args.settings !== 'object' || Array.isArray(args.settings))) {
      throw new Error('headless_design_system write requires a settings object.');
    }
    if (args.operation === 'import' && (typeof args.json !== 'string' || args.json.length < 2 || args.json.length > 50000)) {
      throw new Error('headless_design_system import requires JSON between 2 and 50000 characters.');
    }
    if (args.settings && JSON.stringify(args.settings).length > 20000) throw new Error('headless_design_system settings exceed 20000 characters.');
  }
  if (command.action === 'headless_query') {
    const supportedQueries = ['component.search', 'component.inspect', 'design.tokens.generate', 'project.list', 'project.inspect', 'project.code.read', 'design.read', 'accessibility.audit', 'branch.inspect', 'design.history.inspect', 'design.template.list', 'design.capture.context', 'design.accessibility.audit', 'design.export.json', 'design.export.svg', 'design.export.html', 'headless.operation.status'];
    if (!supportedQueries.includes(args.query_action)) throw new Error('headless_query requires a supported query_action.');
    if (args.query_args !== undefined && (!args.query_args || typeof args.query_args !== 'object' || Array.isArray(args.query_args))) throw new Error('headless_query query_args must be an object.');
    if (args.expected_revision !== undefined && (!Number.isInteger(args.expected_revision) || args.expected_revision < 0)) throw new Error('headless_query expected_revision must be a non-negative integer.');
    if (JSON.stringify(args.query_args || {}).length > 20000) throw new Error('headless_query query_args exceed 20000 characters.');
    const queryArgs = args.query_args || {};
    if (['project.inspect', 'project.code.read', 'design.read', 'accessibility.audit', 'branch.inspect', 'design.history.inspect', 'design.capture.context', 'design.accessibility.audit', 'design.export.json', 'design.export.svg', 'design.export.html'].includes(args.query_action) &&
        (typeof queryArgs.projectId !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(queryArgs.projectId))) {
      throw new Error(args.query_action + ' requires a valid query_args.projectId.');
    }
    if (args.query_action === 'component.inspect' && (typeof queryArgs.componentId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(queryArgs.componentId))) {
      throw new Error('component.inspect requires a valid query_args.componentId.');
    }
  }
  if (command.action === 'project_rename' &&
      (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 200)) {
    throw new Error('project_rename requires args.name between 1 and 200 characters.');
  }
  if (command.action === 'project_code_transfer') {
    if (!['begin', 'chunk', 'commit'].includes(args.operation)) throw new Error('project_code_transfer operation must be begin, chunk, or commit.');
    if (args.operation === 'begin') {
      if (!['html', 'css', 'js'].includes(args.field)) throw new Error('project_code_transfer begin requires field html, css, or js.');
      if (!Number.isInteger(args.total_chunks) || args.total_chunks < 1 || args.total_chunks > 70) throw new Error('project_code_transfer total_chunks must be from 1 to 70.');
      if (typeof args.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.sha256)) throw new Error('project_code_transfer begin requires a SHA-256 hash.');
    }
    if (args.operation === 'chunk') {
      if (typeof args.transfer_id !== 'string' || !/^[a-f0-9]{32}$/.test(args.transfer_id)) throw new Error('project_code_transfer chunk requires transfer_id.');
      if (!Number.isInteger(args.index) || args.index < 0 || args.index > 69) throw new Error('project_code_transfer chunk index is invalid.');
      if (typeof args.chunk !== 'string' || args.chunk.length > 8000) throw new Error('project_code_transfer chunk must be at most 8000 characters.');
      if (typeof args.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.sha256)) throw new Error('project_code_transfer chunk requires a SHA-256 hash.');
    }
    if (args.operation === 'commit' && (typeof args.transfer_id !== 'string' || !/^[a-f0-9]{32}$/.test(args.transfer_id))) {
      throw new Error('project_code_transfer commit requires transfer_id.');
    }
  }
  if (command.action === 'design_image_transfer') {
    if (!['begin', 'chunk', 'commit'].includes(args.operation)) throw new Error('design_image_transfer operation must be begin, chunk, or commit.');
    if (args.operation === 'begin') {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(args.mime)) throw new Error('design_image_transfer begin requires a supported image MIME.');
      if (!Number.isInteger(args.total_chunks) || args.total_chunks < 1 || args.total_chunks > 400) throw new Error('design_image_transfer total_chunks must be from 1 to 400.');
      if (typeof args.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.sha256)) throw new Error('design_image_transfer begin requires the SHA-256 of the decoded image bytes.');
    }
    if (args.operation === 'chunk') {
      if (typeof args.transfer_id !== 'string' || !/^[a-f0-9]{32}$/.test(args.transfer_id)) throw new Error('design_image_transfer chunk requires transfer_id.');
      if (!Number.isInteger(args.index) || args.index < 0 || args.index > 399) throw new Error('design_image_transfer chunk index is invalid.');
      if (typeof args.chunk !== 'string' || args.chunk.length > 8000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.chunk)) throw new Error('design_image_transfer chunk must be valid Base64 up to 8000 characters.');
    }
    if (args.operation === 'commit' && (typeof args.transfer_id !== 'string' || !/^[a-f0-9]{32}$/.test(args.transfer_id))) {
      throw new Error('design_image_transfer commit requires transfer_id.');
    }
  }
  if (command.action === 'project_code_write') {
  if (command.action === 'project_export_html' && args.max_chars !== undefined &&
      (!Number.isInteger(args.max_chars) || args.max_chars < 1000 || args.max_chars > 7000)) {
    throw new Error('project_export_html max_chars must be an integer from 1000 to 7000.');
  }
  if (command.action === 'ai_generate') {
    if (command.approval !== 'approved') throw new Error('AI generation changes project code and may consume API quota; approval: "approved" is required.');
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000) throw new Error('ai_generate requires a prompt between 1 and 4000 characters.');
    if (args.source !== undefined && !['main', 'branch'].includes(args.source)) throw new Error('ai_generate source must be main or branch.');
    if (args.operation_id !== undefined && (typeof args.operation_id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(args.operation_id))) throw new Error('ai_generate operation_id must be a safe string of 8 to 100 characters.');
    if (args.max_tokens !== undefined && (!Number.isInteger(args.max_tokens) || args.max_tokens < 256 || args.max_tokens > 32768)) throw new Error('ai_generate max_tokens must be from 256 to 32768.');
  }
  if (command.action === 'project_delete' && command.approval !== 'approved') throw new Error('Permanent project deletion requires approval: "approved".');
  if (command.action === 'design_template_apply') {
    if (!['landing', 'dashboard', 'portfolio'].includes(args.template_id)) throw new Error('design_template_apply requires a supported template_id.');
    if (args.replace_existing !== undefined && typeof args.replace_existing !== 'boolean') throw new Error('replace_existing must be a boolean.');
    if (args.replace_existing === true && command.approval !== 'approved') throw new Error('Replacing existing design layers requires approval: "approved".');
  }
  if (command.action === 'design_history' && !['undo', 'redo'].includes(args.operation)) throw new Error('design_history operation must be undo or redo.');
  if (command.action === 'design_flow_connect') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_flow_connect requires a valid element_id.');
    if (typeof args.target_project_id !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(args.target_project_id)) throw new Error('design_flow_connect requires a valid target_project_id.');
  }
  if (command.action === 'design_flow_disconnect') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_flow_disconnect requires a valid element_id.');
    if (typeof args.target_project_id !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(args.target_project_id)) throw new Error('design_flow_disconnect requires a valid target_project_id.');
  }
  if (command.action === 'design_export' && !['svg', 'json'].includes(args.format)) throw new Error('design_export format must be svg or json.');
  if (command.action === 'design_import_json' && (typeof args.json !== 'string' || args.json.length < 2 || args.json.length > 50000)) throw new Error('design_import_json requires a JSON string between 2 and 50000 characters.');
  if (command.action === 'design_system_import_json' && (typeof args.json !== 'string' || args.json.length < 2 || args.json.length > 50000)) throw new Error('design_system_import_json requires a JSON string between 2 and 50000 characters.');
  if (command.action === 'design_tokens_generate') {
    if (args.settings !== undefined && (!args.settings || typeof args.settings !== 'object' || Array.isArray(args.settings))) throw new Error('settings must be an object.');
  }
  if (command.action === 'project_create') {
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 200) throw new Error('project_create requires a name between 1 and 200 characters.');
    if (!['web', 'design'].includes(args.type || 'web')) throw new Error('project_create type must be web or design.');
  }
  if (command.action === 'component_search') {
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) throw new Error('component_search query must be a string up to 200 characters.');
    if (args.category !== undefined && (typeof args.category !== 'string' || args.category.length > 100)) throw new Error('component_search category must be a string up to 100 characters.');
  }
  if (command.action === 'component_inspect' && (typeof args.component_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.component_id))) throw new Error('component_inspect requires a valid component_id.');
  if (command.action === 'component_inspect' && args.max_chars !== undefined && (!Number.isInteger(args.max_chars) || args.max_chars < 1000 || args.max_chars > 7000)) throw new Error('component_inspect max_chars must be an integer from 1000 to 7000.');
  if (command.action === 'component_insert' && (typeof args.component_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.component_id))) {
    throw new Error('component_insert requires a valid component_id.');
  }
  if (command.action === 'design_element_add' && !['heading', 'text', 'button', 'rectangle', 'ellipse', 'image'].includes(args.type)) {
    throw new Error('design_element_add requires a supported element type.');
  }
  if (command.action === 'design_elements_delete') {
    if (!Array.isArray(args.element_ids) || args.element_ids.length < 1 || args.element_ids.length > 100 || args.element_ids.some(id => typeof id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(id)) || new Set(args.element_ids).size !== args.element_ids.length) {
      throw new Error('design_elements_delete requires 1 to 100 unique valid element_ids.');
    }
  }
  if (command.action === 'design_element_update') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_element_update requires a valid element_id.');
    if (!args.properties || typeof args.properties !== 'object' || Array.isArray(args.properties)) throw new Error('design_element_update requires a properties object.');
    const allowedProperties = ['label', 'text', 'x', 'y', 'width', 'height', 'color', 'background', 'fontSize', 'weight', 'radius', 'href', 'src', 'alt', 'objectFit', 'textAlign'];
    for (const [key, value] of Object.entries(args.properties)) {
      if (!allowedProperties.includes(key)) throw new Error('Unsupported design element property: ' + key);
      if (typeof value === 'string' && value.length > 2000) throw new Error('Design element string properties are limited to 2000 characters.');
      if (key === 'textAlign' && !['left', 'center', 'right'].includes(value)) throw new Error('textAlign must be left, center, or right.');
      if (key === 'objectFit' && !['contain', 'cover', 'fill'].includes(value)) throw new Error('objectFit must be contain, cover, or fill.');
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Design element numeric properties must be finite.');
      if (!['string', 'number'].includes(typeof value)) throw new Error('Design element properties must be strings or numbers.');
    }
    if (!Object.keys(args.properties).length) throw new Error('design_element_update requires at least one property.');
  }
  if (command.action === 'design_element_delete' && (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id))) {
    throw new Error('design_element_delete requires a valid element_id.');
  }
  if (command.action === 'design_element_duplicate' && (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id))) throw new Error('design_element_duplicate requires a valid element_id.');
  if (command.action === 'design_layer_move') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_layer_move requires a valid element_id.');
    if (!['front', 'back'].includes(args.direction)) throw new Error('design_layer_move direction must be front or back.');
  }
  if (command.action === 'design_layer_reorder') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_layer_reorder requires a valid element_id.');
    if (!Number.isInteger(args.target_index) || args.target_index < 0 || args.target_index > 499) throw new Error('design_layer_reorder target_index must be an integer from 0 to 499.');
  }
  if (command.action === 'design_elements_align') {
    if (!['left', 'center-x', 'right', 'top', 'center-y', 'bottom'].includes(args.mode)) throw new Error('design_elements_align requires a supported alignment mode.');
    if (!Array.isArray(args.element_ids) || args.element_ids.length < 1 || args.element_ids.length > 50 || args.element_ids.some(id => typeof id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error('design_elements_align requires 1 to 50 valid element_ids.');
  }
  if (command.action === 'design_elements_distribute') {
    if (!Array.isArray(args.element_ids) || args.element_ids.length < 3 || args.element_ids.length > 100 ||
        args.element_ids.some(id => typeof id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(id)) ||
        new Set(args.element_ids).size !== args.element_ids.length) {
      throw new Error('design_elements_distribute requires 3 to 100 unique valid element_ids.');
    }
    if (!['horizontal', 'vertical'].includes(args.axis)) throw new Error('design_elements_distribute axis must be horizontal or vertical.');
  }
  if (command.action === 'design_prototype_target_set') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_prototype_target_set requires a valid element_id.');
    if (typeof args.target !== 'string' || args.target.length > 2048 || /[<>\u0000-\u001f]/.test(args.target)) throw new Error('design_prototype_target_set target must be a safe string up to 2048 characters.');
    const target = args.target.trim();
    const isLayerTarget = /^#layer-[a-z0-9_-]{1,120}$/i.test(target);
    let isWebTarget = false;
    try {
      const url = new URL(target);
      isWebTarget = (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch (_) {}
    if (target && !isLayerTarget && !isWebTarget) throw new Error('target must be an HTTP(S) URL without credentials or a #layer-<id> fragment supported by CodeLab.');
  }
  if (command.action === 'design_layout_configure') {
    const allowedLayoutKeys = ['mode', 'direction', 'gap', 'padding'];
    if (!allowedLayoutKeys.some(key => Object.prototype.hasOwnProperty.call(args, key))) throw new Error('design_layout_configure requires at least one layout property.');
    if (args.mode !== undefined && !['free', 'auto'].includes(args.mode)) throw new Error('Layout mode must be free or auto.');
    if (args.direction !== undefined && !['row', 'column'].includes(args.direction)) throw new Error('Layout direction must be row or column.');
    for (const key of ['gap', 'padding']) if (args[key] !== undefined && (!Number.isFinite(args[key]) || args[key] < 0 || args[key] > 200)) throw new Error(key + ' must be a number between 0 and 200.');
  }
  if (command.action === 'design_canvas_configure') {
    const allowedCanvasKeys = ['frame', 'grid', 'snap_to_grid', 'grid_size', 'zoom', 'background', 'canvas_width', 'canvas_height'];
    if (!allowedCanvasKeys.some(key => Object.prototype.hasOwnProperty.call(args, key))) throw new Error('design_canvas_configure requires at least one canvas property.');
    if (args.frame !== undefined && !['desktop', 'tablet', 'mobile'].includes(args.frame)) throw new Error('Frame must be desktop, tablet, or mobile.');
    for (const key of ['grid', 'snap_to_grid']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(key + ' must be boolean.');
    if (args.grid_size !== undefined && ![4, 8, 16, 32].includes(args.grid_size)) throw new Error('grid_size must be 4, 8, 16, or 32.');
    if (args.zoom !== undefined && (!Number.isFinite(args.zoom) || args.zoom < 10 || args.zoom > 150)) throw new Error('zoom must be between 10 and 150.');
    if (args.background !== undefined && (typeof args.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(args.background))) throw new Error('background must be a six-digit hex color.');
    if (args.canvas_width !== undefined && (!Number.isInteger(args.canvas_width) || args.canvas_width < 100 || args.canvas_width > 4000)) throw new Error('canvas_width must be an integer between 100 and 4000.');
    if (args.canvas_height !== undefined && (!Number.isInteger(args.canvas_height) || args.canvas_height < 100 || args.canvas_height > 10000)) throw new Error('canvas_height must be an integer between 100 and 10000.');
  }
    if (!['main', 'branch'].includes(args.source || 'main')) throw new Error('project_code_write source must be main or branch.');
    const codeKeys = ['html', 'css', 'js'].filter(key => Object.prototype.hasOwnProperty.call(args, key));
    if (!codeKeys.length) throw new Error('project_code_write requires at least one of html, css, or js.');
    for (const key of codeKeys) {
      if (typeof args[key] !== 'string' || args[key].length > 50000) throw new Error('Each supplied code field must be a string of at most 50000 characters.');
    }
  }
  if (commandSource === 'comment' && args.self_test === true) throw new Error('Preview diagnostic self-test is not allowed from the read-only comment mailbox.');
  for (const key of ['selector', 'value']) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > 2000)) throw new Error('Invalid ' + key + '.');
  }
  if (['click', 'read_element', 'fill', 'select'].includes(command.action) && !args.selector) {
    throw new Error('This action requires args.selector.');
  }
  if (['fill', 'select'].includes(command.action) && typeof args.value !== 'string') {
    throw new Error('This action requires args.value.');
  }
  if (command.action === 'click' && command.approval !== 'approved') {
    throw new Error('Click commands require approval: "approved".');
  }
  if (command.action === 'preview_interact') {
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 20) {
      throw new Error('preview_interact requires between 1 and 20 steps.');
    }
    for (const step of args.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step) || !['click', 'fill', 'select', 'upload', 'read', 'check', 'uncheck', 'press', 'hover', 'focus', 'assert_text', 'assert_visible', 'assert_enabled'].includes(step.action)) {
        throw new Error('Invalid preview interaction step.');
      }
      if (typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 2000) {
        throw new Error('Each preview interaction step requires a valid selector.');
      }
      if (['fill', 'select', 'assert_text'].includes(step.action) && (typeof step.value !== 'string' || step.value.length > 2000)) {
        throw new Error('Preview fill/select/assert_text steps require a string value of at most 2000 characters.');
      }
      if (step.action === 'upload') validatePreviewUpload(step);
      if (step.action === 'press' && !['Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(step.value)) {
        throw new Error('Preview press steps only allow non-submitting navigation keys.');
      }
      if (step.action === 'click' && command.approval !== 'approved') {
        throw new Error('Preview click steps require approval: "approved".');
      }
    }
  }
  if (command.action === 'sequence') {
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 50) {
      throw new Error('Sequence requires between 1 and 50 steps.');
    }
    for (const step of args.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Invalid sequence step.');
      if (!['click', 'fill', 'select'].includes(step.action)) throw new Error('Sequence step action is not allowlisted.');
      if (typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 2000) {
        throw new Error('Each sequence step requires a valid selector.');
      }
      if (['fill', 'select'].includes(step.action) && (typeof step.value !== 'string' || step.value.length > 2000)) {
        throw new Error('Fill/select sequence steps require a string value of at most 2000 characters.');
      }
      if (step.action === 'click' && command.approval !== 'approved') {
        throw new Error('Sequence click steps require approval: "approved".');
      }
    }
  }
  return { ...command, args };
}

async function comment(body) {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ body })
  });
  if (!response.ok) throw new Error('Could not post result to GitHub (HTTP ' + response.status + ').');
}

async function getJson(page, path) {
  try {
    const response = await page.request.get(new URL(path, targetUrl).href, { timeout: 12000 });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    return { httpStatus: response.status(), ok: response.ok(), data };
  } catch (error) {
    return { httpStatus: null, ok: false, error: String(error?.message || error).slice(0, 250) };
  }
}


async function createHeadlessPreview(projectId, source = 'main', selfTest = false, fixture = 'diagnostics') {
  let code;
  let workspaceRevisionRead = null;
  if (selfTest) {
    if (fixture === 'interactions') {
      code = {
        html: '<main><button id="probe-increment">Increment</button><output id="probe-count">0</output><label>Nombre <input id="probe-input" value=""></label><output id="probe-echo"></output></main>',
        css: '',
        js: 'const b=document.getElementById("probe-increment");const c=document.getElementById("probe-count");const i=document.getElementById("probe-input");const e=document.getElementById("probe-echo");b.addEventListener("click",()=>{c.textContent=String(Number(c.textContent)+1)});i.addEventListener("input",()=>{e.textContent=i.value});console.log("CODELAB_PREVIEW_INTERACTION_READY");'
      };
    } else {
      code = {
        html: '<main id="codelab-diagnostic-probe"><h1>Preview probe</h1><button id="probe-action">Probe action</button></main>',
        css: '',
        js: 'console.error("CODELAB_PREVIEW_DIAGNOSTIC_SELF_TEST");throw new Error("CODELAB_PREVIEW_DIAGNOSTIC_SELF_TEST_PAGEERROR");'
      };
    }
  } else {
    const saved = await page.evaluate(async ({ projectId, source }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable for headless preview.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          action: 'project.code.read',
          args: { projectId, source, languages: ['html', 'css', 'js'], maxChars: 200000 }
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error('Could not read saved project code for preview (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
      const fields = data.result && data.result.fields;
      if (!fields || ['html', 'css', 'js'].some(key => !fields[key] || fields[key].truncated)) {
        throw new Error('Project code exceeds the 200000-character headless preview read limit. No preview was opened.');
      }
      const code = Object.fromEntries(['html', 'css', 'js'].map(key => [key, fields[key].value]));
      if (code.html.length + code.css.length + code.js.length > 200000) {
        throw new Error('Combined project code exceeds the 200000-character headless preview limit.');
      }
      return { code, revision: data.revision };
    }, { projectId, source });
    code = saved.code;
    workspaceRevisionRead = saved.revision;
  }

  const css = String(code.css || '').replace(/<\/style/gi, '<\\/style');
  const js = String(code.js || '').replace(/<\/script/gi, '<\\/script');
  const errScript = '<script>' +
    'window.onerror=function(msg,url,line,col){window.parent.postMessage({type:"CONSOLE_LOG",logType:"error",message:"Línea "+line+":"+col+" - "+msg},"*")};' +
    'console.log=function(){var a=[].slice.call(arguments);window.parent.postMessage({type:"CONSOLE_LOG",logType:"log",message:a.join(" ")},"*")};' +
    'console.error=function(){var a=[].slice.call(arguments);window.parent.postMessage({type:"CONSOLE_LOG",logType:"error",message:a.join(" ")},"*")};' +
    '<\/script>';
  const srcdoc = '<!doctype html><html><head><meta charset="UTF-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data: https: http:; font-src data: https: http:; connect-src \'none\';">' +
    '<style>' + css + '</style>' + errScript + '</head><body>' + String(code.html || '') +
    '<script>' + js + '<\/script></body></html>';

  const previewContext = await browser.newContext({ serviceWorkers: 'block' });
  const previewPage = await previewContext.newPage();
  const browserDiagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], expectedBlockedRequests: [] };
  previewPage.on('console', message => {
    if (message.type() === 'error' && browserDiagnostics.consoleErrors.length < 30) {
      browserDiagnostics.consoleErrors.push({ message: message.text().slice(0, 300), location: message.location().url || null });
    }
  });
  previewPage.on('pageerror', error => {
    if (browserDiagnostics.pageErrors.length < 30) browserDiagnostics.pageErrors.push(String(error.message || error).slice(0, 300));
  });
  previewPage.on('requestfailed', request => {
    if (browserDiagnostics.failedRequests.length < 30) browserDiagnostics.failedRequests.push({
      url: safeUrl(request.url()), failure: String(request.failure()?.errorText || 'request failed').slice(0, 200)
    });
  });

  try {
    await previewPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await previewPage.setContent(
      '<!doctype html><html><head><meta charset="utf-8"><title>CodeLab headless preview</title></head><body>' +
      '<iframe id="headlessPreview" title="Isolated project preview" sandbox="allow-scripts allow-forms" style="width:100%;height:100vh;border:0"></iframe>' +
      '<script>window.__codelabPreviewMessages=[];window.addEventListener("message",function(e){var f=document.getElementById("headlessPreview");if(f&&e.source===f.contentWindow&&e.data&&e.data.type==="CONSOLE_LOG")window.__codelabPreviewMessages.push(e.data)});<\/script>' +
      '</body></html>',
      { waitUntil: 'domcontentloaded' }
    );
    browserDiagnostics.consoleErrors.length = 0;
    browserDiagnostics.pageErrors.length = 0;
    browserDiagnostics.failedRequests.length = 0;
    browserDiagnostics.expectedBlockedRequests.length = 0;
    await previewPage.locator('#headlessPreview').evaluate((frame, html) => { frame.srcdoc = html; }, srcdoc);
    const previewFrame = previewPage.frameLocator('#headlessPreview');
    await previewFrame.locator('body').waitFor({ state: 'attached', timeout: 12000 });
    await previewPage.waitForTimeout(250);
    return { page: previewPage, context: previewContext, frame: previewFrame, diagnostics: browserDiagnostics, revision: workspaceRevisionRead, srcdoc };
  } catch (error) {
    await previewContext.close().catch(() => {});
    throw error;
  }
}

let browser;
let page;
let result;
let commandId = 'unknown';
let commandAction = 'unknown';
let stage = 'parse_command';
let currentStep = null;
if (command.action === 'ai_generate') {
  const source = command.args.source || 'main';
  const projectId = command.args.project_id;
  const baseRevision = await page.evaluate(async ({ projectId, source }) => {
    const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
    const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
    if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
    const query = async (action, args) => {
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action, args })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved project query failed.');
      return data;
    };
    const project = await query('project.inspect', { projectId });
    if (project.result.type === 'design') throw new Error('AI code generation requires a web project.');
    if (source === 'branch' && !project.result.branch) throw new Error('Project has no saved copy branch.');
    const code = await query('project.code.read', { projectId, source, languages: ['html'], maxChars: 1 });
    return code.revision;
  }, { projectId, source });
  command.action = 'headless_ai_generate';
  command.args.base_revision = baseRevision;
  command.args.operation_id = command.args.operation_id || 'legacy_ai_' + String(command.command_id).slice(0, 90);
  command.args.source = source;
}
const startedAt = Date.now();

async function executeSavedDesignBatch(action, args) {
  return page.evaluate(async ({ action, args }) => {
    const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
    const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
    if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
    const query = async (queryAction, queryArgs) => {
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action: queryAction, args: queryArgs })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved design query failed.');
      return data;
    };
    const before = await query('design.read', { projectId: args.project_id, limit: 500 });
    const beforeDesign = before.result;
    const elements = beforeDesign.elements || [];
    const selected = ids => {
      const found = elements.filter(item => ids.includes(item.id));
      if (found.length !== ids.length) throw new Error('One or more design elements were not found.');
      return found;
    };
    let operations;
    let settings = null;
    if (action === 'design_element_add') {
      operations = [{ type: 'element.add', elementType: args.type }];
    } else if (action === 'design_element_update') {
      operations = [{ type: 'element.update', id: args.element_id, properties: args.properties }];
    } else if (action === 'design_element_delete') {
      operations = [{ type: 'element.delete', id: args.element_id }];
    } else if (action === 'design_elements_delete') {
      selected(args.element_ids);
      operations = [{ type: 'elements.delete', ids: args.element_ids }];
    } else if (action === 'design_element_duplicate') {
      selected([args.element_id]);
      operations = [{ type: 'element.duplicate', id: args.element_id }];
    } else if (action === 'design_layer_move') {
      const index = elements.findIndex(item => item.id === args.element_id);
      if (index < 0) throw new Error('Design element not found.');
      const targetIndex = Math.max(0, Math.min(elements.length - 1, index + (args.direction === 'back' ? -1 : 1)));
      operations = [{ type: 'element.reorder', id: args.element_id, targetIndex }];
    } else if (action === 'design_layer_reorder') {
      const index = elements.findIndex(item => item.id === args.element_id);
      if (index < 0) throw new Error('Design element not found.');
      if (args.target_index >= elements.length) throw new Error('target_index exceeds the current layer count.');
      operations = [{ type: 'element.reorder', id: args.element_id, targetIndex: args.target_index }];
    } else if (action === 'design_elements_align') {
      selected(args.element_ids);
      operations = [{ type: 'elements.align', ids: args.element_ids, mode: args.mode }];
    } else if (action === 'design_elements_distribute') {
      selected(args.element_ids);
      if (beforeDesign.layout.mode === 'auto') throw new Error('Switch the design to free layout before manual distribution.');
      operations = [{ type: 'elements.distribute', ids: args.element_ids, axis: args.axis }];
    } else if (action === 'design_layout_configure') {
      settings = Object.fromEntries(['mode', 'direction', 'gap', 'padding'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
      operations = [{ type: 'layout.set', ...settings }];
    } else {
      throw new Error('Unsupported saved design action: ' + action);
    }
    const beforeIds = new Set(elements.map(item => item.id));
    const sourceBefore = elements.find(item => item.id === args.element_id) || null;
    const beforePositions = elements.filter(item => (args.element_ids || [args.element_id]).includes(item.id))
      .map(item => ({ id: item.id, x: item.x, y: item.y }));
    const operationId = 'design_action_' + crypto.randomUUID().replace(/-/g, '');
    const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
      body: JSON.stringify({
        baseRevision: before.revision, operationId,
        operations: [{
          type: 'design.batch', projectId: args.project_id,
          expectedDesignRevision: beforeDesign.revision, operations
        }]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless design operation failed.');
    const after = await query('design.read', { projectId: args.project_id, limit: 500 });
    const afterDesign = after.result;
    if (afterDesign.revision <= beforeDesign.revision) throw new Error('Design mutation did not advance the saved design revision.');
    const afterElements = afterDesign.elements || [];
    const afterById = new Map(afterElements.map(item => [item.id, item]));
    const newElements = afterElements.filter(item => !beforeIds.has(item.id));
    const positions = afterElements.filter(item => (args.element_ids || [args.element_id]).includes(item.id))
      .map(item => ({ id: item.id, x: item.x, y: item.y }));
    const changed = JSON.stringify(beforePositions) !== JSON.stringify(positions);
    const base = {
      projectId: args.project_id, action, saved: true, serverReadbackVerified: true,
      workspaceRevision: after.revision, designRevision: afterDesign.revision,
      elementCount: afterDesign.elementCount, operationTypes: operations.map(item => item.type)
    };
    if (action === 'design_element_add') {
      if (!newElements[0]) throw new Error('Design element add failed authoritative server readback.');
      return { ...base, elementId: newElements[0].id, type: newElements[0].type };
    }
    if (action === 'design_element_update') {
      const element = afterById.get(args.element_id);
      const verified = !!element && Object.entries(args.properties).every(([key, value]) => {
        if (key === 'src') return element.hasImageSource === (value.length > 0) && element.imageSourceLength === value.length;
        return element[key] === value;
      });
      if (!verified) throw new Error('Design element update failed authoritative server readback.');
      return { ...base, elementId: args.element_id, changedProperties: Object.keys(args.properties), verified };
    }
    if (action === 'design_element_delete') {
      const deleted = !afterById.has(args.element_id);
      if (!deleted) throw new Error('Design element deletion failed authoritative server readback.');
      return { ...base, elementId: args.element_id, deleted, remainingElements: afterDesign.elementCount };
    }
    if (action === 'design_elements_delete') {
      const deleted = args.element_ids.every(id => !afterById.has(id));
      const danglingConnections = afterDesign.flowConnections.filter(item => args.element_ids.includes(item.sourceElementId)).length;
      if (!deleted || danglingConnections) throw new Error('Bulk deletion failed authoritative layer/connection readback.');
      return { ...base, deletedElementIds: args.element_ids, deleted, danglingConnections, remainingElements: afterDesign.elementCount };
    }
    if (action === 'design_element_duplicate') return {
      ...base, sourceElementId: args.element_id, elementId: newElements[0]?.id || null,
      duplicated: !!newElements[0] && newElements[0].type === sourceBefore?.type && newElements[0].x === (Number(sourceBefore?.x) || 0) + 24 && newElements[0].y === (Number(sourceBefore?.y) || 0) + 24
    };
    if (action === 'design_layer_move') return {
      ...base, elementId: args.element_id, direction: args.direction,
      moved: (afterElements.findIndex(item => item.id === args.element_id) !== elements.findIndex(item => item.id === args.element_id)),
      order: afterElements.map(item => item.id)
    };
    if (action === 'design_layer_reorder') {
      const verified = afterElements[args.target_index]?.id === args.element_id;
      if (!verified) throw new Error('Layer reorder failed authoritative server readback.');
      return { ...base, elementId: args.element_id, fromIndex: elements.findIndex(item => item.id === args.element_id), targetIndex: args.target_index, changed: changed, order: afterElements.map(item => item.id) };
    }
    if (action === 'design_elements_align') return { ...base, mode: args.mode, elementIds: args.element_ids, changed, positions };
    if (action === 'design_elements_distribute') {
      if (!changed) throw new Error('Distribution did not change saved element positions.');
      return { ...base, axis: args.axis, elementIds: args.element_ids, changed, positions };
    }
    const layoutVerified = Object.entries(settings || {}).every(([key, value]) => afterDesign.layout[key] === value);
    if (!layoutVerified) throw new Error('Layout configuration failed authoritative server readback.');
    return { ...base, settings: afterDesign.layout, changed: Object.keys(settings || {}) };
  }, { action, args });
}

try {
  const command = parseCommand(process.env.ISSUE_BODY || '');
  commandId = command.command_id;
  commandAction = command.action;
  stage = 'launch_browser';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  const browserDiagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], expectedBlockedRequests: [] };
  const intentionallyBlockedUrls = new Set();
  const safeUrl = value => {
    try { const url = new URL(value); return url.origin + url.pathname; } catch (_) { return String(value || '').slice(0, 180); }
  };
  page.on('console', message => {
    const location = message.location()?.url || '';
    if (message.type() === 'error' && /net::ERR_FAILED/.test(message.text() || '') && intentionallyBlockedUrls.has(location)) return;
    if (message.type() === 'error' && browserDiagnostics.consoleErrors.length < 30) {
      browserDiagnostics.consoleErrors.push({
        text: String(message.text() || '').slice(0, 500),
        location: safeUrl(location)
      });
    }
  });
  page.on('pageerror', error => {
    if (browserDiagnostics.pageErrors.length < 30) browserDiagnostics.pageErrors.push(String(error?.message || error).slice(0, 500));
  });
  page.on('requestfailed', request => {
    if (intentionallyBlockedUrls.has(request.url())) {
      if (browserDiagnostics.expectedBlockedRequests.length < 30) browserDiagnostics.expectedBlockedRequests.push({
        url: safeUrl(request.url()),
        method: request.method(),
        reason: 'Intentionally blocked by the isolated preview test to prevent workspace persistence.'
      });
      return;
    }
    if (browserDiagnostics.failedRequests.length < 30) browserDiagnostics.failedRequests.push({
      url: safeUrl(request.url()),
      method: request.method(),
      failure: String(request.failure()?.errorText || 'request failed').slice(0, 200),
      resourceType: request.resourceType()
    });
  });
  if (command.action === 'preview_editor_smoke_test') {
    // Keep all workspace API traffic blocked in this disposable browser so the test cannot persist projects.
    await page.route('**/api/workspace**', route => {
      intentionallyBlockedUrls.add(route.request().url());
      return route.abort();
    });
  }
  stage = 'initial_navigation';
  await page.goto(targetUrl.href, { waitUntil: 'load', timeout: 45000 });
  // Credentials are read only from GitHub Actions secrets, never from issue bodies.
  if (command.use_admin_session === true) {
    stage = 'admin_authentication';
    const username = process.env.CODELAB_ADMIN_USERNAME || '';
    const password = process.env.CODELAB_ADMIN_PASSWORD || '';
    if (!username || !password) throw new Error('Authenticated bridge unavailable: configure CODELAB_ADMIN_USERNAME and CODELAB_ADMIN_PASSWORD as repository Actions secrets.');
    const login = await page.request.post(new URL('/api/auth/login', targetUrl).href, {
      timeout: 20000,
      headers: { 'content-type': 'application/json' },
      data: { username, password }
    });
    const loginData = await login.json().catch(() => ({}));
    if (!login.ok() || loginData.ok !== true) throw new Error('CodeLab ADMIN login failed (HTTP ' + login.status() + '). Check the Actions secrets and account status.');
    result = { authenticatedAs: loginData.user?.name || username, role: loginData.user?.role || null, mustChangePassword: !!loginData.mustChangePassword };
    stage = 'post_login_navigation';
    await page.goto(targetUrl.href, { waitUntil: 'load', timeout: 45000 });
  }
  // Let the app's own initialization and initial API calls finish before inspecting it.
  stage = 'page_initialization';
  await page.waitForTimeout(2500);
  stage = 'execute_action';

  if (command.action === 'ai_settings_inspect') {
    stage = 'ai_settings_inspect';
    result = await page.evaluate(() => ({
      mode: typeof aiSettings !== 'undefined' ? aiSettings.mode : null,
      model: typeof aiSettings !== 'undefined' ? aiSettings.model : null,
      baseUrl: typeof aiSettings !== 'undefined' ? aiSettings.baseUrl : null,
      apiKeyConfigured: !!(typeof aiSettings !== 'undefined' && aiSettings.apiKey),
      serverKeyConfigured: !!(typeof serverAi !== 'undefined' && serverAi.serverKey),
      serverModel: typeof serverAi !== 'undefined' ? serverAi.model : null,
      hint: typeof serverAi !== 'undefined' ? serverAi.hint : null,
      apiKeyExposed: false
    }));
  } else if (command.action === 'accessibility_audit') {
    stage = 'accessibility_audit';
    result = await page.evaluate(async projectId => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action: 'accessibility.audit', args: { projectId } })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || 'Saved accessibility audit failed.');
      return { projectId, report: data.result, workspaceRevision: data.revision, readOnly: true };
    }, command.args.project_id);
  } else if (command.action === 'design_tokens_generate') {
    stage = 'design_tokens_generate';
    result = await page.evaluate(settings => {
      const api = window.CodeLabDesignTools;
      if (!api || typeof api.sanitizeSettings !== 'function' || typeof api.buildDesignTokens !== 'function' || typeof api.toCssVariables !== 'function') {
        throw new Error('Design token API is not ready.');
      }
      const normalized = api.sanitizeSettings(settings || api.defaults);
      const tokens = api.buildDesignTokens(normalized);
      const css = api.toCssVariables(normalized);
      return { settings: normalized, tokens, css, verified: !!tokens && typeof css === 'string' };
    }, command.args.settings || null);
  } else if (command.action === 'design_system_import_json') {
    stage = 'design_system_import_json';
    result = await page.evaluate(async json => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const endpoint = '/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/design-system';
      const headers = { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken };
      const current = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ action: 'read' }) });
      const state = await current.json().catch(() => ({}));
      if (!current.ok || state.ok !== true) throw new Error('Could not read the current design-system revision.');
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ action: 'import', json, baseRevision: state.revision })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error('Headless design-system import failed (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
      return { imported: true, revision: data.revision, settings: data.settings || null };
    }, command.args.json);
  } else if (command.action === 'design_system_export_json') {
    stage = 'design_system_export_json';
    result = await page.evaluate(async () => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/design-system', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action: 'export' })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error('Headless design-system export failed (HTTP ' + response.status + ').');
      const json = JSON.stringify(data.json, null, 2);
      return { exported: true, format: data.json?.format, version: data.json?.version, revision: data.revision, length: json.length, json, css: data.css };
    });
   } else if (command.action === 'design_export') {
    stage = 'design_export';
    result = await page.evaluate(async ({ projectId, format }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const action = format === 'svg' ? 'design.export.svg' : 'design.export.json';
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action, args: { projectId } })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || 'Saved design export failed.');
      const content = format === 'svg' ? data.result.svg : JSON.stringify(data.result, null, 2);
      const max = 7000;
      return {
        projectId, format, mimeType: format === 'svg' ? 'image/svg+xml' : 'application/json',
        length: content.length, content: content.slice(0, max), truncated: content.length > max,
        workspaceRevision: data.revision, readOnly: true
      };
    }, { projectId: command.args.project_id, format: command.args.format });
  } else if (command.action === 'design_capture_png') {
    stage = 'design_capture_png';
    const captureScale = command.args.scale === undefined ? 2 : command.args.scale;
    if (!Number.isInteger(captureScale) || captureScale < 1 || captureScale > 4) {
      throw new Error('design_capture_png scale must be an integer from 1 to 4.');
    }
    const captureData = await page.evaluate(async ({ projectId, scale }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args, expectedRevision) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args, ...(expectedRevision === undefined ? {} : { expectedRevision }) })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) {
          throw new Error('Design capture query failed (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
        }
        return data;
      };
      const captured = await query('design.capture.context', { projectId, scale });
      const workspaceRevision = captured.revision;
      const [htmlResponse, designResponse] = await Promise.all([
        query('design.export.html', { projectId }, workspaceRevision),
        query('design.read', { projectId, limit: 500 }, workspaceRevision)
      ]);
      const context = captured.result;
      if (!Number.isInteger(context?.designRevision) || context.designRevision !== designResponse.result.revision) {
        throw new Error('Capture context and saved design layers do not share the same design revision.');
      }
      const html = htmlResponse.result?.html;
      if (typeof html !== 'string' || !html.trim()) throw new Error('Saved design HTML export is empty.');
      const canvas = context?.canvas;
      if (!canvas || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) ||
          !Number.isInteger(canvas.pixelWidth) || !Number.isInteger(canvas.pixelHeight) ||
          canvas.pixelWidth * canvas.pixelHeight > 32000000) {
        throw new Error('Capture context returned invalid or oversized image dimensions.');
      }
      return { html, context, workspaceRevision, designRevision: designResponse.result.revision };
    }, { projectId: command.args.project_id, scale: captureScale });
    const canvas = captureData.context.canvas;
    const captureContext = await browser.newContext({
      viewport: { width: canvas.width, height: canvas.height },
      deviceScaleFactor: captureScale,
      serviceWorkers: 'block'
    });
    try {
      const capturePage = await captureContext.newPage();
      await capturePage.route('**/*', route => {
        const url = route.request().url();
        if (/^(data|blob|about):/i.test(url)) return route.continue();
        return route.abort();
      });
      await capturePage.setContent(captureData.html, { waitUntil: 'load', timeout: 15000 });
      await capturePage.evaluate(() => document.fonts?.ready || Promise.resolve());
      const screenshotPath = '.codelab-artifacts/design-capture.png';
      const contextPath = '.codelab-artifacts/design-capture.json';
      await fs.mkdir('.codelab-artifacts', { recursive: true });
      await capturePage.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled', timeout: 20000 });
      const manifest = {
        format: 'codelab-ai-design-capture-pair',
        version: 1,
        projectId: command.args.project_id,
        workspaceRevision: captureData.workspaceRevision,
        designRevision: captureData.designRevision,
        capturedAt: new Date().toISOString(),
        image: 'design-capture.png',
        imageMimeType: 'image/png',
        imagePixelWidth: canvas.pixelWidth,
        imagePixelHeight: canvas.pixelHeight,
        scale: captureScale,
        context: captureData.context
      };
      await fs.writeFile(contextPath, JSON.stringify(manifest, null, 2), 'utf8');
      result = {
        projectId: command.args.project_id,
        workspaceRevision: captureData.workspaceRevision,
        designRevision: captureData.designRevision,
        imagePath: screenshotPath,
        contextPath,
        imageMimeType: 'image/png',
        imagePixelWidth: canvas.pixelWidth,
        imagePixelHeight: canvas.pixelHeight,
        scale: captureScale,
        pairedRevisionVerified: true,
        networkRequestsBlocked: true
      };
    } finally {
      await captureContext.close();
    }
  } else if (command.action === 'design_import_json') {
    stage = 'design_import_json';
    result = await page.evaluate(async json => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          baseRevision: workspaceRevision,
          operationId: 'import_' + crypto.randomUUID().replace(/-/g, ''),
          operations: [{ type: 'design.import.json', json }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error('Headless design import failed (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
      return { imported: true, projectId: data.results?.[0]?.projectId, name: data.results?.[0]?.name, elementCount: data.results?.[0]?.elementCount || 0, revision: data.revision };
    }, command.args.json);
    await refreshWorkspaceFromServer();
  } else if (command.action === 'project_export_html') {
    stage = 'project_export_html';
    result = await page.evaluate(async ({ projectId, maxChars }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action: 'project.code.read', args: { projectId, source: 'main', languages: ['html', 'css', 'js'], maxChars: 200000 } })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error('Headless project read failed (HTTP ' + response.status + ').');
      const fields = data.result.fields;
      if (Object.values(fields).some(field => field.truncated)) throw new Error('Project code is too large to export in one response; read smaller sections first.');
      const content = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
        String(fields.css.value || '') + '</style></head><body>' + String(fields.html.value || '') + '<script>' +
        String(fields.js.value || '').replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
      const limit = maxChars || 7000;
      return { projectId, mimeType: 'text/html', length: content.length, content: content.slice(0, limit), truncated: content.length > limit, revision: data.revision };
    }, { projectId: command.args.project_id, maxChars: command.args.max_chars || 7000 });
  } else if (command.action === 'project_convert_design_to_web') {
    stage = 'project_convert_design_to_web';
    result = await page.evaluate(async projectId => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          baseRevision: workspaceRevision,
          operationId: 'convert_' + crypto.randomUUID().replace(/-/g, ''),
          operations: [{ type: 'design.convert.toWeb', projectId }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error('Headless design conversion failed (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
      return { convertedInPlace: true, projectId, revision: data.revision, result: data.results?.[0] || null, designPreserved: data.results?.[0]?.designPreserved === true };
    }, command.args.project_id);
    await refreshWorkspaceFromServer();
  } else if (command.action === 'headless_ai_generate') {
    stage = 'headless_ai_generate';
    result = await page.evaluate(async ({ projectId, source, prompt, baseRevision, operationId, maxTokens }) => {
      if (typeof workspaceId !== 'string' || !workspaceId || typeof workspaceToken !== 'string' || !workspaceToken) {
        throw new Error('Authenticated workspace credentials are not available in the app session.');
      }
      const endpoint = '/api/workspace/' + encodeURIComponent(workspaceId);
      const postHeadless = async (path, body) => {
        const response = await fetch(endpoint + path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify(body)
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 409) {
          const error = new Error(data.error === 'revision_conflict'
            ? 'Workspace changed while the AI was preparing code. The provider request may have consumed quota, but no code was saved; refresh and rebase before trying again.'
            : 'Headless AI request conflict (HTTP 409): ' + (data.error || 'conflict'));
          error.status = 409;
          error.data = data;
          throw error;
        }
        if (!response.ok || data.ok !== true) {
          throw new Error('Headless API failed (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
        }
        return data;
      };
      const settings = aiSettings && typeof aiSettings === 'object' ? aiSettings : {};
      const serverSettings = serverAi && typeof serverAi === 'object' ? serverAi : {};
      const keyDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
        serverSettings.serverKey ? 'server-configured' : String(settings.apiKey || '')
      ));
      const keyFingerprint = Array.from(new Uint8Array(keyDigest)).map(value => value.toString(16).padStart(2, '0')).join('');
      const providerConfig = {
        projectId, source, prompt, baseRevision,
        mode: settings.mode || 'auto',
        model: settings.model || 'gpt-4o-mini',
        baseUrl: serverSettings.serverKey ? 'server-configured' : (settings.baseUrl || ''),
        keyFingerprint,
        serverKey: !!serverSettings.serverKey,
        maxTokens: maxTokens === undefined ? null : maxTokens
      };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(providerConfig)));
      const requestKey = Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');

      const status = await postHeadless('/headless/query', {
        action: 'headless.operation.status',
        args: { operationId, requestKey }
      });
      if (status.result.found) {
        const readback = await postHeadless('/headless/query', {
          action: 'project.code.read',
          args: { projectId, source, languages: ['html', 'css', 'js'], maxChars: 200000 }
        });
        return {
          operationId, replayed: true, revision: status.result.revision,
          currentRevision: readback.revision, previousResults: status.result.results,
          readbackAvailable: Object.values(readback.result.fields).every(field => !field.truncated)
        };
      }

      const current = await postHeadless('/headless/query', {
        action: 'project.code.read',
        args: { projectId, source, languages: ['html', 'css', 'js'], maxChars: 500000 },
        expectedRevision: baseRevision
      });
      const code = {};
      for (const key of ['html', 'css', 'js']) {
        const field = current.result.fields[key];
        if (!field || field.truncated) throw new Error('Project ' + key.toUpperCase() + ' exceeds the 200000-character AI input limit. Split the task before generation; no provider call was made.');
        code[key] = field.value;
      }
      if (code.html.length + code.css.length + code.js.length > 200000) {
        throw new Error('Combined project code exceeds the 200000-character AI input limit. Split the task before generation; no provider call was made.');
      }

      if (!serverSettings.serverKey && !settings.apiKey) throw new Error('No AI provider key is configured for this user, and no server key is available. No provider request was made.');
      const payload = { prompt, code };
      if (serverSettings.serverKey) {
        if (settings.model && settings.model !== 'gpt-4o-mini') payload.model = settings.model;
      } else {
        payload.model = settings.model || 'gpt-4o-mini';
        if (settings.baseUrl) payload.baseUrl = settings.baseUrl;
        if (settings.apiKey) payload.apiKey = settings.apiKey;
      }
      if (maxTokens !== undefined) payload.maxTokens = maxTokens;
      const aiResponse = await fetch('/api/ai/complete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const aiData = await aiResponse.json().catch(() => ({}));
      if (!aiResponse.ok) {
        if (aiResponse.status === 429) {
          const wait = aiData.retryAfterSeconds || (aiData.retryAfter ? Number(aiData.retryAfter) : 60);
          throw new Error('AI rate limit reached (' + (aiData.rateLimitScope || 'provider/server') + '). Wait approximately ' + wait + ' seconds. No project code was changed.');
        }
        throw new Error('AI generation failed (' + aiResponse.status + '): ' + (aiData.message || aiData.error || 'provider error') +
          (aiData.rateLimit ? ' | provider rate-limit data: ' + JSON.stringify(aiData.rateLimit) : ''));
      }

      const generated = {
        html: typeof aiData.html === 'string' ? aiData.html : code.html,
        css: typeof aiData.css === 'string' ? aiData.css : code.css,
        js: typeof aiData.js === 'string' ? aiData.js : code.js
      };
      for (const key of ['html', 'css', 'js']) {
        if (generated[key].length > 500000) throw new Error('Generated ' + key.toUpperCase() + ' exceeds the 500000-character project limit; no code was saved.');
      }
      const changedFields = ['html', 'css', 'js'].filter(key => generated[key] !== code[key]);
      if (!changedFields.length) {
        return {
          operationId, noChanges: true, model: aiData.model, via: aiData.via,
          usage: aiData.usage || null, rateLimit: aiData.rateLimit || null,
          message: aiData.message || 'The provider returned no code changes.'
        };
      }

      const operations = [];
      let requestKeyAttached = false;
      for (const key of changedFields) {
        const value = generated[key];
        // Size the chunk count from the actual generated field length. The shared
        // runtime accepts larger bounded chunks, so avoid unnecessary 50k writes.
        const chunks = splitCodeChunks(value, MAX_CODE_CHUNK_CHARS);
        chunks.forEach((chunk, index) => {
          const operation = { type: 'web.code.write', projectId, source, mode: index === 0 ? 'replace' : 'append' };
          operation[key] = chunk;
          if (!requestKeyAttached) {
            operation.headlessAiRequestKey = requestKey;
            requestKeyAttached = true;
          }
          operations.push(operation);
        });
      }
      if (operations.length > 100) throw new Error('Generated code requires more than 100 safe chunks; split the task before saving.');
      const saved = await postHeadless('/headless', { baseRevision, operationId, operations });
      const readback = await postHeadless('/headless/query', {
        action: 'project.code.read',
        args: { projectId, source, languages: ['html', 'css', 'js'], maxChars: 200000 },
        expectedRevision: saved.revision
      });
      const readbackVerified = changedFields.every(key =>
        readback.result.fields[key] && !readback.result.fields[key].truncated &&
        readback.result.fields[key].value === generated[key]
      );
      if (!readbackVerified) throw new Error('AI code was saved, but server readback did not match the generated output.');
      return {
        operationId, replayed: !!saved.replayed, revision: saved.revision,
        changedFields, message: aiData.message || 'AI changes saved.',
        model: aiData.model, via: aiData.via,
        usage: aiData.usage || null, rateLimit: aiData.rateLimit || null,
        readbackVerified
      };
    }, {
      projectId: command.args.project_id,
      source: command.args.source || 'main',
      prompt: command.args.prompt,
      baseRevision: command.args.base_revision,
      operationId: command.args.operation_id,
      maxTokens: command.args.max_tokens
    });
  } else if (command.action === 'ai_generate') {
    stage = 'ai_generate';
    result = await page.evaluate(async ({ projectId, source, prompt }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (project.type === 'design') throw new Error('AI code generation requires a web project.');
      if (source === 'branch' && !project.branch) throw new Error('Project has no saved copy branch.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (source === 'branch' && !inCopyBranch) await toggleCopyBranch();
      if (source === 'main' && inCopyBranch) await toggleCopyBranch();
      const before = { html: getEditorValue('html'), css: getEditorValue('css'), js: getEditorValue('js') };
      const input = document.getElementById('aiPromptInput');
      if (!input) throw new Error('AI prompt input is unavailable.');
      input.value = prompt;
      await processAiInstruction();
      const after = { html: getEditorValue('html'), css: getEditorValue('css'), js: getEditorValue('js') };
      const changedFields = ['html', 'css', 'js'].filter(key => before[key] !== after[key]);
      const latest = projects.find(item => item && item.id === projectId);
      const persisted = source === 'branch' ? latest?.branch?.code : latest?.code;
      const persistedMatches = !!persisted && ['html', 'css', 'js'].every(key => persisted[key] === after[key]);
      let localSnapshotVerified = false;
      try {
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
        const localCode = source === 'branch' ? localProject?.branch?.code : localProject?.code;
        localSnapshotVerified = !!localCode && ['html', 'css', 'js'].every(key => localCode[key] === after[key]);
      } catch (_) {}
      return { projectId, source, changedFields, changed: changedFields.length > 0, persistedMatches, localSnapshotVerified, codeLengths: { html: after.html.length, css: after.css.length, js: after.js.length } };
    }, { projectId: command.args.project_id, source: command.args.source || 'main', prompt: command.args.prompt });
  } else if (command.action === 'design_flow_read') {
    stage = 'design_flow_read';
    result = await page.evaluate(async projectId => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.error || 'Saved design flow query failed.');
        return data;
      };
      const saved = await query('design.read', { projectId, limit: 500 });
      const design = saved.result;
      const elements = Array.isArray(design.elements) ? design.elements : [];
      const connections = Array.isArray(design.flowConnections) ? design.flowConnections : [];
      const targets = await Promise.all([...new Set(connections.map(item => item.targetProjectId).filter(Boolean))]
        .map(async targetProjectId => {
          try { const response = await query('project.inspect', { projectId: targetProjectId }); return [targetProjectId, response.result]; }
          catch { return [targetProjectId, null]; }
        }));
      const targetMap = new Map(targets);
      return {
        projectId, connections: connections.map(connection => ({
          sourceElementId: connection.sourceElementId,
          sourceLabel: elements.find(element => element.id === connection.sourceElementId)?.label || null,
          targetProjectId: connection.targetProjectId,
          targetProjectName: targetMap.get(connection.targetProjectId)?.name || null,
          broken: !elements.some(element => element.id === connection.sourceElementId) || !targetMap.get(connection.targetProjectId)
        })),
        count: connections.length, workspaceRevision: saved.revision, readOnly: true
      };
    }, command.args.project_id);
  } else if (command.action === 'design_flow_connect') {
    stage = 'design_flow_connect';
    result = await page.evaluate(async ({projectId,elementId,targetProjectId}) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action,args) => {
        const response=await fetch('/api/workspace/'+encodeURIComponent(workspaceId)+'/headless/query',{
          method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','x-workspace-token':workspaceToken},
          body:JSON.stringify({action,args})
        });
        const data=await response.json().catch(()=>({}));
        if(!response.ok||data.ok!==true)throw new Error(data.detail||data.error||'Saved design query failed.');
        return data;
      };
      const before=await query('design.read',{projectId,limit:500});
      if(!before.result.elements.some(item=>item.id===elementId))throw new Error('Source design element not found.');
      if((before.result.flowConnections||[]).some(item=>item.sourceElementId===elementId&&item.targetProjectId===targetProjectId))
        return {projectId,elementId,targetProjectId,alreadyConnected:true,serverReadbackVerified:true,workspaceRevision:before.revision};
      const response=await fetch('/api/workspace/'+encodeURIComponent(workspaceId)+'/headless',{
        method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','x-workspace-token':workspaceToken},
        body:JSON.stringify({baseRevision:before.revision,operationId:'flow_connect_'+crypto.randomUUID().replace(/-/g,''),operations:[{type:'design.flow.connect',sourceProjectId:projectId,sourceElementId:elementId,targetProjectId}]})
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok||data.ok!==true)throw new Error(data.detail||data.error||'Headless flow connection failed.');
      const after=await query('design.read',{projectId,limit:500});
      const verified=(after.result.flowConnections||[]).some(item=>item.sourceElementId===elementId&&item.targetProjectId===targetProjectId);
      if(!verified)throw new Error('Flow connection failed authoritative server readback.');
      return {projectId,elementId,targetProjectId,alreadyConnected:false,saved:true,serverReadbackVerified:true,workspaceRevision:after.revision,designRevision:after.result.revision};
    },{projectId:command.args.project_id,elementId:command.args.element_id,targetProjectId:command.args.target_project_id});
  } else if (command.action === 'design_flow_disconnect') {
    stage = 'design_flow_disconnect';
    result = await page.evaluate(async ({projectId,elementId,targetProjectId}) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action,args) => {
        const response=await fetch('/api/workspace/'+encodeURIComponent(workspaceId)+'/headless/query',{
          method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','x-workspace-token':workspaceToken},
          body:JSON.stringify({action,args})
        });
        const data=await response.json().catch(()=>({}));
        if(!response.ok||data.ok!==true)throw new Error(data.detail||data.error||'Saved design query failed.');
        return data;
      };
      const before=await query('design.read',{projectId,limit:500});
      const existing=before.result.flowConnections||[];
      const matched=existing.filter(item=>item.sourceElementId===elementId&&(!targetProjectId||item.targetProjectId===targetProjectId));
      if(!matched.length)return {projectId,elementId,targetProjectId:targetProjectId||null,removed:false,alreadyDisconnected:true,serverReadbackVerified:true,workspaceRevision:before.revision};
      const response=await fetch('/api/workspace/'+encodeURIComponent(workspaceId)+'/headless',{
        method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','x-workspace-token':workspaceToken},
        body:JSON.stringify({baseRevision:before.revision,operationId:'flow_disconnect_'+crypto.randomUUID().replace(/-/g,''),operations:[{type:'design.flow.disconnect',sourceProjectId:projectId,sourceElementId:elementId,...(targetProjectId?{targetProjectId}:{})}]})
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok||data.ok!==true)throw new Error(data.detail||data.error||'Headless flow disconnection failed.');
      const after=await query('design.read',{projectId,limit:500});
      const stillConnected=(after.result.flowConnections||[]).some(item=>item.sourceElementId===elementId&&(!targetProjectId||item.targetProjectId===targetProjectId));
      if(stillConnected)throw new Error('Flow disconnection failed authoritative server readback.');
      return {projectId,elementId,targetProjectId:targetProjectId||null,removed:true,saved:true,serverReadbackVerified:true,workspaceRevision:after.revision,designRevision:after.result.revision};
    },{projectId:command.args.project_id,elementId:command.args.element_id,targetProjectId:command.args.target_project_id});
  } else if (command.action === 'project_delete') {
    stage = 'project_delete';
    result = await page.evaluate(async ({ projectId, approved }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved workspace query failed.');
        return data;
      };
      const before = await query('project.inspect', { projectId });
      const operationId = 'delete_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          baseRevision: before.revision, operationId,
          operations: [{ type: 'project.delete', projectId, approved }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless project deletion failed.');
      const after = await query('project.list');
      const deleted = !after.result.projects.some(project => project.id === projectId);
      if (!deleted) throw new Error('Deleted project still appears in authoritative server readback.');
      let workspaceRefreshed = false;
      try { workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false; } catch (_) {}
      return {
        projectId, deleted, serverReadbackVerified: deleted, workspaceRefreshed,
        workspaceRevision: after.revision, previousType: before.result.type, saved: true
      };
    }, { projectId: command.args.project_id, approved: command.approval === 'approved' });
  } else if (command.action === 'design_template_apply') {
    stage = 'design_template_apply';
    result = await page.evaluate(async ({ projectId, templateId, replaceExisting, approved }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.error || 'Saved design template query failed.');
        return data;
      };
      const before = await query('design.read', { projectId, limit: 500 });
      if (before.result.elementCount > 0 && !replaceExisting) {
        throw new Error('Design already has layers; set replace_existing=true and approval=approved to replace them.');
      }
      const operationId = 'template_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          baseRevision: before.revision, operationId,
          operations: [{ type: 'design.template.apply', projectId, templateId, replaceExisting, approved }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless template application failed.');
      const after = await query('design.read', { projectId, limit: 500 });
      const verified = after.result.elementCount > 0 && after.result.revision > before.result.revision;
      if (!verified) throw new Error('Saved template could not be verified from the server.');
      const workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false;
      return {
        projectId, templateId, elementCount: after.result.elementCount, saved: true,
        verified, workspaceRefreshed, workspaceRevision: after.revision, designRevision: after.result.revision
      };
    }, {
      projectId: command.args.project_id, templateId: command.args.template_id,
      replaceExisting: command.args.replace_existing === true,
      approved: command.approval === 'approved'
    });
  } else if (command.action === 'design_history') {
    stage = 'design_history';
    result = await page.evaluate(async ({ projectId, operation }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved design history query failed.');
        return data;
      };
      const before = await query('design.history.inspect', { projectId });
      if (operation === 'undo' ? !before.result.canUndo : !before.result.canRedo) {
        throw new Error('No saved design ' + operation + ' entry is available.');
      }
      const operationId = 'history_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          baseRevision: before.revision, operationId,
          operations: [{ type: operation === 'undo' ? 'design.history.undo' : 'design.history.redo', projectId }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless design history operation failed.');
      const after = await query('design.read', { projectId, limit: 500 });
      const history = await query('design.history.inspect', { projectId });
      const workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false;
      return {
        projectId, operation, changed: true, saved: true, verified: after.result.revision > 0,
        elementCount: after.result.elementCount, designRevision: after.result.revision,
        canUndo: history.result.canUndo, canRedo: history.result.canRedo,
        workspaceRevision: after.revision, workspaceRefreshed
      };
    }, { projectId: command.args.project_id, operation: command.args.operation });
  } else if (command.action === 'pixelforge_headless_inspect') {
    stage = 'pixelforge_headless_inspect';
    result = await page.evaluate(async projectId => {
      const response = await fetch('/api/pixelforge/projects/' + encodeURIComponent(projectId), {
        method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.project) throw new Error('PixelForge project read failed (HTTP ' + response.status + '): ' + (data.error || 'unknown error'));
      const { HeadlessEditorRuntime } = await import('/pixelforge/src/headless.js');
      return HeadlessEditorRuntime.fromJSON(data.project).inspect();
    }, command.args.project_id);
  } else if (command.action === 'pixelforge_headless_batch') {
    stage = 'pixelforge_headless_batch';
    result = await page.evaluate(async ({ projectId, actions, summary }) => {
      const { preparePixelForgeProposal, acceptPixelForgeProposal } = await import('/pixelforge/src/headless-bridge.js');
      const prepared = await preparePixelForgeProposal({ projectId, actions, summary });
      if (prepared.status !== 'proposal') return prepared;
      const saved = await acceptPixelForgeProposal({ sessionId: prepared.sessionId, approved: true });
      return {
        status: saved.status,
        projectId: saved.projectId,
        serverRevision: saved.serverRevision,
        result: saved.result,
        inspection: saved.inspection,
        actions: prepared.results,
        changedPixels: prepared.diff?.changedPixels ?? 0,
        proposalSummary: prepared.proposal?.summary ?? summary,
      };
    }, {
      projectId: command.args.project_id,
      actions: command.args.actions,
      summary: command.args.summary,
    });
  } else if (command.action === 'pixelforge_headless_export_animation') {
    stage = 'pixelforge_headless_export_animation';
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 })
      .then(download => ({ download }), error => ({ error }));
    const exportInfo = await page.evaluate(async ({ projectId, columns, padding }) => {
      const response = await fetch('/api/pixelforge/projects/' + encodeURIComponent(projectId), {
        method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.project) {
        throw new Error('PixelForge animation export could not read project (HTTP ' + response.status + '): ' + (data.error || 'unknown error'));
      }
      const { HeadlessEditorRuntime } = await import('/pixelforge/src/headless.js');
      const { exportAnimationSpriteSheet } = await import('/pixelforge/src/animation.js');
      const runtime = HeadlessEditorRuntime.fromJSON(data.project);
      const project = runtime.toJSON();
      if (!project.animation || !Array.isArray(project.animation.frames) || !project.animation.frames.length) {
        throw new Error('PixelForge project has no animation frames to export.');
      }
      const options = {};
      if (columns !== undefined) options.columns = columns;
      if (padding !== undefined) options.padding = padding;
      const exported = await exportAnimationSpriteSheet(project.animation, project.width, project.height, options);
      const objectUrl = URL.createObjectURL(exported.blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'pixelforge-animation-spritesheet.png';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return { manifest: exported.manifest, filename: anchor.download };
    }, {
      projectId: command.args.project_id,
      columns: command.args.columns,
      padding: command.args.padding,
    });
    const downloadResult = await downloadPromise;
    if (downloadResult.error) throw new Error('PixelForge sprite sheet download did not start: ' + String(downloadResult.error.message || downloadResult.error));
    await fs.mkdir('.codelab-artifacts', { recursive: true });
    const spriteSheetPath = '.codelab-artifacts/pixelforge-animation-spritesheet.png';
    const manifestPath = '.codelab-artifacts/pixelforge-animation-manifest.json';
    await downloadResult.download.saveAs(spriteSheetPath);
    const manifest = {
      ...exportInfo.manifest,
      exportedAt: new Date().toISOString(),
      imageFile: 'pixelforge-animation-spritesheet.png',
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    result = {
      status: 'exported',
      projectId: command.args.project_id,
      frameCount: manifest.frameCount,
      fps: manifest.fps,
      loop: manifest.loop,
      sheet: manifest.sheet,
      frameSize: manifest.frameSize,
      files: { spriteSheet: spriteSheetPath, manifest: manifestPath },
      artifactName: 'pixelforge-animation-' + process.env.GITHUB_RUN_ID,
      artifactRunUrl: 'https://github.com/' + repo + '/actions/runs/' + process.env.GITHUB_RUN_ID,
      projectPersisted: false,
    };
  } else if (command.action === 'pixelforge_headless_export_png') {
    stage = 'pixelforge_headless_export_png';
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).then(download => ({ download }), error => ({ error }));
    const exportInfo = await page.evaluate(async projectId => {
      const response = await fetch('/api/pixelforge/projects/' + encodeURIComponent(projectId), { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.project) throw new Error('PixelForge PNG export could not read project (HTTP ' + response.status + '): ' + (data.error || 'unknown error'));
      const { HeadlessEditorRuntime } = await import('/pixelforge/src/headless.js');
      const runtime = HeadlessEditorRuntime.fromJSON(data.project);
      const doc = runtime.document;
      const canvas = document.createElement('canvas'); canvas.width = doc.width; canvas.height = doc.height;
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('Could not create the PixelForge PNG export surface.');
      context.putImageData(new ImageData(new Uint8ClampedArray(doc.composite()), doc.width, doc.height), 0, 0);
      const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoder returned no data.')), 'image/png'));
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'pixelforge-composite.png'; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      return { filename: anchor.download, width: doc.width, height: doc.height, revision: doc.revision };
    }, command.args.project_id);
    const downloaded = await downloadPromise;
    if (downloaded.error) throw new Error('PixelForge PNG download did not start: ' + String(downloaded.error.message || downloaded.error));
    await fs.mkdir('.codelab-artifacts', { recursive: true });
    const filePath = '.codelab-artifacts/pixelforge-composite.png'; await downloaded.download.saveAs(filePath);
    result = { status: 'exported', projectId: command.args.project_id, width: exportInfo.width, height: exportInfo.height, revision: exportInfo.revision, file: filePath, artifactName: 'pixelforge-raster-' + process.env.GITHUB_RUN_ID, artifactRunUrl: 'https://github.com/' + repo + '/actions/runs/' + process.env.GITHUB_RUN_ID, projectPersisted: false };
  } else if (command.action === 'pixelforge_headless_export_project') {
    stage = 'pixelforge_headless_export_project';
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).then(download => ({ download }), error => ({ error }));
    const exportInfo = await page.evaluate(async projectId => {
      const response = await fetch('/api/pixelforge/projects/' + encodeURIComponent(projectId), { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.project) throw new Error('PixelForge project export could not read project (HTTP ' + response.status + '): ' + (data.error || 'unknown error'));
      const { HeadlessEditorRuntime } = await import('/pixelforge/src/headless.js');
      const runtime = HeadlessEditorRuntime.fromJSON(data.project); const project = runtime.toJSON();
      const json = JSON.stringify(project); const bytes = new TextEncoder().encode(json).byteLength;
      if (bytes > 96 * 1024 * 1024) throw new RangeError('PixelForge portable project exceeds the 96 MiB export limit.');
      const blob = new Blob([json], { type: 'application/json' }); const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'pixelforge-project.pforge';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      return { filename: anchor.download, bytes, revision: project.revision, width: project.width, height: project.height, layerCount: project.layers.length, frameCount: project.animation?.frames?.length ?? 0 };
    }, command.args.project_id);
    const downloaded = await downloadPromise;
    if (downloaded.error) throw new Error('PixelForge project download did not start: ' + String(downloaded.error.message || downloaded.error));
    await fs.mkdir('.codelab-artifacts', { recursive: true });
    const filePath = '.codelab-artifacts/pixelforge-project.pforge'; await downloaded.download.saveAs(filePath);
    result = { status: 'exported', projectId: command.args.project_id, ...exportInfo, file: filePath, artifactName: 'pixelforge-raster-' + process.env.GITHUB_RUN_ID, artifactRunUrl: 'https://github.com/' + repo + '/actions/runs/' + process.env.GITHUB_RUN_ID, projectPersisted: false };
  } else if (command.action === 'pixelforge_headless_export_layers') {
    stage = 'pixelforge_headless_export_layers';
    const pngPromise = page.waitForEvent('download', { timeout: 30000 }).then(download => ({ download }), error => ({ error }));
    const manifestPromise = page.waitForEvent('download', { timeout: 30000 }).then(download => ({ download }), error => ({ error }));
    const exportInfo = await page.evaluate(async ({ projectId, columns, padding }) => {
      const response = await fetch('/api/pixelforge/projects/' + encodeURIComponent(projectId), { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.project) throw new Error('PixelForge layer export could not read project (HTTP ' + response.status + '): ' + (data.error || 'unknown error'));
      const { HeadlessEditorRuntime } = await import('/pixelforge/src/headless.js');
      const { createSpriteSheetLayout } = await import('/pixelforge/src/asset-export.js');
      const runtime = HeadlessEditorRuntime.fromJSON(data.project); const doc = runtime.document;
      const options = {}; if (columns !== undefined) options.columns = columns; if (padding !== undefined) options.padding = padding;
      const layout = createSpriteSheetLayout(doc.layers.length, doc.width, doc.height, options);
      const sheet = document.createElement('canvas'); sheet.width = layout.width; sheet.height = layout.height;
      const context = sheet.getContext('2d', { alpha: true }); if (!context) throw new Error('Could not create the PixelForge layer sprite sheet surface.');
      context.clearRect(0, 0, sheet.width, sheet.height);
      const frames = layout.frames.map((frame, index) => {
        const layer = doc.layers[index]; context.putImageData(new ImageData(new Uint8ClampedArray(layer.pixels), doc.width, doc.height), frame.x, frame.y);
        return { ...frame, name: layer.name, visible: layer.visible, opacity: layer.opacity, locked: layer.locked };
      });
      const manifest = { format: 'pixelforge-sprite-sheet', version: 1, document: doc.name, sheet: { width: layout.width, height: layout.height, columns: layout.columns, rows: layout.rows, padding: layout.padding }, frameSize: { width: doc.width, height: doc.height }, pivot: 'center', frames };
      const png = await new Promise((resolve, reject) => sheet.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoder returned no data.')), 'image/png'));
      const pngUrl = URL.createObjectURL(png); const pngAnchor = document.createElement('a'); pngAnchor.href = pngUrl; pngAnchor.download = 'pixelforge-layer-spritesheet.png'; document.body.appendChild(pngAnchor); pngAnchor.click(); pngAnchor.remove();
      const jsonUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
      const jsonAnchor = document.createElement('a'); jsonAnchor.href = jsonUrl; jsonAnchor.download = 'pixelforge-layer-spritesheet.json'; document.body.appendChild(jsonAnchor); jsonAnchor.click(); jsonAnchor.remove();
      return { manifest, pngFilename: pngAnchor.download, manifestFilename: jsonAnchor.download, revision: doc.revision };
    }, { projectId: command.args.project_id, columns: command.args.columns, padding: command.args.padding });
    const [pngDownload, manifestDownload] = await Promise.all([pngPromise, manifestPromise]);
    if (pngDownload.error || manifestDownload.error) throw new Error('PixelForge layer sprite sheet files did not both download successfully.');
    await fs.mkdir('.codelab-artifacts', { recursive: true });
    const pngPath = '.codelab-artifacts/pixelforge-layer-spritesheet.png'; const manifestPath = '.codelab-artifacts/pixelforge-layer-spritesheet.json';
    await Promise.all([pngDownload.download.saveAs(pngPath), manifestDownload.download.saveAs(manifestPath)]);
    result = { status: 'exported', projectId: command.args.project_id, revision: exportInfo.revision, frameCount: exportInfo.manifest.frameCount, sheet: exportInfo.manifest.sheet, files: { spriteSheet: pngPath, manifest: manifestPath }, artifactName: 'pixelforge-raster-' + process.env.GITHUB_RUN_ID, artifactRunUrl: 'https://github.com/' + repo + '/actions/runs/' + process.env.GITHUB_RUN_ID, projectPersisted: false };
  } else if (command.action === 'headless_batch') {
    stage = 'headless_batch';
    result = await page.evaluate(async ({ baseRevision, operationId, operations }) => {
      if (typeof workspaceId !== 'string' || !workspaceId || typeof workspaceToken !== 'string' || !workspaceToken) {
        throw new Error('Authenticated workspace credentials are not available in the app session.');
      }
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ baseRevision, operationId, operations })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        throw new Error('Headless revision conflict (HTTP 409). Read the latest workspace and design revisions, rebase the batch, and retry with a new operation_id. Keep the same operation_id only for an exact retry.');
      }
      if (!response.ok || data.ok !== true) {
        throw new Error('Headless workspace request failed (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
      }
      if (typeof refreshWorkspaceFromServer !== 'function' || !(await refreshWorkspaceFromServer())) {
        throw new Error('Headless operation was accepted, but the web app could not read the saved workspace back.');
      }
      const createdId = data.results.map(item => item.projectId).find(Boolean);
      const requestedId = [...operations].reverse().map(item => item.projectId || item.sourceProjectId).find(Boolean);
      const visibleProjectId = createdId || requestedId || null;
      if (visibleProjectId && projects.some(item => item && item.id === visibleProjectId) && typeof openProject === 'function') {
        await openProject(visibleProjectId);
        await new Promise(resolve => setTimeout(resolve, 900));
      }
      return {
        revision: data.revision,
        replayed: data.replayed === true,
        operationCount: operations.length,
        results: data.results.map(item => {
          const copy = { ...item };
          if (typeof copy.previewSvg === 'string') {
            copy.previewSvgLength = copy.previewSvg.length;
            delete copy.previewSvg;
          }
          return copy;
        }),
        serverReadbackVerified: true,
        openedProjectId: visibleProjectId
      };
    }, {
      baseRevision: command.args.base_revision,
      operationId: command.args.operation_id,
      operations: command.args.operations
    });
  } else if (command.action === 'headless_design_system') {
    stage = 'headless_design_system';
    result = await page.evaluate(async ({ operation, baseRevision, settings, json }) => {
      if (typeof workspaceId !== 'string' || !workspaceId || typeof workspaceToken !== 'string' || !workspaceToken) {
        throw new Error('Authenticated workspace credentials are not available in the app session.');
      }
      const endpoint = '/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/design-system';
      const call = async body => {
        const response = await fetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify(body)
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 409) {
          throw new Error('Workspace design-system revision conflict (HTTP 409). Read the latest settings and retry against its current revision.');
        }
        if (!response.ok || data.ok !== true) {
          throw new Error('Headless design-system request failed (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
        }
        return data;
      };
      const data = await call({ action: operation, baseRevision, settings, json });
      if (operation === 'write' || operation === 'import') {
        const readback = await call({ action: 'read' });
        const readbackVerified = JSON.stringify(readback.settings) === JSON.stringify(data.settings) &&
          readback.revision === data.revision;
        if (!readbackVerified) throw new Error('Design-system save was acknowledged but server readback did not match.');
        return { operation, revision: data.revision, updatedAt: data.updatedAt, settings: readback.settings, readbackVerified };
      }
      return operation === 'read'
        ? { operation, revision: data.revision, updatedAt: data.updatedAt, settings: data.settings, readOnly: true }
        : { operation, revision: data.revision, updatedAt: data.updatedAt, json: data.json, css: data.css, readOnly: true };
    }, {
      operation: command.args.operation,
      baseRevision: command.args.base_revision,
      settings: command.args.settings,
      json: command.args.json
    });
  } else if (command.action === 'headless_query') {
    stage = 'headless_query';
    result = await page.evaluate(async ({ action, args, expectedRevision }) => {
      if (typeof workspaceId !== 'string' || !workspaceId || typeof workspaceToken !== 'string' || !workspaceToken) {
        throw new Error('Authenticated workspace credentials are not available in the app session.');
      }
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action, args, expectedRevision })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        throw new Error('Headless query revision conflict (HTTP 409). Refresh the workspace and repeat the read against the current revision.');
      }
      if (!response.ok || data.ok !== true) {
        throw new Error('Headless query failed (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
      }
      return { revision: data.revision, action: data.action, result: data.result, readOnly: true };
    }, {
      action: command.args.query_action,
      args: command.args.query_args || {},
      expectedRevision: command.args.expected_revision
    });
  } else if (command.action === 'project_create') {
    stage = 'project_create';
    result = await page.evaluate(async ({ name, type }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved workspace query failed.');
        return data;
      };
      const before = await query('project.list');
      const operationId = 'create_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          baseRevision: before.revision, operationId,
          operations: [{ type: 'project.create', name: name.trim(), projectType: type || 'web' }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless project creation failed.');
      const created = data.results?.[0];
      if (!created?.projectId) throw new Error('Headless project creation returned no project ID.');
      const saved = await query('project.inspect', { projectId: created.projectId });
      const serverReadbackVerified = saved.result.name === name.trim() && saved.result.type === (type || 'web');
      if (!serverReadbackVerified) throw new Error('Created project failed authoritative server readback.');
      let workspaceRefreshed = false;
      try { workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false; } catch (_) {}
      return {
        projectId: created.projectId, name: saved.result.name, type: saved.result.type,
        serverReadbackVerified, workspaceRefreshed, workspaceRevision: saved.revision, saved: true
      };
    }, { name: command.args.name, type: command.args.type || 'web' });
  } else if (command.action === 'project_duplicate') {
    stage = 'project_duplicate';
    result = await page.evaluate(async projectId => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved project query failed.');
        return data;
      };
      const before = await query('project.inspect', { projectId });
      const operationId = 'duplicate_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ baseRevision: before.revision, operationId, operations: [{ type: 'project.duplicate', projectId }] })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless project duplication failed.');
      const duplicate = data.results?.[0];
      if (!duplicate?.projectId) throw new Error('Headless duplication returned no project ID.');
      const [sourceAfter, duplicateAfter] = await Promise.all([
        query('project.inspect', { projectId }),
        query('project.inspect', { projectId: duplicate.projectId })
      ]);
      const sourceUnchanged = sourceAfter.result.id === before.result.id &&
        sourceAfter.result.type === before.result.type &&
        JSON.stringify(sourceAfter.result.codeLengths) === JSON.stringify(before.result.codeLengths) &&
        sourceAfter.result.design?.elementCount === before.result.design?.elementCount;
      const serverReadbackVerified = duplicateAfter.result.id === duplicate.projectId &&
        duplicateAfter.result.type === before.result.type && duplicateAfter.result.name === duplicate.name;
      if (!sourceUnchanged || !serverReadbackVerified) throw new Error('Duplication failed authoritative source/duplicate readback.');
      let workspaceRefreshed = false;
      try { workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false; } catch (_) {}
      return {
        sourceProjectId: projectId, projectId: duplicate.projectId, name: duplicateAfter.result.name,
        type: duplicateAfter.result.type, sourceUnchanged, serverReadbackVerified,
        workspaceRefreshed, workspaceRevision: duplicateAfter.revision, saved: true
      };
    }, command.args.project_id);
  } else if (command.action === 'workspace_inspect') {
    stage = 'workspace_inspect';
    result = await page.evaluate(async () => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action: 'project.list' })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || 'Saved workspace inspection failed.');
      return {
        initialized: Array.isArray(projects),
        projectCount: data.result.count,
        projects: data.result.projects,
        workspaceRevision: data.revision,
        currentProjectId: currentProjectId || null,
        currentProjectName: getCurrentProject()?.name || null,
        activeEditor: document.getElementById('studioView')?.classList.contains('hidden') ? 'dashboard' : (getCurrentProject()?.type === 'design' ? 'design' : 'web'),
        copyBranchActive: !!inCopyBranch,
        syncStatus: document.getElementById('statusText')?.textContent || null,
        authVisible: !document.getElementById('authContainer')?.classList.contains('hidden'),
        version: typeof APP_VERSION === 'string' ? APP_VERSION : null,
        readOnly: true
      };
    });
  } else if (command.action === 'project_inspect') {
    stage = 'project_inspect';
    result = await page.evaluate(async projectId => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action: 'project.inspect', args: { projectId } })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || 'Saved project inspection failed.');
      const saved = data.result;
      return {
        ...saved, hasWebSpace: saved.type === 'web',
        hasDesignSpace: saved.type === 'design' || !!saved.design,
        mergeUndoAvailable: saved.mergeHistoryCount > 0,
        revision: data.revision, readOnly: true
      };
    }, command.args.project_id);
  } else if (command.action === 'project_code_read') {
    stage = 'project_code_read';
    const source = command.args.source === 'branch' ? 'branch' : 'main';
    const offset = command.args.offset === undefined ? 0 : command.args.offset;
    const maxChars = command.args.max_chars === undefined ? 20000 : command.args.max_chars;
    if (!Number.isInteger(offset) || offset < 0 || offset > 500000) throw new Error('project_code_read offset must be an integer from 0 to 500000.');
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200000) throw new Error('project_code_read max_chars must be an integer from 1 to 200000.');
    result = await page.evaluate(async ({ projectId, source, offset, maxChars }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          action: 'project.code.read',
          args: { projectId, source, languages: ['html', 'css', 'js'], offset, maxChars }
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error('Headless project code read failed (HTTP ' + response.status + '): ' + (data.detail || data.error || 'unknown error'));
      const fields = data.result?.fields;
      if (!fields) throw new Error('Headless project code read returned no fields.');
      const clip = field => ({
        content: field.value,
        length: field.originalLength,
        offset: field.offset,
        nextOffset: field.nextOffset,
        truncated: field.truncated
      });
      return { projectId, source, revision: data.revision, offset, maxChars, html: clip(fields.html), css: clip(fields.css), js: clip(fields.js), readOnly: true };
    }, { projectId: command.args.project_id, source, offset, maxChars });
  } else if (command.action === 'design_read') {
    stage = 'design_read';
    result = await page.evaluate(async projectId => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action: 'design.read', args: { projectId, limit: 200 } })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || 'Saved design inspection failed.');
      const saved = data.result;
      return {
        projectId, canvas: saved.canvas, layout: saved.layout, revision: saved.revision,
        elements: saved.elements, totalElements: saved.elementCount, truncated: saved.truncated,
        flowConnections: saved.flowConnections, workspaceRevision: data.revision, readOnly: true
      };
    }, command.args.project_id);
  } else if (command.action === 'project_code_transfer') {
    stage = 'project_code_transfer_' + command.args.operation;
    result = await page.evaluate(async ({ projectId, source, args }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const endpoint = '/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/code-transfer';
      const post = async body => {
        const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || ('Code transfer failed (HTTP ' + response.status + ').'));
        return data;
      };
      if (args.operation === 'begin') {
        const inspectResponse = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action: 'project.inspect', args: { projectId } })
        });
        const inspect = await inspectResponse.json().catch(() => ({}));
        if (!inspectResponse.ok || inspect.ok !== true) throw new Error(inspect.detail || inspect.error || 'Could not inspect project before code transfer.');
        return post({ action: 'begin', projectId, source, field: args.field, baseRevision: inspect.revision,
          totalChunks: args.total_chunks, sha256: args.sha256 });
      }
      if (args.operation === 'chunk') return post({ action: 'chunk', transferId: args.transfer_id, index: args.index, chunk: args.chunk, sha256: args.sha256 });
      return post({ action: 'commit', transferId: args.transfer_id });
    }, { projectId: command.args.project_id, source: command.args.source === 'branch' ? 'branch' : 'main', args: command.args });
  } else if (command.action === 'design_image_transfer') {
    stage = 'design_image_transfer_' + command.args.operation;
    result = await page.evaluate(async ({ projectId, args }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const endpoint = '/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/code-transfer';
      const post = async body => {
        const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || ('Image transfer failed (HTTP ' + response.status + ').'));
        return data;
      };
      if (args.operation === 'begin') return post({ action: 'image_begin', projectId, totalChunks: args.total_chunks, sha256: args.sha256, mime: args.mime });
      if (args.operation === 'chunk') {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(args.chunk));
        const chunkHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        return post({ action: 'image_chunk', transferId: args.transfer_id, index: args.index, chunk: args.chunk, sha256: chunkHash });
      }
      return post({ action: 'image_commit', transferId: args.transfer_id });
    }, { projectId: command.args.project_id, args: command.args });
  } else if (command.action === 'project_code_write') {
    stage = 'project_code_write';
    result = await page.evaluate(async ({ projectId, source, patch }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved project query failed.');
        return data;
      };
      const before = await query('project.inspect', { projectId });
      if (before.result.type === 'design') throw new Error('Code editing is not supported for design-only projects.');
      if (source === 'branch' && !before.result.branch) throw new Error('Project has no saved copy branch.');
      const operationId = 'code_write_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          baseRevision: before.revision, operationId,
          operations: [{ type: 'web.code.write', projectId, source, mode: 'replace', ...patch }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless code write failed.');
      const maxChars = Math.max(1, ...Object.values(patch).map(value => value.length));
      const readback = await query('project.code.read', { projectId, source, languages: ['html', 'css', 'js'], maxChars });
      const exact = Object.entries(patch).every(([key, value]) =>
        readback.result.fields[key]?.value === value && readback.result.fields[key]?.truncated === false);
      if (!exact) throw new Error('Code write failed authoritative server readback.');
      let workspaceRefreshed = false;
      try { workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false; } catch (_) {}
      return {
        projectId, source, changedFields: Object.keys(patch), saved: true,
        persistedCodeMatchesRequested: exact, serverReadbackVerified: true, workspaceRefreshed,
        workspaceRevision: readback.revision,
        codeLengths: Object.fromEntries(Object.entries(readback.result.fields).map(([key, field]) => [key, field.originalLength]))
      };
    }, {
      projectId: command.args.project_id,
      source: command.args.source === 'branch' ? 'branch' : 'main',
      patch: Object.fromEntries(['html', 'css', 'js'].filter(key => Object.prototype.hasOwnProperty.call(command.args, key)).map(key => [key, command.args[key]]))
    });
  } else if (command.action === 'project_list') {
    stage = 'project_list';
    result = await page.evaluate(async () => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action: 'project.list' })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || 'Saved project list query failed.');
      return { ...data.result, workspaceRevision: data.revision, readOnly: true };
    });
  } else if (command.action === 'project_rename') {
    stage = 'project_rename';
    result = await page.evaluate(async ({ projectId, name }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved project query failed.');
        return data;
      };
      const before = await query('project.inspect', { projectId });
      const operationId = 'rename_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          baseRevision: before.revision, operationId,
          operations: [{ type: 'project.rename', projectId, name: name.trim() }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless project rename failed.');
      const after = await query('project.inspect', { projectId });
      const serverReadbackVerified = after.result.name === name.trim();
      if (!serverReadbackVerified) throw new Error('Renamed project failed authoritative server readback.');
      let workspaceRefreshed = false;
      try { workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false; } catch (_) {}
      return {
        projectId, previousName: before.result.name, name: after.result.name,
        serverReadbackVerified, workspaceRefreshed, workspaceRevision: after.revision, saved: true
      };
    }, { projectId: command.args.project_id, name: command.args.name });
  } else if (command.action === 'project_save') {
    stage = 'project_save';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (currentProjectId !== projectId) openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 250));
      let saved;
      if (inCopyBranch) saved = await saveInCopyBranch();
      else saved = await saveCurrentCodeToActiveProject(true);
      const projectAfter = projects.find(item => item && item.id === projectId);
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      let localVerified = false;
      if (projectAfter?.type === 'design') {
        localVerified = !!localProject?.design && JSON.stringify(localProject.design) === JSON.stringify(projectAfter.design);
      } else {
        const expectedCode = inCopyBranch ? projectAfter?.branch?.code : projectAfter?.code;
        const localCode = inCopyBranch ? localProject?.branch?.code : localProject?.code;
        localVerified = !!expectedCode && !!localCode && ['html', 'css', 'js'].every(key => localCode[key] === expectedCode[key]);
      }
      return {
        projectId,
        saved: saved === true,
        serverConfirmed: saved === true,
        persistenceScope: saved === true ? 'server-confirmed' : 'local-snapshot-only',
        localSnapshotVerified: localVerified,
        branchPresent: !!projectAfter?.branch
      };
    }, command.args.project_id);
    if (!result.saved && !result.localSnapshotVerified) throw new Error('Save could not be verified on server or exact local project state.');
  } else if (command.action === 'branch_status') {
    stage = 'branch_status';
    result = await page.evaluate(async projectId => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ action: 'branch.inspect', args: { projectId } })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || 'Saved branch inspection failed.');
      const branch = data.result.branch;
      return {
        projectId, hasBranch: data.result.exists, branchId: branch?.id || null,
        baseMainUpdatedAt: branch?.baseMainUpdatedAt || null, branchUpdatedAt: branch?.updatedAt || null,
        codeLengths: branch?.codeLengths || null, mergeHistoryCount: data.result.mergeHistoryCount,
        revision: data.revision, readOnly: true
      };
    }, command.args.project_id);
  } else if (command.action === 'branch_resume') {
    stage = 'branch_resume';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.branch) throw new Error('Project has no saved copy branch to resume.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!inCopyBranch) await toggleCopyBranch();
      const resumed = getCurrentProject();
      const verified = !!(inCopyBranch && resumed?.branch && resumed.branch.id === copyBranchId &&
        getEditorValue('html') === resumed.branch.code.html &&
        getEditorValue('css') === resumed.branch.code.css &&
        getEditorValue('js') === resumed.branch.code.js);
      if (!verified) throw new Error('The saved branch could not be verified in the editor.');
      return { projectId, projectName: resumed.name, branchId: copyBranchId, resumed: true, editorMatchesSavedBranch: verified };
    }, command.args.project_id);
  } else if (command.action === 'branch_save') {
    stage = 'branch_save';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.branch) throw new Error('Project has no copy branch to save.');
      if (currentProjectId !== projectId || !inCopyBranch) {
        openProject(projectId);
        await new Promise(resolve => setTimeout(resolve, 300));
        if (!inCopyBranch) await toggleCopyBranch();
      }
      const saved = await saveInCopyBranch();
      const latest = projects.find(item => item && item.id === projectId);
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const localBranch = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId)?.branch : null;
      const localVerified = !!localBranch && localBranch.id === latest?.branch?.id &&
        localBranch.code?.html === latest.branch.code?.html &&
        localBranch.code?.css === latest.branch.code?.css &&
        localBranch.code?.js === latest.branch.code?.js;
      if (!saved && !localVerified) throw new Error('Copy branch save could not be verified.');
      return { projectId, branchId: latest.branch.id, serverSynced: saved === true, localSnapshotVerified: localVerified, updatedAt: latest.branch.updatedAt };
    }, command.args.project_id);
  } else if (command.action === 'branch_create') {
    stage = 'branch_create';
    result = await page.evaluate(async projectId => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved branch query failed.');
        return data;
      };
      const before = await query('project.inspect', { projectId });
      if (before.result.type === 'design') throw new Error('Copy branches currently support web projects only.');
      if (before.result.branch) return {
        projectId, branchId: before.result.branch.id, created: false, alreadyExists: true,
        serverReadbackVerified: true, workspaceRevision: before.revision
      };
      const operationId = 'branch_create_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ baseRevision: before.revision, operationId, operations: [{ type: 'branch.create', projectId }] })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless branch creation failed.');
      const after = await query('branch.inspect', { projectId });
      const branch = after.result.branch;
      const serverReadbackVerified = after.result.exists === true &&
        JSON.stringify(branch?.codeLengths) === JSON.stringify(before.result.codeLengths);
      if (!serverReadbackVerified) throw new Error('Created branch failed authoritative server readback.');
      let workspaceRefreshed = false;
      try { workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false; } catch (_) {}
      return {
        projectId, branchId: branch.id, created: true, alreadyExists: false,
        serverReadbackVerified, workspaceRefreshed, workspaceRevision: after.revision
      };
    }, command.args.project_id);
  } else if (command.action === 'branch_merge') {
    stage = 'branch_merge';
    result = await page.evaluate(async ({ projectId, approved }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved branch query failed.');
        return data;
      };
      const before = await query('branch.inspect', { projectId });
      if (!before.result.exists) throw new Error('Project has no saved copy branch to merge.');
      const operationId = 'branch_merge_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ baseRevision: before.revision, operationId, operations: [{ type: 'branch.merge', projectId, approved }] })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless branch merge failed.');
      const after = await query('branch.inspect', { projectId });
      const backupCreated = after.result.exists === false && after.result.mergeHistoryCount === before.result.mergeHistoryCount + 1;
      if (!backupCreated) throw new Error('Merge result or backup failed authoritative server readback.');
      let workspaceRefreshed = false;
      try { workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false; } catch (_) {}
      return {
        projectId, merged: true, backupCreated, mergeHistoryLength: after.result.mergeHistoryCount,
        workspaceRevision: after.revision, workspaceRefreshed, saved: true
      };
    }, { projectId: command.args.project_id, approved: command.approval === 'approved' });
  } else if (command.action === 'branch_undo_merge') {
    stage = 'branch_undo_merge';
    result = await page.evaluate(async ({ projectId, approved }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved branch query failed.');
        return data;
      };
      const before = await query('branch.inspect', { projectId });
      if (before.result.mergeHistoryCount < 1) throw new Error('Project has no merge to undo.');
      const operationId = 'branch_undo_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({ baseRevision: before.revision, operationId, operations: [{ type: 'branch.undo_merge', projectId, approved }] })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless merge undo failed.');
      const after = await query('branch.inspect', { projectId });
      const restored = after.result.mergeHistoryCount === before.result.mergeHistoryCount - 1 && after.result.exists === true;
      if (!restored) throw new Error('Undo merge failed authoritative branch/history readback.');
      let workspaceRefreshed = false;
      try { workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false; } catch (_) {}
      return {
        projectId, restored, branchPresent: after.result.exists,
        mergeHistoryRemaining: after.result.mergeHistoryCount,
        workspaceRevision: after.revision, workspaceRefreshed, saved: true
      };
    }, { projectId: command.args.project_id, approved: command.approval === 'approved' });
  } else if (command.action === 'component_search') {
    stage = 'component_search';
    result = await page.evaluate(({ query, category }) => {
      const api = window.CodeLabComponentLibrary;
      if (!api || typeof api.searchComponents !== 'function') throw new Error('Component library API is not ready.');
      const matches = api.searchComponents(query || '', category || 'Todas');
      return { count: matches.length, components: matches.slice(0, 100).map(item => ({
        id: item.id, name: item.name, category: item.category, description: item.description, tags: item.tags
      })), truncated: matches.length > 100 };
    }, { query: command.args.query || '', category: command.args.category || 'Todas' });
  } else if (command.action === 'component_inspect') {
    stage = 'component_inspect';
    result = await page.evaluate(({ componentId, maxChars }) => {
      const api = window.CodeLabComponentLibrary;
      if (!api || typeof api.getComponent !== 'function' || typeof api.standaloneHtml !== 'function') {
        throw new Error('Component library inspection API is not ready.');
      }
      const item = api.getComponent(componentId);
      if (!item) throw new Error('Component ID was not found in the library.');
      const html = api.standaloneHtml(item);
      const limit = Number.isInteger(maxChars) ? Math.max(1000, Math.min(7000, maxChars)) : 5000;
      return {
        id: item.id, name: item.name, category: item.category, description: item.description,
        tags: item.tags, htmlLength: html.length, html: html.slice(0, limit),
        truncated: html.length > limit, format: 'text/html'
      };
    }, { componentId: command.args.component_id, maxChars: command.args.max_chars });
  } else if (command.action === 'component_insert') {
    stage = 'component_insert';
    result = await page.evaluate(async ({ projectId, componentId }) => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !workspaceToken) throw new Error('Authenticated workspace credentials are unavailable.');
      const query = async (action, args) => {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless/query', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
          body: JSON.stringify({ action, args })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Saved project query failed.');
        return data;
      };
      const before = await query('project.inspect', { projectId });
      if (before.result.type === 'design') throw new Error('Components can only be inserted into a web project.');
      const readHtml = async () => {
        let offset = 0, content = '', originalLength = 0;
        do {
          const part = await query('project.code.read', { projectId, source: 'main', languages: ['html'], offset, maxChars: 200000 });
          const field = part.result.fields.html;
          content += field.value;
          originalLength = field.originalLength;
          if (field.nextOffset === null) break;
          if (field.nextOffset <= offset || field.nextOffset > 500000) throw new Error('HTML paging did not advance safely.');
          offset = field.nextOffset;
        } while (offset <= 500000);
        if (content.length !== originalLength) throw new Error('HTML readback was incomplete.');
        return content;
      };
      const current = await readHtml();
      const legacyMarker = '<!-- codelab-component:' + componentId + ' -->';
      const canonicalMarker = '<!-- codelab-component:' + componentId + ':v1 -->';
      if (current.includes(legacyMarker) || current.includes(canonicalMarker)) {
        return { projectId, componentId, alreadyInserted: true, saved: true, serverReadbackVerified: true, workspaceRevision: before.revision };
      }
      const operationId = 'component_insert_' + crypto.randomUUID().replace(/-/g, '');
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/headless', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspaceToken },
        body: JSON.stringify({
          baseRevision: before.revision, operationId,
          operations: [{ type: 'component.insert', projectId, componentId }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.detail || data.error || 'Headless component insertion failed.');
      const savedHtml = await readHtml();
      const verified = savedHtml.includes(canonicalMarker);
      if (!verified) throw new Error('Component insertion failed authoritative server readback.');
      let workspaceRefreshed = false;
      try { workspaceRefreshed = typeof refreshWorkspaceFromServer === 'function' ? await refreshWorkspaceFromServer() : false; } catch (_) {}
      return {
        projectId, componentId, alreadyInserted: false, saved: true, serverReadbackVerified: verified,
        workspaceRevision: data.revision, workspaceRefreshed, htmlLength: savedHtml.length
      };
    }, { projectId: command.args.project_id, componentId: command.args.component_id });
  } else if (command.action === 'design_element_add') {
    stage = 'design_element_add';
    result = await executeSavedDesignBatch('design_element_add', command.args);
  } else if (command.action === 'design_element_update') {
    stage = 'design_element_update';
    result = await executeSavedDesignBatch('design_element_update', command.args);
  } else if (command.action === 'design_element_delete') {
    stage = 'design_element_delete';
    result = await executeSavedDesignBatch('design_element_delete', command.args);
  } else if (command.action === 'design_elements_delete') {
    stage = 'design_elements_delete';
    result = await executeSavedDesignBatch('design_elements_delete', command.args);
  } else if (command.action === 'design_element_duplicate') {
    stage = 'design_element_duplicate';
    result = await executeSavedDesignBatch('design_element_duplicate', command.args);
  } else if (command.action === 'design_layer_move') {
    stage = 'design_layer_move';
    result = await executeSavedDesignBatch('design_layer_move', command.args);
  } else if (command.action === 'design_layer_reorder') {
    stage = 'design_layer_reorder';
    result = await executeSavedDesignBatch('design_layer_reorder', command.args);
  } else if (command.action === 'design_elements_align') {
    stage = 'design_elements_align';
    result = await executeSavedDesignBatch('design_elements_align', command.args);
  } else if (command.action === 'design_elements_distribute') {
    stage = 'design_elements_distribute';
    result = await executeSavedDesignBatch('design_elements_distribute', command.args);
  } else if (command.action === 'design_prototype_target_set') {
    stage = 'design_prototype_target_set';
    result = await page.evaluate(async ({projectId,elementId,target}) => {
      const workspaceId=localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken=localStorage.getItem('codelab_xd_workspace_token_v1');
      if(!workspaceId||!workspaceToken)throw new Error('Authenticated workspace credentials are unavailable.');
      const query=async(action,args)=>{
        const response=await fetch('/api/workspace/'+encodeURIComponent(workspaceId)+'/headless/query',{
          method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','x-workspace-token':workspaceToken},
          body:JSON.stringify({action,args})
        });
        const data=await response.json().catch(()=>({}));
        if(!response.ok||data.ok!==true)throw new Error(data.detail||data.error||'Saved design query failed.');
        return data;
      };
      const before=await query('design.read',{projectId,limit:500});
      const element=before.result.elements.find(item=>item.id===elementId);
      if(!element)throw new Error('Design element not found.');
      if(!['button','text','heading','image'].includes(element.type))throw new Error('Prototype targets can only be assigned to supported interactive or content elements.');
      const operationId='prototype_target_'+crypto.randomUUID().replace(/-/g,'');
      const response=await fetch('/api/workspace/'+encodeURIComponent(workspaceId)+'/headless',{
        method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','x-workspace-token':workspaceToken},
        body:JSON.stringify({baseRevision:before.revision,operationId,operations:[{type:'design.batch',projectId,expectedDesignRevision:before.result.revision,operations:[{type:'element.update',id:elementId,properties:{href:target}}]}]})
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok||data.ok!==true)throw new Error(data.detail||data.error||'Headless prototype target update failed.');
      const after=await query('design.read',{projectId,limit:500});
      const updated=after.result.elements.find(item=>item.id===elementId);
      if(!updated||updated.href!==target)throw new Error('Prototype target failed authoritative server readback.');
      return {projectId,elementId,previousTarget:element.href||'',target:updated.href||'',saved:true,serverReadbackVerified:true,workspaceRevision:after.revision,designRevision:after.result.revision};
    },{projectId:command.args.project_id,elementId:command.args.element_id,target:command.args.target});
  } else if (command.action === 'design_layout_configure') {
    stage = 'design_layout_configure';
    result = await executeSavedDesignBatch('design_layout_configure', command.args);
  } else if (command.action === 'design_canvas_configure') {
    stage = 'design_canvas_configure';
    result = await page.evaluate(async ({projectId,settings}) => {
      const workspaceId=localStorage.getItem('codelab_xd_workspace_v4');
      const workspaceToken=localStorage.getItem('codelab_xd_workspace_token_v1');
      if(!workspaceId||!workspaceToken)throw new Error('Authenticated workspace credentials are unavailable.');
      if(settings.zoom!==undefined)throw new Error('Canvas zoom is view-only and cannot be persisted by headless mode; configure saved canvas settings separately.');
      const query=async(action,args)=>{
        const response=await fetch('/api/workspace/'+encodeURIComponent(workspaceId)+'/headless/query',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','x-workspace-token':workspaceToken},body:JSON.stringify({action,args})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok||data.ok!==true)throw new Error(data.detail||data.error||'Saved design query failed.');
        return data;
      };
      const before=await query('design.read',{projectId,limit:500});
      const operation={type:'canvas.set'};
      if(settings.frame!==undefined)operation.frame=settings.frame;
      if(settings.canvas_width!==undefined)operation.width=settings.canvas_width;
      if(settings.canvas_height!==undefined)operation.height=settings.canvas_height;
      if(settings.background!==undefined)operation.background=settings.background;
      if(settings.grid!==undefined)operation.grid=settings.grid;
      if(settings.snap_to_grid!==undefined)operation.snapToGrid=settings.snap_to_grid;
      if(settings.grid_size!==undefined)operation.gridSize=settings.grid_size;
      const response=await fetch('/api/workspace/'+encodeURIComponent(workspaceId)+'/headless',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','x-workspace-token':workspaceToken},body:JSON.stringify({baseRevision:before.revision,operationId:'canvas_config_'+crypto.randomUUID().replace(/-/g,''),operations:[{type:'design.batch',projectId,expectedDesignRevision:before.result.revision,operations:[operation]}]})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||data.ok!==true)throw new Error(data.detail||data.error||'Headless canvas configuration failed.');
      const after=await query('design.read',{projectId,limit:500});
      const actual=after.result.canvas;
      const mapping={frame:'frame',canvas_width:'width',canvas_height:'height',background:'background',grid:'grid',snap_to_grid:'snapToGrid',grid_size:'gridSize'};
      if(!Object.entries(settings).every(([key,value])=>actual[mapping[key]]===value))throw new Error('Canvas configuration failed authoritative server readback.');
      return {projectId,settings:actual,changed:Object.keys(settings),saved:true,serverReadbackVerified:true,workspaceRevision:after.revision,designRevision:after.result.revision,zoomSupported:false};
    },{projectId:command.args.project_id,settings:Object.fromEntries(['frame','grid','snap_to_grid','grid_size','zoom','background','canvas_width','canvas_height'].filter(key=>command.args[key]!==undefined).map(key=>[key,command.args[key]]))});
  } else if (command.action === 'preview_diagnostics') {
    stage = 'inspect_headless_preview';
    const projectId = command.args.project_id || (command.args.self_test === true ? null : await page.evaluate(() => currentProjectId));
    const previewSession = await createHeadlessPreview(projectId, command.args.source || 'main', command.args.self_test === true, 'diagnostics');
    try {
      const preview = await previewSession.frame.locator('html').evaluate(() => {
        const body = document.body;
        const interactiveElements = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]')).slice(0, 60).map(element => ({
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 100),
          id: element.id || null,
          type: element.getAttribute('type') || null,
          disabled: Boolean(element.disabled)
        }));
        const tagCounts = {};
        for (const element of Array.from(document.querySelectorAll('*')).slice(0, 5000)) {
          const tag = element.tagName.toLowerCase();
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
        return {
          available: true, readyState: document.readyState, title: document.title || '',
          frameUrl: location.href, text: (body?.innerText || '').trim().slice(0, 1200),
          elementCount: document.querySelectorAll('*').length, tagCounts, interactiveElements
        };
      });
      const messages = await previewSession.page.evaluate(() => window.__codelabPreviewMessages || []);
      preview.previewMessages = messages.slice(0, 60);
      preview.consoleErrors = messages.filter(message => message.logType === 'error').slice(0, 30);
      preview.empty = !preview.title && !preview.text && preview.interactiveElements.length === 0;
      preview.selfTest = command.args.self_test === true;
      preview.workspaceRevision = previewSession.revision;
      result = {
        page: { url: safeUrl(targetUrl), title: 'CodeLab headless preview host', documentReady: 'complete' },
        preview,
        browserDiagnostics: previewSession.diagnostics
      };
    } finally {
      await previewSession.context.close().catch(() => {});
    }
  } else if (command.action === 'preview_interact') {
    stage = 'interact_with_headless_preview';
    const projectId = command.args.project_id || (command.args.self_test === true ? null : await page.evaluate(() => currentProjectId));
    const previewSession = await createHeadlessPreview(projectId, command.args.source || 'main', command.args.self_test === true, 'interactions');
    try {
      const steps = [];
      for (let index = 0; index < command.args.steps.length; index += 1) {
        currentStep = index + 1;
        const step = command.args.steps[index];
        const locator = previewSession.frame.locator(step.selector).first();
        if (await locator.count() === 0) throw new Error('Preview step ' + (index + 1) + ': selector did not match an element inside the isolated headless preview.');
        if (step.action === 'click') {
          const tag = await locator.evaluate(element => element.tagName.toLowerCase());
          if (tag === 'a') {
            const href = await locator.getAttribute('href') || '';
            if (href && !href.startsWith('#')) throw new Error('Preview anchor navigation is blocked; only in-page hash links may be clicked.');
          }
          await locator.click({ timeout: 10000 });
        } else if (step.action === 'fill') {
          await locator.fill(step.value, { timeout: 10000 });
        } else if (step.action === 'select') {
          await locator.selectOption(step.value, { timeout: 10000 });
        } else if (step.action === 'upload') {
          const inputType = await locator.getAttribute('type');
          if ((await locator.evaluate(element => element.tagName.toLowerCase())) !== 'input' || inputType !== 'file') {
            throw new Error('Preview upload target must be an input[type="file"].');
          }
          const upload = validatePreviewUpload(step);
          await locator.setInputFiles({
            name: upload.fileName,
            mimeType: upload.mimeType,
            buffer: upload.buffer
          }, { timeout: 10000 });
        } else if (step.action === 'check') {
          await locator.check({ timeout: 10000 });
        } else if (step.action === 'uncheck') {
          await locator.uncheck({ timeout: 10000 });
        } else if (step.action === 'press') {
          await locator.press(step.value, { timeout: 10000 });
        } else if (step.action === 'hover') {
          await locator.hover({ timeout: 10000 });
        } else if (step.action === 'focus') {
          await locator.focus({ timeout: 10000 });
        }
        await previewSession.page.waitForTimeout(60);
        const observed = await locator.evaluate(element => ({
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.textContent || '').trim().slice(0, 300),
          value: ('value' in element) ? String(element.value).slice(0, 300) : null,
          disabled: Boolean(element.disabled),
          checked: ('checked' in element) ? Boolean(element.checked) : null,
          files: element.files ? Array.from(element.files).slice(0, 5).map(file => ({ name: file.name, size: file.size, type: file.type })) : null
        })).catch(() => null);
        if (step.action === 'assert_text' && (!observed || !observed.text.includes(step.value))) {
          throw new Error('Preview step ' + (index + 1) + ': expected text was not found.');
        }
        if (step.action === 'assert_visible' && !(await locator.isVisible().catch(() => false))) {
          throw new Error('Preview step ' + (index + 1) + ': element is not visible.');
        }
        if (step.action === 'assert_enabled' && !(await locator.isEnabled().catch(() => false))) {
          throw new Error('Preview step ' + (index + 1) + ': element is not enabled.');
        }
        steps.push({ step: index + 1, action: step.action, selector: step.selector, succeeded: true, observed });
      }
      currentStep = null;
      const previewTitle = await previewSession.frame.locator('html').evaluate(() => document.title || '');
      const text = await previewSession.frame.locator('body').innerText({ timeout: 5000 }).then(value => value.slice(0, 1200));
      const messages = await previewSession.page.evaluate(() => window.__codelabPreviewMessages || []);
      result = {
        ok: true, projectId, source: command.args.source || 'main',
        previewTitle, text, steps, selfTest: command.args.self_test === true,
        previewMessages: messages.slice(0, 60), browserDiagnostics: previewSession.diagnostics,
        workspaceRevision: previewSession.revision
      };
    } finally {
      currentStep = null;
      await previewSession.context.close().catch(() => {});
    }
  } else if (command.action === 'read_page') {
    result = {
      url: page.url(),
      title: await page.title(),
      documentReady: await page.evaluate(() => document.readyState),
      text: (await page.locator('body').innerText({ timeout: 10000 })).slice(0, 2500)
    };
  } else if (command.action === 'list_controls') {
    result = await page.locator('button,a,input,textarea,select,summary,[role="button"],[onclick],[data-action],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]').evaluateAll((els, includeText) =>
      els.filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }).slice(0, 150).map(el => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        text: includeText ? (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 120) : null,
        id: el.id || null,
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        title: el.getAttribute('title'),
        ariaLabel: el.getAttribute('aria-label'),
        dataAction: el.getAttribute('data-action'),
        href: el.getAttribute('href'),
        disabled: Boolean(el.disabled)
      })),
      commandSource !== 'comment'
    );
  } else if (command.action === 'sequence') {
    result = [];
    for (let index = 0; index < command.args.steps.length; index += 1) {
      currentStep = index + 1;
      const step = command.args.steps[index];
      const locator = page.locator(step.selector).first();
      if (await locator.count() === 0) throw new Error('Sequence step ' + (index + 1) + ': selector did not match an element.');
      if (step.action === 'click') {
        const tag = await locator.evaluate(el => el.tagName.toLowerCase());
        if (tag === 'a') {
          const href = await locator.getAttribute('href');
          if (href) {
            const u = new URL(href, page.url());
            if (u.origin !== targetUrl.origin) throw new Error('External navigation is blocked by the bridge.');
          }
        }
        await locator.click({ timeout: 10000 });
        result.push({ step: index + 1, action: step.action, selector: step.selector, succeeded: true, urlAfter: page.url() });
      } else if (step.action === 'fill') {
        await locator.fill(step.value, { timeout: 10000 });
        result.push({ step: index + 1, action: step.action, selector: step.selector, succeeded: true });
      } else if (step.action === 'select') {
        await locator.selectOption(step.value, { timeout: 10000 });
        result.push({ step: index + 1, action: step.action, selector: step.selector, succeeded: true });
      }
    }
    currentStep = null;
  } else {
    const locator = page.locator(command.args.selector).first();
    if (await locator.count() === 0) throw new Error('Selector did not match an element.');
    if (command.action === 'read_element') {
      result = { text: (await locator.innerText().catch(() => locator.inputValue().catch(() => ''))).slice(0, 2000) };
    } else if (command.action === 'fill') {
      await locator.fill(command.args.value, { timeout: 10000 });
      result = { filled: true, selector: command.args.selector };
    } else if (command.action === 'select') {
      result = { selected: await locator.selectOption(command.args.value, { timeout: 10000 }) };
    } else if (command.action === 'click') {
      const tag = await locator.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'a') {
        const href = await locator.getAttribute('href');
        if (href) {
          const u = new URL(href, page.url());
          if (u.origin !== targetUrl.origin) throw new Error('External navigation is blocked by the bridge.');
        }
      }
      await locator.click({ timeout: 10000 });
      result = { clicked: true, selector: command.args.selector, urlAfter: page.url() };
    }
  }
  // Capture the actual public interface so labels, controls, panels, and layout can be inspected.
  // Mask only fields that explicitly indicate passwords or secrets; preserve ordinary UI content.
  if (['click', 'fill', 'select', 'sequence'].includes(command.action)) {
    stage = 'capture_readable_ui_screenshot';
    await page.addStyleTag({ content: [
      'input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"] { color: transparent !important; text-shadow: none !important; }',
      'input[name*="token" i], input[id*="token" i], textarea[name*="secret" i], input[name*="secret" i] { color: transparent !important; text-shadow: none !important; }'
    ].join('\n') });
    const screenshotPath = process.env.CODELAB_SCREENSHOT_PATH || '.codelab-artifacts/bridge-ui.png';
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' });
    if (Array.isArray(result)) {
      result = { steps: result, readableUiScreenshotCaptured: true };
    } else if (result && typeof result === 'object') {
      result = { ...result, readableUiScreenshotCaptured: true };
    }
  }
  stage = 'report_result';
  await comment('## CodeLab Bridge result\n\n```json\n' + JSON.stringify({
    protocol: 'codelab-agent-bridge/v1',
    command_id: commandId,
    status: 'succeeded',
    completed_at: new Date().toISOString(),
    diagnostics: {
      stage: 'completed',
      command_action: commandAction,
      command_source: commandSource,
      elapsed_ms: Date.now() - startedAt,
      workflow_run_id: process.env.GITHUB_RUN_ID || null,
      workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
      issue_number: Number.isFinite(issueNumber) ? issueNumber : null
    },
    result
  }, null, 2).slice(0, 9000) + '\n```');
} catch (error) {
  const rawMessage = String(error?.message || error);
  const safeMessage = rawMessage.replace(/<[^>]*>/g, '<element>').slice(0, 1000);
  const errorCode = stage === 'parse_command' ? 'command_validation_failed'
    : stage === 'admin_authentication' ? 'authentication_failed'
    : stage === 'capture_redacted_screenshot' ? 'screenshot_failed'
    : /timeout/i.test(rawMessage) ? 'interaction_timeout'
    : /selector did not match/i.test(rawMessage) ? 'selector_not_found'
    : 'bridge_execution_failed';
  const diagnostic = {
    stage,
    error_code: errorCode,
    command_action: commandAction,
    command_source: commandSource,
    elapsed_ms: Date.now() - startedAt,
    workflow_run_id: process.env.GITHUB_RUN_ID || null,
    workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    issue_number: Number.isFinite(issueNumber) ? issueNumber : null,
    current_step: currentStep,
    page_url: page ? page.url() : null
  };
  try {
    await comment('## CodeLab Bridge result\n\n```json\n' + JSON.stringify({
      protocol: 'codelab-agent-bridge/v1',
      command_id: commandId,
      status: 'failed',
      completed_at: new Date().toISOString(),
      diagnostics: diagnostic,
      error: safeMessage
    }, null, 2) + '\n```');
  } catch (reportError) {
    console.error('Could not report result:', reportError.message);
  }
  console.error(safeMessage);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
