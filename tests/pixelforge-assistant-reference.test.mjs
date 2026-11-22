import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
test('assistant reference animation asset is vector and animation-ready', async () => {
  const svg = await fs.readFile(path.join(root, 'public/pixelforge/assistant-reference.svg'), 'utf8');
  const html = await fs.readFile(path.join(root, 'public/pixelforge/assistant-reference.html'), 'utf8');
  assert.match(svg, /<svg[^>]+viewBox="0 0 432 768"/);
  assert.match(svg, /id="hair"/);
  assert.match(svg, /id="skirt"/);
  assert.match(html, /HEADLESS-FIRST · OFFLINE/);
  assert.match(html, /Pause animation/);
  assert.match(html, /anim-hair/);
  assert.match(html, /anim-skirt/);
  assert.doesNotMatch(html, /neon|render|oauth|api key/i);
});
