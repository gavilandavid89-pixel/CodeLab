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

const css = tools.toCssVariables({ primary: '#123456', baseFont: 18, baseSpacing: 6 });
assert.match(css, /--color-primary: #123456;/);
assert.match(css, /--color-primary-500: #123456;/);
assert.match(css, /--font-size-base: 18px;/);
assert.match(css, /--space-8: 48px;/);
assert.match(css, /--radius-xl: 24px;/);

const clamped = tools.sanitizeSettings({ baseFont: 200, typeRatio: 3, baseSpacing: 0, baseRadius: -10 });
assert.equal(clamped.baseFont, 32);
assert.equal(clamped.typeRatio, 1.5);
assert.equal(clamped.baseSpacing, 2);
assert.equal(clamped.baseRadius, 0);
console.log('Design tools unit tests passed: WCAG contrast, palette generation, typography, spacing, radius and CSS token export.');
