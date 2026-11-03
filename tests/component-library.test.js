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



const fragment = '<section id="inserted-component">Component</section>';
testInsertionBeforeRealBodyClose();

function testInsertionBeforeRealBodyClose() {
  const source = '<!doctype html><html><body><!-- fake </body> -->' +
    '<script>const marker = "</body>";</script>' +
    '<style>.example::after{content:"</body>"}</style>' +
    '<div data-example="</body>">Existing</div></body></html>';
  const inserted = library.insertComponentHtml(source, fragment);
  const realClose = source.lastIndexOf('</body>');
  assert.equal(inserted.indexOf(fragment), realClose);
  assert.ok(inserted.includes('<!-- fake </body> -->'));
  assert.ok(inserted.includes('const marker = "</body>";'));
  assert.ok(inserted.includes('content:"</body>"'));
  assert.ok(inserted.includes('data-example="</body>"'));
  assert.ok(inserted.endsWith(fragment + '\n</body></html>'));
}

{
  for (const tag of ['textarea', 'title', 'iframe', 'xmp', 'noembed', 'noframes']) {
    const source = '<html><body><' + tag + '>embedded </body> text</' + tag + '><p>Existing</p></body></html>';
    const inserted = library.insertComponentHtml(source, fragment);
    assert.equal(inserted.indexOf(fragment), source.lastIndexOf('</body>'), tag + ' content must not be mistaken for the body close');
    assert.ok(inserted.includes('embedded </body> text'), tag + ' content should remain unchanged');
  }
}

{
  const source = '<html><body>1 < 3 and 4 > 2; keep this text</body></html>';
  const inserted = library.insertComponentHtml(source, fragment);
  assert.equal(inserted.indexOf(fragment), source.lastIndexOf('</body>'));
  assert.ok(inserted.includes('1 < 3 and 4 > 2; keep this text'));
}

{
  const source = '<html><body>Existing</BODY ></html>';
  const inserted = library.insertComponentHtml(source, fragment);
  assert.ok(inserted.endsWith('Existing' + fragment + '\n</BODY ></html>'));
}

{
  const source = '<main>Fragment without body close</main>';
  assert.equal(library.insertComponentHtml(source, fragment), source + '\n' + fragment);
}


{
  const source = '<html><body><plaintext>embedded </body> text</plaintext></html>';
  assert.equal(library.insertComponentHtml(source, fragment), source + '\n' + fragment,
    'plaintext consumes the rest of the document, so its fake body close must not be used');
}

{
  const source = '<html><body><template><section>fake </body></section></template><p>Real body</p></body></html>';
  assert.equal(library.insertComponentHtml(source, fragment).indexOf(fragment), source.lastIndexOf('</body>'),
    'template contents must not be treated as active document body markup');
}

{
  const source = '<html><body><template><template><p>nested </body></p></template></template><p>Real body</p></body></html>';
  assert.equal(library.insertComponentHtml(source, fragment).indexOf(fragment), source.lastIndexOf('</body>'),
    'nested template contents must be skipped as a unit');
}

{
  const source = '<html><body><template><p>incomplete </body>';
  assert.equal(library.insertComponentHtml(source, fragment), source + '\n' + fragment,
    'an unclosed template must use the append fallback');
}

console.log('Component library tests passed: searchable catalog, category filters, responsive exports, accessible markup, and HTML insertion edge cases.');
