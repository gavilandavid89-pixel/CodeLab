const assert = require('node:assert/strict');
const tools = require('../public/design-tools.js');

assert.equal(tools.normalizeHex('#abc'), '#aabbcc');
assert.equal(tools.normalizeHex('invalid', '#123456'), '#123456');
assert.equal(tools.contrastRatio('#ffffff', '#000000'), 21);
assert.ok(Math.abs(tools.contrastRatio('#777777', '#ffffff') - 4.478) < 0.02);
assert.equal(tools.generatePalette('#06b6d4').length, 10);
assert.equal(tools.generatePalette('#06b6d4')[5].color, '#06b6d4');

const tokens = tools.buildDesignTokens({
  name: '  Sistema Demo  ',
  primary: '#123456',
  baseFont: 18,
  typeRatio: 1.2,
  baseSpacing: 6,
  baseRadius: 10
});
assert.equal(tokens.format, 'codelab-design-system');
assert.equal(tokens.name, 'Sistema Demo');
assert.equal(tokens.colors.primary, '#123456');
assert.deepEqual(tokens.typography.scale.map(item => item.name), ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl']);
assert.equal(tokens.typography.scale.find(item => item.name === 'base').px, 18);
assert.equal(tokens.spacing.length, 8);
assert.equal(tokens.spacing[7].px, 48);
assert.equal(tokens.radius.find(item => item.name === 'radius-lg').px, 10);
assert.equal(tokens.accessibility.contrastRatio, Math.round(tools.contrastRatio('#f8fafc', '#020617') * 100) / 100);

const exportedRoundTrip = tools.buildDesignTokens({ name: 'Round trip', primary: '#123456', baseFont: 20, typeRatio: 1.3, baseSpacing: 8, baseRadius: 16 });
assert.equal(exportedRoundTrip.format, 'codelab-design-system');
assert.equal(exportedRoundTrip.version, 1);
assert.equal(exportedRoundTrip.typography.baseFontPx, 20);
assert.equal(exportedRoundTrip.spacing[0].px, 8);
assert.equal(exportedRoundTrip.radius.find(item => item.name === 'radius-lg').px, 16);

const css = tools.toCssVariables({ primary: '#123456', baseFont: 18, baseSpacing: 6 });
assert.match(css, /--color-primary: #123456;/);
assert.match(css, /--color-primary-500: #123456;/);
assert.match(css, /--font-size-base: 18px;/);
assert.match(css, /--space-8: 48px;/);
assert.match(css, /--radius-xl: 24px;/);

const injected = tools.injectTokenBlock('.button { color: red; }', css);
assert.match(injected, /\/\* CodeLab Design Tokens START \*\//);
assert.match(injected, /--color-primary: #123456;/);
assert.match(injected, /\.button \{ color: red; \}/);
const updated = tools.injectTokenBlock(injected, ':root { --color-primary: #abcdef; }');
assert.equal((updated.match(/CodeLab Design Tokens START/g) || []).length, 1);
assert.match(updated, /--color-primary: #abcdef;/);
assert.match(updated, /\.button \{ color: red; \}/);
const recoveredMalformedBlock = tools.injectTokenBlock(
  '/* CodeLab Design Tokens START */\n.button { color: green; }\n/* unrelated comment */',
  ':root { --color-primary: #abcdef; }'
);
assert.equal((recoveredMalformedBlock.match(/CodeLab Design Tokens START/g) || []).length, 1,
  'An orphaned managed-token marker should be replaced rather than accumulated');
assert.match(recoveredMalformedBlock, /\.button \{ color: green; \}/,
  'Recovering a malformed token block must preserve unmanaged CSS');
assert.doesNotMatch(recoveredMalformedBlock, /CodeLab Design Tokens END.*CodeLab Design Tokens END/s);

const clamped = tools.sanitizeSettings({ baseFont: 200, typeRatio: 3, baseSpacing: 0, baseRadius: -10 });
assert.equal(clamped.baseFont, 32);
assert.equal(clamped.typeRatio, 1.5);
assert.equal(clamped.baseSpacing, 2);
assert.equal(clamped.baseRadius, 0);

const audit = tools.auditHtml('<!doctype html><html><head><title>Broken</title></head><body><h1>Title</h1><h3>Skipped level</h3><img src="hero.png"><button></button><input id="email"><a href="/next" target="_blank"></a><div id="duplicate"></div><span id="duplicate"></span></body></html>');
assert.equal(audit.format, 'codelab-accessibility-audit');
const codes = audit.issues.map(item => item.code);
['missing-lang', 'missing-viewport', 'missing-main', 'heading-skip', 'image-missing-alt', 'button-no-name', 'field-no-label', 'link-no-name', 'blank-link-noopener', 'duplicate-id'].forEach(code => assert.ok(codes.includes(code), 'Expected audit issue ' + code));
assert.ok(audit.summary.errors >= 3);
assert.ok(audit.summary.warnings >= 4);
const goodAudit = tools.auditHtml('<html lang="es"><head><title>Bien</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Hola</h1><img src="decor.png" alt=""><label for="email">Correo</label><input id="email"><button>Enviar</button><a href="/docs">Documentación</a></main></body></html>');
assert.equal(goodAudit.summary.errors, 0);
assert.equal(goodAudit.issues.some(item => item.code === 'image-missing-alt'), false);
const imageLinkAudit = tools.auditHtml('<html lang="es"><head><title>Imágenes enlazadas</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><a href="/inicio"><img src="logo.png" alt="Inicio"></a><a href="/decorativa"><img src="decor.png" alt=""></a></main></body></html>');
assert.equal(imageLinkAudit.issues.filter(item => item.code === 'link-no-name').length, 1, 'A descriptive image alt should name its link, while a decorative alt should not');
const svgNameAudit = tools.auditHtml('<html lang="es"><head><title>Iconos</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><button><img src="decor.png" alt=""></button><button><svg role="img"><title>Guardar</title></svg></button><a href="/inicio"><svg role="img"><title>Inicio</title></svg></a></main></body></html>');
assert.equal(svgNameAudit.issues.filter(item => item.code === 'button-no-name').length, 1, 'An empty-alt decorative image must not name a button, while a titled SVG should');
assert.equal(svgNameAudit.issues.filter(item => item.code === 'link-no-name').length, 0, 'An SVG with role=img and a title should name its link');
const partialLabelAudit = tools.auditHtml('<html lang="es"><head><title>Form</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><label>Nombre<input type="text"></label><input type="email"></body></html>');
assert.equal(partialLabelAudit.issues.filter(item => item.code === 'field-no-label').length, 1, 'Only the field outside its own label should be flagged');

const duplicatedBlocks = tools.injectTokenBlock(injected + '\n\n' + injected, ':root { --color-primary: #abcdef; }');
assert.equal((duplicatedBlocks.match(/CodeLab Design Tokens START/g) || []).length, 1, 'managed CSS token blocks should be deduplicated');
assert.match(duplicatedBlocks, /--color-primary: #abcdef;/);
console.log('Design tools unit tests passed: WCAG contrast, palette generation, typography, spacing, radius and CSS token export.');
