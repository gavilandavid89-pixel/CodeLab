'use strict';

function finalizeResolvedImageUploads(transferStore, workspaceId, operationId, uploads) {
  if (!transferStore || typeof transferStore.consumeImage !== 'function' || !Array.isArray(uploads)) return;
  for (const upload of uploads) {
    if (!upload || typeof upload.uploadToken !== 'string' || typeof upload.projectId !== 'string') continue;
    try {
      transferStore.consumeImage({
        uploadToken: upload.uploadToken,
        workspaceId,
        projectId: upload.projectId,
        operationId
      });
    } catch (_) {
      // Workspace persistence is already authoritative. Token cleanup is best-effort;
      // the token remains short-lived and can only be resolved by its bound operation.
    }
  }
}

module.exports = { finalizeResolvedImageUploads };
