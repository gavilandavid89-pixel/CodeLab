const ALLOWED_MIME_TYPES = new Set([
  'text/plain', 'image/png', 'image/jpeg', 'image/webp', 'application/pdf'
]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function validatePreviewUpload(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step) ||
      typeof step.file_name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(step.file_name) ||
      typeof step.mime_type !== 'string' || !ALLOWED_MIME_TYPES.has(step.mime_type) ||
      typeof step.data_base64 !== 'string' || step.data_base64.length < 4 ||
      step.data_base64.length > 32000 || !BASE64_PATTERN.test(step.data_base64)) {
    throw new Error('Preview upload requires a safe filename, an allowed MIME type, and valid Base64 of at most 32000 characters.');
  }
  const buffer = Buffer.from(step.data_base64, 'base64');
  if (!buffer.length || buffer.length > 24000) {
    throw new Error('Preview upload file must be between 1 and 24000 bytes.');
  }
  const matchesMime = step.mime_type === 'text/plain' ||
    (step.mime_type === 'image/png' && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) ||
    (step.mime_type === 'image/jpeg' && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) ||
    (step.mime_type === 'image/webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') ||
    (step.mime_type === 'application/pdf' && buffer.toString('ascii', 0, 5) === '%PDF-');
  if (!matchesMime) throw new Error('Preview upload content does not match its declared MIME type.');
  return { fileName: step.file_name, mimeType: step.mime_type, buffer };
}
