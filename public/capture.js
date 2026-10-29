(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.CodeLabCapture = api;
    if (typeof document !== 'undefined') {
      root.captureDesignSvg = api.captureDesignSvg;
      root.captureDesignForAI = api.captureDesignForAI;
      root.captureWebForAI = api.captureWebForAI;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', api.installWebCaptureControls, { once: true });
      else api.installWebCaptureControls();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function xmlEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function safeColor(value) {
    const color = String(value || 'transparent').trim();
    return /^(#[0-9a-f]{3,8}|transparent|[a-z]{1,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(color) ? color : 'transparent';
  }

  function captureDesignSvg(project) {
    const design = project && project.design ? project.design : {};
    const width = ({ desktop: 1440, tablet: 768, mobile: 390 })[design.frame] || 1440;
    const height = 900;
    const items = (Array.isArray(design.elements) ? design.elements : []).map(function (el) {
      const x = Number(el.x) || 0, y = Number(el.y) || 0;
      const w = Math.max(20, Number(el.width) || 120), h = Math.max(20, Number(el.height) || 48);
      const fontSize = Math.max(8, Number(el.fontSize) || 16);
      const radius = Math.max(0, Number(el.radius) || 0);
      const background = safeColor(el.background);
      const color = safeColor(el.color || '#111827');
      const rect = background !== 'transparent'
        ? '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + radius + '" fill="' + xmlEscape(background) + '"/>'
        : '';
      if (el.type === 'rectangle') return rect || '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + radius + '" fill="none" stroke="#cbd5e1"/>';
      const lines = String(el.text || '').split(/\r?\n/);
      const align = el.type === 'button' ? 'center' : (['left', 'center', 'right'].includes(el.textAlign) ? el.textAlign : 'left');
      const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
      const textX = align === 'left' ? x + 6 : align === 'right' ? x + w - 6 : x + w / 2;
      const lineHeight = el.type === 'heading' ? fontSize * 1.1 : fontSize * 1.25;
      const startY = y + Math.max(fontSize, (h - lines.length * lineHeight) / 2 + fontSize * 0.82);
      const tspans = lines.map(function (line, i) {
        return '<tspan x="' + textX + '" y="' + (startY + i * lineHeight) + '">' + xmlEscape(line) + '</tspan>';
      }).join('');
      return rect + '<text x="' + textX + '" y="' + startY + '" fill="' + xmlEscape(color) + '" font-family="Arial, Helvetica, sans-serif" font-size="' + fontSize + '" font-weight="' + Math.max(100, Number(el.weight) || 400) + '" text-anchor="' + anchor + '">' + tspans + '</text>';
    }).join('');
    return {
      width: width,
      height: height,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"><rect width="100%" height="100%" fill="' + xmlEscape(safeColor(design.background || '#ffffff')) + '"/>' + items + '</svg>'
    };
  }

  function sanitizeForCapture(html) {
    return String(html || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '<!-- JavaScript omitido durante la captura segura -->')
      .replace(/<(iframe|object|embed|portal)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(iframe|object|embed|portal)\b[^>]*\/?>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, ' $1="#"')
      .replace(/<base\b[^>]*>/gi, '');
  }

  function buildCaptureDocument(input) {
    const html = sanitizeForCapture(input.html || '');
    const css = String(input.css || '').replace(/<\/style/gi, '<\\/style');
    const viewport = Math.max(320, Math.min(1920, Number(input.viewport) || 1280));
    const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);
    const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
    const head = headMatch ? headMatch[1] : '';
    let body = bodyMatch ? bodyMatch[1] : html;
    if (!bodyMatch) body = body.replace(/<!doctype[^>]*>|<\/?html\b[^>]*>|<\/?head\b[^>]*>|<\/?body\b[^>]*>/gi, '');
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=' + viewport + ', initial-scale=1">' + head + '<style>' + css + '</style></head><body>' + body + '</body></html>';
  }

  function buildWebCaptureContext(input) {
    const project = input.project || {};
    const html = String(input.html || '');
    const css = String(input.css || '');
    const js = String(input.js || '');
    const viewport = Number(input.viewport) || 1280;
    const title = (html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || project.name || 'Página sin título';
    const description = (html.match(/<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i) || [])[1] || '';
    const headings = [];
    const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
    let match;
    while ((match = headingPattern.exec(html)) && headings.length < 80) {
      headings.push({ level: Number(match[1]), text: match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) });
    }
    const imageCount = (html.match(/<img\b/gi) || []).length;
    const linkCount = (html.match(/<a\b/gi) || []).length;
    const buttonCount = (html.match(/<button\b/gi) || []).length;
    const formCount = (html.match(/<form\b/gi) || []).length;
    const externalCss = (html.match(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi) || []).length;
    return {
      format: 'codelab-ai-web-capture',
      version: 2,
      project: String(project.name || 'Página sin título'),
      projectId: project.id || null,
      capturedAt: new Date().toISOString(),
      viewport: { width: viewport, height: Math.min(Math.max(Number(input.height) || 900, 320), 6000), scale: 2 },
      page: {
        title: title.replace(/<[^>]+>/g, '').trim().slice(0, 300),
        description: String(description).slice(0, 500),
        headings: headings,
        counts: { images: imageCount, links: linkCount, buttons: buttonCount, forms: formCount, externalStylesheets: externalCss },
        sourceLengths: { html: html.length, css: css.length, javascript: js.length },
        javascriptIncludedInScreenshot: false,
        screenshotNote: 'La captura renderiza HTML y CSS en un iframe aislado sin ejecutar JavaScript ni contenido embebido. El código JS se adjunta como contexto para revisión, pero sus efectos en tiempo de ejecución no aparecen en la imagen.'
      },
      sourceCode: { html: html, css: css, javascript: js },
      aiInstructions: 'Analiza el PNG como evidencia visual de la página renderizada y utiliza este JSON para entender su estructura y el código fuente. El JavaScript no se ejecutó en el render aislado por seguridad: no atribuyas a la imagen estados dinámicos que no sean visibles. Distingue problemas observados de sugerencias, revisa accesibilidad, responsive y recursos ausentes. Propón cambios concretos con selectores y código cuando sea útil.'
    };
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function safeSlug(value) {
    return String(value || 'codelab').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'codelab';
  }

  function toast(message, kind) {
    if (typeof window.showToast === 'function') window.showToast(message, kind || 'info');
    else console[kind === 'warn' ? 'warn' : 'log'](message);
  }

  async function loadHtml2Canvas() {
    if (typeof window.html2canvas === 'function') return window.html2canvas;
    await new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('No se pudo cargar el motor de captura. Comprueba la conexión e inténtalo de nuevo.')); };
      document.head.appendChild(script);
    });
    if (typeof window.html2canvas !== 'function') throw new Error('El motor de captura no está disponible.');
    return window.html2canvas;
  }

  function getProjectCode(project) {
    const html = typeof window.getEditorValue === 'function' ? window.getEditorValue('html') : project.code && project.code.html;
    const css = typeof window.getEditorValue === 'function' ? window.getEditorValue('css') : project.code && project.code.css;
    const js = typeof window.getEditorValue === 'function' ? window.getEditorValue('js') : project.code && project.code.js;
    return { html: String(html || ''), css: String(css || ''), js: String(js || '') };
  }

  async function captureWebForAI() {
    const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : null;
    if (!project || project.type === 'design') {
      toast('Abre un proyecto de página web para capturarlo.', 'warn');
      return;
    }
    const controls = document.getElementById('webCaptureViewport');
    const viewport = Math.max(320, Math.min(1920, Number(controls && controls.value) || 1280));
    const code = getProjectCode(project);
    const slug = safeSlug(project.name);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + viewport + 'px;height:900px;border:0;visibility:hidden;pointer-events:none;';
    const source = buildCaptureDocument({ html: code.html, css: code.css, viewport: viewport });
    const context = buildWebCaptureContext({ project: project, html: code.html, css: code.css, js: code.js, viewport: viewport, height: 900 });
    let captureDoc;
    let timeoutId;
    try {
      toast('Preparando captura aislada de la página…');
      document.body.appendChild(iframe);
      await new Promise(function (resolve, reject) {
        timeoutId = setTimeout(function () { reject(new Error('La página tardó demasiado en renderizarse.')); }, 12000);
        iframe.onload = resolve;
        iframe.srcdoc = source;
      });
      captureDoc = iframe.contentDocument;
      if (!captureDoc || !captureDoc.documentElement) throw new Error('No se pudo leer el render aislado.');
      const root = captureDoc.documentElement;
      const body = captureDoc.body;
      const height = Math.min(6000, Math.max(900, body.scrollHeight, root.scrollHeight, body.offsetHeight, root.offsetHeight));
      iframe.style.height = height + 'px';
      context.viewport.height = height;
      const headings = Array.from(captureDoc.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 80).map(function (node) {
        return { tag: node.tagName.toLowerCase(), text: (node.innerText || node.textContent || '').trim().slice(0, 300) };
      });
      context.renderedPage = {
        documentHeight: height,
        headings: headings,
        images: Array.from(captureDoc.images).slice(0, 100).map(function (img) {
          return { alt: img.alt || '', src: img.currentSrc || img.src || '', loaded: !!(img.complete && img.naturalWidth > 0), width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
        }),
        landmarks: Array.from(captureDoc.querySelectorAll('header,nav,main,footer,section,article,form')).slice(0, 100).map(function (node) {
          return { tag: node.tagName.toLowerCase(), label: (node.getAttribute('aria-label') || node.getAttribute('role') || '').slice(0, 120) };
        })
      };
      context.page.javascriptIncludedInScreenshot = false;
      context.page.screenshotNote += ' Se eliminaron scripts, iframes y objetos incrustados y se neutralizaron manejadores inline durante la captura.';
      const html2canvas = await loadHtml2Canvas();
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
      const canvas = await html2canvas(root, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
        width: viewport,
        windowWidth: viewport,
        height: height,
        windowHeight: Math.min(height, 6000),
        scrollX: 0,
        scrollY: 0
      });
      const png = await new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('El navegador no pudo generar el PNG.')); }, 'image/png');
      });
      downloadBlob(slug + '-captura-ia.png', png);
      downloadBlob(slug + '-contexto-ia.json', new Blob([JSON.stringify(context, null, 2)], { type: 'application/json;charset=utf-8' }));
      toast('Captura web lista: PNG renderizado + contexto y código fuente en JSON.');
    } catch (error) {
      const contextBlob = new Blob([JSON.stringify(context, null, 2)], { type: 'application/json;charset=utf-8' });
      downloadBlob(slug + '-contexto-ia.json', contextBlob);
      toast('No se pudo completar el PNG: ' + (error && error.message ? error.message : 'error de captura') + '. Descargué el contexto JSON.', 'warn');
    } finally {
      clearTimeout(timeoutId);
      if (iframe.isConnected) iframe.remove();
    }
  }

  async function captureDesignForAI() {
    const project = typeof window.activeDesignProject === 'function' ? window.activeDesignProject() : null;
    if (!project || !project.design) {
      toast('Abre un proyecto de diseño primero.', 'warn');
      return;
    }
    const captured = captureDesignSvg(project);
    const slug = safeSlug(project.name);
    const elements = (project.design.elements || []).map(function (el, index) {
      return {
        order: index + 1, id: el.id || null, type: el.type || 'text', label: el.label || el.type || 'Elemento',
        text: el.text || '', bounds: { x: Number(el.x) || 0, y: Number(el.y) || 0, width: Math.max(20, Number(el.width) || 120), height: Math.max(20, Number(el.height) || 48) },
        style: { color: el.color || '#111827', background: el.background || 'transparent', fontSize: Number(el.fontSize) || 16, fontWeight: Number(el.weight) || 400, radius: Number(el.radius) || 0, textAlign: ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left' }
      };
    });
    const context = {
      format: 'codelab-ai-design-capture', version: 2, project: project.name || 'Diseño sin título',
      frame: project.design.frame || 'desktop', image: slug + '-captura-ia.png',
      canvas: { width: captured.width, height: captured.height, background: project.design.background || '#ffffff' },
      elementCount: elements.length, elements: elements,
      aiInstructions: 'Analiza el PNG para evaluar la apariencia visual y usa este JSON para conocer posiciones, dimensiones, textos y estilos exactos. No inventes contenido. Distingue problemas observables de sugerencias y considera accesibilidad y adaptación móvil.'
    };
    downloadBlob(slug + '-contexto-ia.json', new Blob([JSON.stringify(context, null, 2)], { type: 'application/json;charset=utf-8' }));
    try {
      const image = new Image();
      const svgUrl = URL.createObjectURL(new Blob([captured.svg], { type: 'image/svg+xml;charset=utf-8' }));
      await new Promise(function (resolve, reject) { image.onload = resolve; image.onerror = reject; image.src = svgUrl; });
      const canvas = document.createElement('canvas');
      canvas.width = captured.width * 2; canvas.height = captured.height * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No se pudo crear el contexto gráfico.');
      ctx.scale(2, 2); ctx.drawImage(image, 0, 0, captured.width, captured.height); URL.revokeObjectURL(svgUrl);
      const png = await new Promise(function (resolve, reject) { canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('No se pudo generar el PNG.')); }, 'image/png'); });
      downloadBlob(slug + '-captura-ia.png', png);
      toast('Captura IA lista: PNG 2× y contexto JSON.');
    } catch (error) {
      downloadBlob(slug + '-captura-ia.svg', new Blob([captured.svg], { type: 'image/svg+xml;charset=utf-8' }));
      toast('El PNG falló; descargué SVG y contexto JSON.', 'warn');
    }
  }

  function installWebCaptureControls() {
    const preview = document.getElementById('previewPanel');
    const toolbar = preview && preview.querySelector('.bg-slate-900.px-3.py-1\\.5');
    if (!toolbar || document.getElementById('webCaptureBtn')) return;
    const controls = document.createElement('div');
    controls.className = 'flex items-center gap-1.5';
    controls.innerHTML = '<label class="sr-only" for="webCaptureViewport">Ancho de captura</label><select id="webCaptureViewport" title="Ancho de la captura" class="max-w-[105px] bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-300"><option value="1280">Desktop</option><option value="768">Tablet</option><option value="390">Móvil</option></select><button id="webCaptureBtn" type="button" title="Descargar captura visual y contexto para IA" class="rounded bg-violet-600 hover:bg-violet-500 px-2 py-1 text-[10px] font-semibold text-white whitespace-nowrap"><i class="fa-solid fa-camera mr-1"></i>Captura IA</button>';
    toolbar.appendChild(controls);
    const button = document.getElementById('webCaptureBtn');
    if (button) button.addEventListener('click', captureWebForAI);
  }

  return {
    xmlEscape: xmlEscape,
    captureDesignSvg: captureDesignSvg,
    sanitizeForCapture: sanitizeForCapture,
    buildWebCaptureContext: buildWebCaptureContext,
    buildCaptureDocument: buildCaptureDocument,
    captureDesignForAI: captureDesignForAI,
    captureWebForAI: captureWebForAI,
    installWebCaptureControls: installWebCaptureControls
  };
});