'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { exportDesignHtml, exportDesignSvg, exportDesignJson, importDesignJson, buildAiDesignCaptureContext } = require('./design-export');

function project(elements) {
  return {
    id: 'design-export-parity',
    type: 'design',
    name: 'Export parity',
    design: {
      canvasWidth: 720,
      canvasHeight: 1600,
      background: '#ffffff',
      layoutMode: 'free',
      elements
    }
  };
}

test('semantic HTML export omits hidden layers just like SVG rendering', () => {
  const html = exportDesignHtml(project([
    { id: 'visible-layer', type: 'text', text: 'Visible copy', x: 10, y: 10, width: 200, height: 40 },
    { id: 'hidden-layer', type: 'text', text: 'Secret hidden copy', visible: false, x: 10, y: 60, width: 200, height: 40 }
  ]));

  assert.match(html, /Visible copy/);
  assert.doesNotMatch(html, /Secret hidden copy/);
  assert.match(html, /layer-visible-layer/);
  assert.doesNotMatch(html, /layer-hidden-layer/);
});

test('AI capture context only describes visible layers and their layout', () => {
  const context = buildAiDesignCaptureContext({
    ...project([
      { id: 'hidden', type: 'text', text: 'not visible', visible: false, width: 200, height: 40 },
      { id: 'visible', type: 'text', text: 'visible', width: 120, height: 40 }
    ]),
    design: {
      ...project([]).design,
      layoutMode: 'auto',
      layoutDirection: 'row',
      layoutGap: 12,
      elements: [
        { id: 'hidden', type: 'text', text: 'not visible', visible: false, width: 200, height: 40 },
        { id: 'visible', type: 'text', text: 'visible', width: 120, height: 40 }
      ]
    }
  });

  assert.equal(context.elementCount, 1);
  assert.deepEqual(context.elements.map(element => element.id), ['visible']);
  assert.equal(context.elements[0].bounds.x, 0);
});

test('hidden layers do not consume auto-layout space in semantic HTML export', () => {
  const html = exportDesignHtml({
    ...project([
      { id: 'hidden-first', type: 'rectangle', visible: false, width: 180, height: 80 },
      { id: 'visible-second', type: 'rectangle', width: 120, height: 40 }
    ]),
    design: {
      ...project([]).design,
      layoutMode: 'auto',
      layoutDirection: 'row',
      layoutGap: 12,
      elements: [
        { id: 'hidden-first', type: 'rectangle', visible: false, width: 180, height: 80 },
        { id: 'visible-second', type: 'rectangle', width: 120, height: 40 }
      ]
    }
  });

  assert.doesNotMatch(html, /layer-hidden-first/);
  assert.match(html, /layer-visible-second/);
  assert.match(html, /left:auto;top:auto;flex:0 0 auto/);
});

test('semantic HTML export preserves same-origin relative image sources but blocks protocol-relative hosts', () => {
  const html = exportDesignHtml(project([
    { id: 'root-image', type: 'image', src: '/assets/hero.png', alt: 'Hero', x: 10, y: 10, width: 120, height: 80 },
    { id: 'dot-image', type: 'image', src: './assets/icon.png', alt: 'Icon', x: 10, y: 100, width: 80, height: 80 },
    { id: 'external-image', type: 'image', src: '//evil.example/track.png', alt: 'External', x: 10, y: 200, width: 80, height: 80 }
  ]));

  assert.match(html, /src="\/assets\/hero\.png"/);
  assert.match(html, /src="\.\/assets\/icon\.png"/);
  assert.doesNotMatch(html, /src="\/\/evil\.example\/track\.png"/);
});

test('hidden prototype navigation does not export an unreachable target screen', () => {
  const target = {
    id: 'target-screen',
    type: 'design',
    name: 'Target Screen',
    design: {
      canvasWidth: 720,
      canvasHeight: 1600,
      elements: [{ id: 'target-title', type: 'heading', text: 'Target screen content', width: 300, height: 60 }]
    }
  };
  const hiddenRoot = {
    ...project([{ id: 'hidden-nav', type: 'button', text: 'Next', visible: false, width: 120, height: 40 }]),
    design: {
      ...project([]).design,
      elements: [{ id: 'hidden-nav', type: 'button', text: 'Next', visible: false, width: 120, height: 40 }],
      flowConnections: [{ sourceElementId: 'hidden-nav', targetProjectId: 'target-screen' }]
    }
  };
  const hiddenHtml = exportDesignHtml(hiddenRoot, [hiddenRoot, target]);
  assert.doesNotMatch(hiddenHtml, /data-page-id="target-screen"/);
  assert.doesNotMatch(hiddenHtml, /Target screen content/);

  const visibleRoot = {
    ...hiddenRoot,
    design: {
      ...hiddenRoot.design,
      elements: [{ ...hiddenRoot.design.elements[0], visible: true }]
    }
  };
  const visibleHtml = exportDesignHtml(visibleRoot, [visibleRoot, target]);
  assert.match(visibleHtml, /data-page-id="target-screen"/);
  assert.match(visibleHtml, /Target screen content/);
});

test('semantic HTML export preserves safe rotation and opacity values', () => {
  const html = exportDesignHtml(project([
    { id: 'rotated-layer', type: 'rectangle', rotation: 15, opacity: 1, x: 10, y: 10, width: 100, height: 60 },
    { id: 'translucent-layer', type: 'text', text: 'Translucent', opacity: 0.4, x: 10, y: 90, width: 200, height: 40 }
  ]));

  assert.match(html, /transform:rotate\(15deg\);transform-origin:center center;/);
  assert.match(html, /opacity:0\.4;/);

  const context = buildAiDesignCaptureContext(project([
    { id: 'rotated-layer', type: 'rectangle', rotation: 15, opacity: 1, x: 10, y: 10, width: 100, height: 60 },
    { id: 'translucent-layer', type: 'text', text: 'Translucent', opacity: 0.4, x: 10, y: 90, width: 200, height: 40 }
  ]));
  assert.equal(context.elements.find(element => element.id === 'rotated-layer').style.rotation, 15);
  assert.equal(context.elements.find(element => element.id === 'translucent-layer').style.opacity, 0.4);
});

test('semantic HTML export and AI capture context use the editor font-size ceiling', () => {
  const input = project([
    { id: 'large-copy', type: 'text', text: 'Large', fontSize: 300, x: 10, y: 10, width: 200, height: 80 },
    { id: 'allowed-copy', type: 'text', text: 'Allowed', fontSize: 250, radius: 1200, x: 10, y: 100, width: 200, height: 80 }
  ]);
  const html = exportDesignHtml(input);
  const context = buildAiDesignCaptureContext(input);

  assert.match(html, /font-size:256px/);
  assert.equal(context.elements.find(element => element.id === 'large-copy').style.fontSize, 256);
  assert.match(html, /font-size:250px/);
  assert.equal(context.elements.find(element => element.id === 'allowed-copy').style.fontSize, 250);
  assert.match(html, /border-radius:1200px/);
  assert.equal(context.elements.find(element => element.id === 'allowed-copy').style.radius, 1200);
});

test('HTML and AI capture context clamp invalid transform ranges consistently', () => {
  const input = project([
    { id: 'clamped-layer', type: 'rectangle', rotation: 9999, opacity: 2, x: 10, y: 10, width: 100, height: 60 },
    { id: 'transparent-layer', type: 'text', text: 'Hidden by opacity', rotation: -9999, opacity: -1, x: 10, y: 90, width: 200, height: 40 }
  ]);
  const html = exportDesignHtml(input);
  const context = buildAiDesignCaptureContext(input);
  assert.match(html, /transform:rotate\(3600deg\);transform-origin:center center;/);
  assert.match(html, /opacity:1;/);
  assert.match(html, /transform:rotate\(-3600deg\);transform-origin:center center;/);
  assert.match(html, /opacity:0;/);
  assert.equal(context.elements.find(element => element.id === 'clamped-layer').style.rotation, 3600);
  assert.equal(context.elements.find(element => element.id === 'clamped-layer').style.opacity, 1);
  assert.equal(context.elements.find(element => element.id === 'transparent-layer').style.rotation, -3600);
  assert.equal(context.elements.find(element => element.id === 'transparent-layer').style.opacity, 0);
});

test('semantic HTML export preserves safe mailto and tel actions but rejects unsafe schemes', () => {
  const html = exportDesignHtml(project([
    { id: 'email', type: 'button', text: 'Email', href: 'mailto:hello@example.com?subject=Hello', x: 10, y: 10, width: 120, height: 40 },
    { id: 'phone', type: 'button', text: 'Call', href: 'tel:+1-555-123-4567', x: 10, y: 60, width: 120, height: 40 },
    { id: 'relative', type: 'button', text: 'Contact', href: '/contact', x: 10, y: 110, width: 120, height: 40 },
    { id: 'protocol-relative', type: 'button', text: 'External', href: '//evil.example/path', x: 10, y: 160, width: 120, height: 40 },
    { id: 'unsafe', type: 'button', text: 'Unsafe', href: 'javascript:alert(1)', x: 10, y: 210, width: 120, height: 40 }
  ]));

  assert.match(html, /href="mailto:hello@example\.com\?subject=Hello"/);
  assert.match(html, /href="tel:\+1-555-123-4567"/);
  const emailAnchor = html.match(/<a id="layer-email"[^>]*>/)?.[0] || '';
  const phoneAnchor = html.match(/<a id="layer-phone"[^>]*>/)?.[0] || '';
  assert.ok(emailAnchor);
  assert.ok(phoneAnchor);
  assert.doesNotMatch(emailAnchor, /target=/);
  assert.doesNotMatch(phoneAnchor, /target=/);
  assert.match(html, /href="\/contact"/);
  assert.doesNotMatch(html, /href="\/\/evil\.example/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /Unsafe/);
});


test('legacy hidden:true is omitted from HTML, SVG, capture, and auto-layout geometry', () => {
  const input = project([
    { id: 'legacy-hidden', type: 'rectangle', hidden: true, text: 'Legacy hidden', width: 180, height: 80, y: 1200 },
    { id: 'visible-after', type: 'rectangle', text: 'Visible after', width: 120, height: 40 }
  ]);
  const html = exportDesignHtml(input);
  const svg = exportDesignSvg(input);
  const context = buildAiDesignCaptureContext(input);
  assert.doesNotMatch(html, /Legacy hidden|layer-legacy-hidden/);
  assert.doesNotMatch(svg, /Legacy hidden|legacy-hidden/);
  assert.equal(context.elementCount, 1);
  assert.deepEqual(context.elements.map(item => item.id), ['visible-after']);

  const auto = {
    ...input,
    design: { ...input.design, layoutMode: 'auto', layoutDirection: 'column' }
  };
  const autoContext = buildAiDesignCaptureContext(auto);
  assert.equal(autoContext.elements[0].bounds.y, 0);
});

test('responsive width/height units resolve in free layout and remain CSS-responsive in auto layout', () => {
  const input = project([
    { id: 'responsive', type: 'rectangle', width: 50, widthUnit: '%', height: 25, heightUnit: '%', x: 0, y: 0 }
  ]);
  const html = exportDesignHtml(input);
  const context = buildAiDesignCaptureContext(input);
  assert.match(html, /width:360px;height:400px/);
  assert.equal(context.elements[0].bounds.width, 360);
  assert.equal(context.elements[0].bounds.height, 400);

  const mobile = {
    ...input,
    design: { ...input.design, canvasWidth: 390, canvasHeight: 844 }
  };
  const mobileHtml = exportDesignHtml(mobile);
  const mobileContext = buildAiDesignCaptureContext(mobile);
  assert.match(mobileHtml, /width:195px;height:211px/);
  assert.equal(mobileContext.elements[0].bounds.width, 195);
  assert.equal(mobileContext.elements[0].bounds.height, 211);

  const auto = {
    ...input,
    design: { ...input.design, layoutMode: 'auto', layoutDirection: 'column', layoutPadding: 24 }
  };
  const autoHtml = exportDesignHtml(auto);
  const autoContext = buildAiDesignCaptureContext(auto);
  assert.match(autoHtml, /width:50%;height:388px/);
  assert.equal(autoContext.elements[0].bounds.width, 336);
  assert.equal(autoContext.elements[0].bounds.height, 388);
});

test('JSON export/import round-trip preserves responsive units, layer metadata, and flow connections', () => {
  const input = {
    id: 'source-project',
    name: 'Responsive source',
    type: 'design',
    code: { html: '', css: '', js: '' },
    design: {
      ...project([]).design,
      elements: [
        {
          id: 'nav-layer', type: 'button', label: 'Next', text: 'Next', href: '#layer-content',
          x: 12, xUnit: '%', y: 20, yUnit: 'px',
          width: 50, widthUnit: '%', height: 48, heightUnit: 'auto',
          identifier: 'primary-next', opacity: 0.65, rotation: 12,
          visible: true, hidden: false, locked: true, flowRole: 'navigate'
        },
        { id: 'content', type: 'heading', text: 'Content', width: 300, height: 60, identifier: 'content' },
        { id: 'tiny-responsive', type: 'rectangle', width: 10, widthUnit: '%', height: 5, heightUnit: '%', identifier: 'tiny-responsive' }
      ],
      flowConnections: [{ sourceElementId: 'nav-layer', targetProjectId: 'target-screen' }]
    }
  };
  const exported = exportDesignJson(input);
  const imported = importDesignJson(exported.json, { idFactory: (() => {
    let index = 0;
    return () => 'imported-layer-' + (++index);
  })() });
  const button = imported.design.elements[0];
  assert.equal(button.xUnit, '%');
  assert.equal(button.yUnit, 'px');
  assert.equal(button.widthUnit, '%');
  assert.equal(button.heightUnit, 'auto');
  assert.equal(button.identifier, 'primary-next');
  assert.equal(button.opacity, 0.65);
  assert.equal(button.rotation, 12);
  assert.equal(button.visible, true);
  assert.equal(button.hidden, false);
  assert.equal(button.locked, true);
  assert.equal(button.flowRole, 'navigate');
  assert.equal(button.href, '#layer-imported-layer-2');
  assert.deepEqual(imported.design.flowConnections, [
    { sourceElementId: 'imported-layer-1', targetProjectId: 'target-screen' }
  ]);
  assert.equal(imported.design.elements[2].width, 10);
  assert.equal(imported.design.elements[2].height, 5);
  assert.equal(imported.design.elements[2].widthUnit, '%');
  assert.equal(imported.design.elements[2].heightUnit, '%');

  const secondExport = exportDesignJson(imported);
  const parsed = JSON.parse(secondExport.json);
  assert.equal(parsed.project.design.elements[0].widthUnit, '%');
  assert.equal(parsed.project.design.elements[0].heightUnit, 'auto');
  assert.equal(parsed.project.design.elements[0].identifier, 'primary-next');
  assert.equal(parsed.project.design.elements[2].width, 10);
  assert.equal(parsed.project.design.elements[2].height, 5);
  assert.equal(parsed.project.design.elements[2].widthUnit, '%');
  assert.equal(parsed.project.design.elements[2].heightUnit, '%');
  assert.deepEqual(parsed.project.design.flowConnections, [
    { sourceElementId: 'imported-layer-1', targetProjectId: 'target-screen' }
  ]);
});
