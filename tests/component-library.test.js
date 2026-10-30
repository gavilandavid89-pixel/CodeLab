const assert = require('node:assert/strict');
const library = require('../public/component-library.js');
assert.equal(library.components.length, 8);
assert.equal(library.getComponent('hero').name, 'Hero de landing');
assert.equal(library.getComponent('unknown'), null);
assert.equal(library.searchComponents('dashboard').some(item => item.id === 'dashboard'), true);
assert.equal(library.searchComponents('', 'Navegación').length, 2);
assert.equal(library.searchComponents('formulario', 'Tarjetas').length, 0);
for (const component of library.components) {
  assert.ok(component.html.includes('<style>'), component.id + ' should carry preview styles');
  assert.ok(library.standaloneHtml(component).includes('<meta name="viewport"'), component.id + ' should export responsive HTML');
  assert.ok(library.standaloneHtml(component).includes(component.html));
}
assert.match(library.getComponent('contact').html, /label for=/i);
assert.match(library.getComponent('dashboard').html, /role="progressbar"/);
assert.equal(library.escapeHtml('<img src="x">'), '&lt;img src=&quot;x&quot;&gt;');
console.log('Component library tests passed: searchable catalog, category filters, responsive exports and accessible starter markup.');
