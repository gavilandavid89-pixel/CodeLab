const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const scripts = ['app.js', 'capture.js', 'design-tools.js', 'component-library.js']
  .map(name => fs.readFileSync(path.join(root, 'public', name), 'utf8'))
  .join('\n');

const functionNames = new Set(
  [...scripts.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)]
    .map(match => match[1])
);
const inlineEvents = [...html.matchAll(/\bon(?:click|change|input|submit|keydown|keyup|focus|blur)\s*=\s*["']([^"']+)["']/gi)];
const browserBuiltins = new Set([
  'if', 'for', 'while', 'switch', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'alert', 'confirm', 'prompt', 'console', 'event', 'window',
  'document', 'navigator', 'fetch', 'URL', 'URLSearchParams', 'JSON', 'Math',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'Promise',
  'requestAnimationFrame', 'cancelAnimationFrame'
]);

assert.ok(inlineEvents.length > 0, 'Expected the interface to expose inline event handlers');

const unresolved = [];
for (const match of inlineEvents) {
  const expression = match[1];
  // Match direct calls at statement boundaries; property calls such as
  // document.getElementById() and array methods are not application handlers.
  const calls = [...expression.matchAll(/(?:^|[;{}]\s*|return\s+)([A-Za-z_$][\w$]*)\s*\(/g)];
  for (const call of calls) {
    const name = call[1];
    if (!functionNames.has(name) && !browserBuiltins.has(name)) {
      unresolved.push({ name, expression });
    }
  }
}
assert.deepEqual(unresolved, [], 'Every inline UI event must call a function defined by the app');

const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
const seen = new Set();
const duplicates = new Set();
for (const id of ids) {
  if (seen.has(id)) duplicates.add(id);
  seen.add(id);
}
assert.deepEqual([...duplicates], [], 'Static HTML element IDs must be unique');

for (const match of html.matchAll(/<button\b([^>]*)>/gi)) {
  const attrs = match[1];
  const hasLabel = /\baria-label\s*=\s*["'][^"']+["']/i.test(attrs);
  const hasTitle = /\btitle\s*=\s*["'][^"']+["']/i.test(attrs);
  const hasTextOrLabelledChild = /\baria-labelledby\s*=\s*["'][^"']+["']/i.test(attrs);
  // The button's inner text/content is checked separately below by pairing tags.
  const offset = match.index + match[0].length;
  const close = html.toLowerCase().indexOf('</button>', offset);
  const inner = close >= 0 ? html.slice(offset, close) : '';
  const hasReadableText = inner.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().length > 0;
  const hasImageAlt = /<img\b[^>]*\balt\s*=\s*["'][^"']+["']/i.test(inner);
  const hasIconOnly = /<i\b/i.test(inner) && !hasReadableText && !hasImageAlt;
  if (hasIconOnly && !hasLabel && !hasTitle && !hasTextOrLabelledChild) {
    // Keep this as a warning rather than failing on icon-only controls that
    // may inherit an accessible name from a nested SVG/title at runtime.
    process.stdout.write('WARN: possible unlabeled icon button near HTML offset ' + match.index + '\n');
  }
}

console.log(
  'UI wiring audit passed: ' + inlineEvents.length +
  ' inline event handlers, ' + functionNames.size +
  ' application functions, ' + ids.length + ' static IDs; no unresolved handlers or duplicate IDs.'
);
