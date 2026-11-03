#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const sourceRoot = path.resolve(process.argv[2] || path.join(repoRoot, '..', 'PixelForge-Ai'));
const targetRoot = path.join(repoRoot, 'public', 'pixelforge');
const expectedPackage = path.join(sourceRoot, 'package.json');
if (!fs.existsSync(expectedPackage)) {
  console.error('PixelForge source not found. Usage: node scripts/sync-pixelforge.mjs /path/to/PixelForge-Ai');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(expectedPackage, 'utf8'));
if (manifest.name !== 'pixelforge-ai') {
  console.error('Refusing to sync: source package name is not pixelforge-ai.');
  process.exit(1);
}
const files = [
  'index.html', 'styles.css',
  'src/core.js', 'src/persistence.js', 'src/image-import.js', 'src/asset-export.js',
  'src/editor.js', 'src/workspaces.js', 'src/ai-tools.js', 'src/ai-provider.js',
  'src/headless.js', 'src/headless-vision.js'
];
for (const relative of files) {
  const source = path.resolve(sourceRoot, relative);
  if (!source.startsWith(sourceRoot + path.sep) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error('Missing or invalid PixelForge source file: ' + relative);
  }
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
let commit = 'unknown';
let branch = 'unknown';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(); } catch (_) {}
try { branch = execFileSync('git', ['branch', '--show-current'], { cwd: sourceRoot, encoding: 'utf8' }).trim() || 'detached'; } catch (_) {}
fs.writeFileSync(path.join(targetRoot, 'UPSTREAM.json'), JSON.stringify({
  sourceRepository: 'https://github.com/gavilandavid89-pixel/PixelForge-Ai',
  sourceBranch: branch,
  sourceCommit: commit,
  syncedAt: new Date().toISOString(),
  files
}, null, 2) + '\n');
console.log('Synced ' + files.length + ' PixelForge files from ' + commit + ' into public/pixelforge/.');
