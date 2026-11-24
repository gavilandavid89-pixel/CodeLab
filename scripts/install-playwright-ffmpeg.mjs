import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'playwright-core.cmd' : 'playwright-core';
const result = spawnSync(command, ['install', 'ffmpeg'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env }
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error('Playwright FFmpeg installation failed with exit code ' + result.status + '.');
}
