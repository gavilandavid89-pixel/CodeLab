const assert = require('node:assert/strict');
const capture = require('../public/capture.js');

const design = {
  name: 'Fixture IA',
  design: {
    frame: 'mobile',
    background: '#ffffff',
    elements: [
      { id: 'heading', type: 'heading', text: 'Hello <AI> & "friends"', x: 10, y: 20, width: 300, height: 70, fontSize: 28, color: '#111827', background: 'transparent', textAlign: 'left', weight: 700 },
      { id: 'center', type: 'text', text: 'Centered', x: 20, y: 110, width: 200, height: 40, fontSize: 16, color: '#334155', background: 'transparent', textAlign: 'center' },
      { id: 'right', type: 'text', text: 'Right', x: 20, y: 160, width: 200, height: 40, fontSize: 16, color: '#334155', background: 'transparent', textAlign: 'right' },
      { id: 'button', type: 'button', text: 'Continue', x: 20, y: 220, width: 180, height: 48, fontSize: 16, color: '#ffffff', background: '#6d28d9', radius: 8 },
      { id: 'rectangle', type: 'rectangle', x: 10, y: 290, width: 100, height: 60, background: '#e2e8f0', radius: 4 },
      { id: 'image', type: 'image', src: 'https://images.example.test/sample.png', alt: 'Sample photo', objectFit: 'contain', x: 12, y: 370, width: 180, height: 120, background: '#e2e8f0' }
    ]
  }
};
const mobile = capture.captureDesignSvg(design);
assert.equal(mobile.width, 390);
assert.equal(mobile.height, 900);
assert.match(mobile.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
assert.match(mobile.svg, /Hello &lt;AI&gt; &amp; &quot;friends&quot;/);
assert.match(mobile.svg, /fill="#6d28d9"/);
assert.match(mobile.svg, /width="100" height="60"/);
assert.match(mobile.svg, /<image href="https:\/\/images\.example\.test\/sample\.png"/, 'SVG capture should preserve safe image layers');
assert.match(mobile.svg, /preserveAspectRatio="xMidYMid meet"/, 'Image fit mode should be reflected in SVG capture');
assert.doesNotMatch(capture.captureDesignSvg({ design: { frame: 'mobile', elements: [{ type: 'image', src: 'javascript:alert(1)', x: 0, y: 0, width: 20, height: 20 }] } }).svg, /javascript:/i, 'Unsafe image sources must not be embedded in SVG');
assert.match(mobile.svg, /text-anchor="start"/);
assert.match(mobile.svg, /text-anchor="middle"/);
assert.match(mobile.svg, /text-anchor="end"/);
assert.match(capture.captureDesignSvg({ design: { frame: 'tablet', elements: [] } }).svg, /width="768"/);
assert.match(capture.captureDesignSvg({ design: { frame: 'desktop', elements: [] } }).svg, /width="1440"/);

const unsafe = '<h1 onclick="steal()">Hello</h1><script>alert(1)</script><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">bad</a><img src=javascript:alert(2)><form action=javascript:alert(3)><button formaction=" javascript:alert(4)">send</button></form>';
const safe = capture.sanitizeForCapture(unsafe);
assert.doesNotMatch(safe, /<script\b/i, 'Capture HTML must not execute inline scripts');
assert.doesNotMatch(safe, /<iframe\b/i, 'Embedded frames must be removed');
assert.doesNotMatch(safe, /onclick\s*=/i, 'Inline event handlers must be removed');
assert.doesNotMatch(safe, /javascript:/i, 'javascript: URLs must be neutralized');

const captureDocument = capture.buildCaptureDocument({
  viewport: 390,
  html: '<!doctype html><html><head><title>Page</title><link rel="stylesheet" href="/theme.css"></head><body><main><h1>Real page</h1></main><script>window.evil = true;</script></body></html>',
  css: 'main { color: purple; }'
});
assert.match(captureDocument, /<head>.*<title>Page<\/title>.*theme\.css.*<style>main \{ color: purple; \}<\/style>/s);
assert.match(captureDocument, /<body><main><h1>Real page<\/h1><\/main><!-- JavaScript omitido durante la captura segura --><\/body>/);
assert.doesNotMatch(captureDocument, /<html[^>]*>.*<body>.*<html/i, 'Full HTML documents must not be nested inside the body');

const webContext = capture.buildWebCaptureContext({
  project: { id: 'p1', name: 'Landing Demo' },
  viewport: 390,
  height: 900,
  scale: 3,
  html: '<!doctype html><html><head><title>Demo Page</title><meta name="description" content="A test page"></head><body><h1>Welcome</h1><h2>Features</h2><img alt="Preview" src="/preview.png"><a href="/docs">Docs</a><button>Start</button><form></form></body></html>',
  css: 'h1 { color: purple; }',
  js: 'document.querySelector("button").textContent = "Changed";'
});
assert.equal(webContext.format, 'codelab-ai-web-capture');
assert.equal(webContext.version, 2);
assert.equal(webContext.projectId, 'p1');
assert.equal(webContext.page.title, 'Demo Page');
assert.equal(webContext.page.description, 'A test page');
assert.deepEqual(webContext.page.headings, [{ level: 1, text: 'Welcome' }, { level: 2, text: 'Features' }]);
assert.deepEqual(webContext.page.counts, { images: 1, links: 1, buttons: 1, forms: 1, externalStylesheets: 0 });
assert.equal(webContext.viewport.width, 390);
assert.equal(webContext.viewport.scale, 3, 'Capture context must preserve selected resolution scale');
assert.equal(webContext.sourceCode.javascript, 'document.querySelector("button").textContent = "Changed";');
assert.equal(webContext.page.javascriptIncludedInScreenshot, false);
assert.match(webContext.aiInstructions, /JavaScript/);
console.log('AI capture tests passed: design SVG, responsive sizes, safe HTML isolation, web metadata and source context.');
