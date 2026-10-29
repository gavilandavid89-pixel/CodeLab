(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.CodeLabDesignTools = api;
    if (typeof document !== 'undefined') {
      const start = () => api.init();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const STORAGE_KEY = 'codelab-design-system-v1';
  const DEFAULTS = Object.freeze({
    name: 'Mi sistema visual',
    primary: '#06b6d4',
    secondary: '#2563eb',
    accent: '#a855f7',
    surface: '#0f172a',
    background: '#020617',
    text: '#f8fafc',
    contrastForeground: '#f8fafc',
    contrastBackground: '#020617',
    baseFont: 16,
    typeRatio: 1.25,
    baseSpacing: 4,
    baseRadius: 12
  });

  function normalizeHex(value, fallback) {
    let hex = String(value || '').trim();
    if (!hex.startsWith('#')) hex = '#' + hex;
    if (/^#[0-9a-f]{3}$/i.test(hex)) hex = '#' + hex.slice(1).split('').map(c => c + c).join('');
    return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : (fallback || '#000000');
  }

  function hexToRgb(value) {
    const hex = normalizeHex(value);
    return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
  }

  function channelLuminance(channel) {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(color) {
    const rgb = hexToRgb(color);
    return 0.2126 * channelLuminance(rgb.r) + 0.7152 * channelLuminance(rgb.g) + 0.0722 * channelLuminance(rgb.b);
  }

  function contrastRatio(foreground, background) {
    const a = relativeLuminance(foreground), b = relativeLuminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function mixColors(color, target, amount) {
    const a = hexToRgb(color), b = hexToRgb(target);
    const mix = key => Math.round(a[key] + (b[key] - a[key]) * amount).toString(16).padStart(2, '0');
    return '#' + mix('r') + mix('g') + mix('b');
  }

  function generatePalette(primary) {
    const base = normalizeHex(primary, DEFAULTS.primary);
    const shades = [
      { step: 50, color: mixColors(base, '#ffffff', 0.92) },
      { step: 100, color: mixColors(base, '#ffffff', 0.82) },
      { step: 200, color: mixColors(base, '#ffffff', 0.64) },
      { step: 300, color: mixColors(base, '#ffffff', 0.42) },
      { step: 400, color: mixColors(base, '#ffffff', 0.2) },
      { step: 500, color: base },
      { step: 600, color: mixColors(base, '#000000', 0.15) },
      { step: 700, color: mixColors(base, '#000000', 0.3) },
      { step: 800, color: mixColors(base, '#000000', 0.45) },
      { step: 900, color: mixColors(base, '#000000', 0.6) }
    ];
    return shades;
  }

  function sanitizeSettings(input) {
    const s = Object.assign({}, DEFAULTS, input || {});
    ['primary', 'secondary', 'accent', 'surface', 'background', 'text', 'contrastForeground', 'contrastBackground'].forEach(key => {
      s[key] = normalizeHex(s[key], DEFAULTS[key]);
    });
    s.name = String(s.name || DEFAULTS.name).trim().slice(0, 80) || DEFAULTS.name;
    s.baseFont = Math.min(32, Math.max(10, Number(s.baseFont) || DEFAULTS.baseFont));
    s.typeRatio = Math.min(1.5, Math.max(1.1, Number(s.typeRatio) || DEFAULTS.typeRatio));
    s.baseSpacing = Math.min(16, Math.max(2, Number(s.baseSpacing) || DEFAULTS.baseSpacing));
    s.baseRadius = Math.min(32, Math.max(0, Number(s.baseRadius) || 0));
    return s;
  }

  function buildDesignTokens(input) {
    const s = sanitizeSettings(input);
    const typeSteps = [-2, -1, 0, 1, 2, 3, 4].map(step => ({
      name: step < 0 ? 'xs'.repeat(Math.abs(step)) : step === 0 ? 'base' : 'xl'.repeat(step),
      step: step,
      px: Math.round(s.baseFont * Math.pow(s.typeRatio, step) * 100) / 100
    }));
    const spacing = Array.from({ length: 8 }, (_, i) => ({ name: 'space-' + (i + 1), px: s.baseSpacing * (i + 1) }));
    return {
      format: 'codelab-design-system',
      version: 1,
      name: s.name,
      colors: {
        primary: s.primary, secondary: s.secondary, accent: s.accent,
        surface: s.surface, background: s.background, text: s.text,
        primaryScale: generatePalette(s.primary)
      },
      typography: { baseFontPx: s.baseFont, ratio: s.typeRatio, scale: typeSteps },
      spacing: spacing,
      radius: [
        { name: 'radius-sm', px: Math.round(s.baseRadius * 0.33) },
        { name: 'radius-md', px: Math.round(s.baseRadius * 0.66) },
        { name: 'radius-lg', px: s.baseRadius },
        { name: 'radius-xl', px: s.baseRadius * 2 }
      ],
      accessibility: {
        foreground: s.contrastForeground,
        background: s.contrastBackground,
        contrastRatio: Math.round(contrastRatio(s.contrastForeground, s.contrastBackground) * 100) / 100
      }
    };
  }

  function toCssVariables(input) {
    const tokens = buildDesignTokens(input);
    const lines = [':root {'];
    Object.keys(tokens.colors).filter(key => key !== 'primaryScale').forEach(key => lines.push('  --color-' + key + ': ' + tokens.colors[key] + ';'));
    tokens.colors.primaryScale.forEach(item => lines.push('  --color-primary-' + item.step + ': ' + item.color + ';'));
    tokens.typography.scale.forEach(item => lines.push('  --font-size-' + item.name + ': ' + item.px + 'px;'));
    tokens.spacing.forEach(item => lines.push('  --' + item.name + ': ' + item.px + 'px;'));
    tokens.radius.forEach(item => lines.push('  --' + item.name + ': ' + item.px + 'px;'));
    lines.push('}', '');
    return lines.join('\n');
  }

  function loadSavedSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return sanitizeSettings(saved ? JSON.parse(saved) : DEFAULTS);
    } catch (_) {
      return sanitizeSettings(DEFAULTS);
    }
  }

  function saveSettings(input) {
    const s = sanitizeSettings(input);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      return true;
    } catch (_) {
      return false;
    }
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function init() {
    if (typeof document === 'undefined' || document.getElementById('designToolsModal')) return;
    const modal = document.getElementById('designToolsModal');
    if (!modal) return;
    let settings = loadSavedSettings();
    let activeTab = 'palette';

    const get = id => document.getElementById(id);
    const fieldIds = ['systemName', 'colorPrimary', 'colorSecondary', 'colorAccent', 'colorSurface', 'colorBackground', 'colorText', 'contrastForeground', 'contrastBackground', 'baseFont', 'typeRatio', 'baseSpacing', 'baseRadius'];
    const readForm = () => {
      const values = Object.assign({}, settings);
      fieldIds.forEach(id => {
        const el = get(id);
        if (!el) return;
        const key = ({
          systemName: 'name', colorPrimary: 'primary', colorSecondary: 'secondary', colorAccent: 'accent',
          colorSurface: 'surface', colorBackground: 'background', colorText: 'text',
          contrastForeground: 'contrastForeground', contrastBackground: 'contrastBackground',
          baseFont: 'baseFont', typeRatio: 'typeRatio', baseSpacing: 'baseSpacing', baseRadius: 'baseRadius'
        })[id];
        values[key] = el.type === 'number' ? Number(el.value) : el.value;
      });
      return sanitizeSettings(values);
    };

    function renderPalette() {
      const host = get('designPalettePreview');
      if (!host) return;
      const shades = generatePalette(settings.primary);
      host.innerHTML = shades.map(item => '<button type="button" class="min-w-0 text-left group" data-palette-color="' + item.color + '" title="Copiar ' + item.color + '"><span class="block h-8 sm:h-10 rounded-lg border border-white/10" style="background:' + item.color + '"></span><span class="block mt-1 text-[9px] sm:text-[10px] text-slate-400">' + item.step + '</span><span class="block text-[8px] sm:text-[10px] font-mono text-slate-500">' + item.color + '</span></button>').join('');
      host.querySelectorAll('[data-palette-color]').forEach(button => button.addEventListener('click', async () => {
        const color = button.getAttribute('data-palette-color');
        const primary = get('colorPrimary');
        if (primary) primary.value = color;
        settings = sanitizeSettings(Object.assign({}, readForm(), { primary: color }));
        renderAll();
        announce('Tono ' + color + ' seleccionado.');
      }));
    }

    function renderContrast() {
      const ratio = contrastRatio(settings.contrastForeground, settings.contrastBackground);
      const rounded = ratio.toFixed(2);
      const normalAA = ratio >= 4.5, largeAA = ratio >= 3, normalAAA = ratio >= 7;
      const result = get('contrastResult');
      if (result) {
        result.innerHTML = '<div class="flex items-center justify-between gap-2"><span class="text-xs text-slate-400">Relación de contraste</span><strong class="text-xl font-black tabular-nums">' + rounded + ':1</strong></div>' +
          '<div class="grid grid-cols-3 gap-2 mt-3">' +
          contrastBadge('AA texto normal', normalAA) + contrastBadge('AA texto grande', largeAA) + contrastBadge('AAA normal', normalAAA) + '</div>';
      }
      const sample = get('contrastSample');
      if (sample) {
        sample.style.color = settings.contrastForeground;
        sample.style.backgroundColor = settings.contrastBackground;
      }
    }

    function contrastBadge(label, pass) {
      return '<div class="rounded-lg border p-2 ' + (pass ? 'border-emerald-700 bg-emerald-950/40 text-emerald-300' : 'border-rose-800 bg-rose-950/40 text-rose-300') + '"><span class="block text-[10px] font-semibold">' + label + '</span><strong class="text-xs">' + (pass ? 'Cumple' : 'No cumple') + '</strong></div>';
    }

    function renderTokens() {
      const tokens = buildDesignTokens(settings);
      const typeHost = get('typeScalePreview');
      if (typeHost) typeHost.innerHTML = tokens.typography.scale.map(item =>
        '<div class="flex items-baseline justify-between gap-3 border-b border-slate-800 py-1.5"><span style="font-size:' + item.px + 'px" class="font-semibold text-slate-100">Aa</span><span class="text-[10px] font-mono text-slate-400">--font-size-' + item.name + ': ' + item.px + 'px</span></div>'
      ).join('');
      const spacingHost = get('spacingPreview');
      if (spacingHost) spacingHost.innerHTML = tokens.spacing.map(item =>
        '<div class="flex items-center gap-2 text-[10px] text-slate-400"><span class="w-14 font-mono">' + item.name + '</span><span class="h-2 rounded bg-cyan-500" style="width:' + Math.min(160, item.px * 3) + 'px"></span><span>' + item.px + 'px</span></div>'
      ).join('');
      const css = get('designTokensCss');
      if (css) css.value = toCssVariables(settings);
      const json = get('designTokensJson');
      if (json) json.value = JSON.stringify(tokens, null, 2);
    }

    function renderPreview() {
      const preview = get('designSystemLivePreview');
      if (!preview) return;
      preview.style.background = settings.background;
      preview.style.color = settings.text;
      const surface = get('designPreviewSurface');
      if (surface) surface.style.background = settings.surface;
      const title = get('designPreviewTitle');
      if (title) title.style.color = settings.text;
      ['designPreviewPrimary', 'designPreviewSecondary', 'designPreviewAccent'].forEach((id, i) => {
        const el = get(id);
        if (el) el.style.background = [settings.primary, settings.secondary, settings.accent][i];
      });
    }

    function renderAll() {
      renderPalette();
      renderContrast();
      renderTokens();
      renderPreview();
    }

    function announce(message) {
      const status = get('designToolsStatus');
      if (status) status.textContent = message;
    }

    function fillForm() {
      const map = {
        systemName: 'name', colorPrimary: 'primary', colorSecondary: 'secondary', colorAccent: 'accent',
        colorSurface: 'surface', colorBackground: 'background', colorText: 'text',
        contrastForeground: 'contrastForeground', contrastBackground: 'contrastBackground',
        baseFont: 'baseFont', typeRatio: 'typeRatio', baseSpacing: 'baseSpacing', baseRadius: 'baseRadius'
      };
      Object.keys(map).forEach(id => { if (get(id)) get(id).value = settings[map[id]]; });
    }

    function showTab(tab) {
      activeTab = tab;
      ['palette', 'accessibility', 'tokens'].forEach(name => {
        const panel = get('designToolsPanel-' + name);
        const button = get('designToolsTab-' + name);
        if (panel) panel.classList.toggle('hidden', name !== activeTab);
        if (button) {
          button.setAttribute('aria-selected', String(name === activeTab));
          button.classList.toggle('bg-cyan-500/15', name === activeTab);
          button.classList.toggle('text-cyan-300', name === activeTab);
          button.classList.toggle('text-slate-400', name !== activeTab);
        }
      });
    }

    function open() {
      settings = loadSavedSettings();
      fillForm();
      renderAll();
      showTab(activeTab);
      modal.classList.remove('hidden');
      document.body.classList.add('overflow-hidden');
      const close = get('closeDesignTools');
      if (close) close.focus();
    }

    function close() {
      modal.classList.add('hidden');
      document.body.classList.remove('overflow-hidden');
      const opener = get('openDesignTools');
      if (opener) opener.focus();
    }

    fieldIds.forEach(id => {
      const el = get(id);
      if (!el) return;
      el.addEventListener('input', () => {
        settings = readForm();
        renderAll();
        announce('Cambios sin guardar.');
      });
      el.addEventListener('change', () => {
        settings = readForm();
        renderAll();
      });
    });

    ['palette', 'accessibility', 'tokens'].forEach(tab => {
      const button = get('designToolsTab-' + tab);
      if (button) button.addEventListener('click', () => showTab(tab));
    });

    if (get('openDesignTools')) get('openDesignTools').addEventListener('click', open);
    if (get('closeDesignTools')) get('closeDesignTools').addEventListener('click', close);
    if (get('designToolsCloseFooter')) get('designToolsCloseFooter').addEventListener('click', close);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) close(); });

    if (get('saveDesignSystem')) get('saveDesignSystem').addEventListener('click', () => {
      settings = readForm();
      const ok = saveSettings(settings);
      announce(ok ? 'Sistema guardado en este navegador.' : 'No se pudo guardar; exporta el JSON para conservarlo.');
    });
    if (get('resetDesignSystem')) get('resetDesignSystem').addEventListener('click', () => {
      settings = sanitizeSettings(DEFAULTS);
      fillForm();
      renderAll();
      announce('Valores predeterminados restaurados. Guarda para conservarlos.');
    });
    if (get('exportDesignSystemCss')) get('exportDesignSystemCss').addEventListener('click', () => {
      settings = readForm();
      downloadText('codelab-design-tokens.css', toCssVariables(settings), 'text/css;charset=utf-8');
      announce('CSS de variables descargado.');
    });
    if (get('exportDesignSystemJson')) get('exportDesignSystemJson').addEventListener('click', () => {
      settings = readForm();
      downloadText('codelab-design-system.json', JSON.stringify(buildDesignTokens(settings), null, 2), 'application/json;charset=utf-8');
      announce('Sistema visual JSON descargado.');
    });
    if (get('copyDesignSystemCss')) get('copyDesignSystemCss').addEventListener('click', async () => {
      settings = readForm();
      const css = toCssVariables(settings);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(css);
        else throw new Error('clipboard unavailable');
        announce('CSS copiado al portapapeles.');
      } catch (_) {
        const area = get('designTokensCss');
        if (area) { area.focus(); area.select(); document.execCommand('copy'); announce('CSS seleccionado para copiar manualmente.'); }
      }
    });

    fillForm();
    renderAll();
    showTab(activeTab);
  }

  return {
    defaults: DEFAULTS,
    normalizeHex: normalizeHex,
    contrastRatio: contrastRatio,
    generatePalette: generatePalette,
    buildDesignTokens: buildDesignTokens,
    toCssVariables: toCssVariables,
    sanitizeSettings: sanitizeSettings,
    init: init
  };
});