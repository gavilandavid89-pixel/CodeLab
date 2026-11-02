'use strict';

const crypto = require('node:crypto');

const TEMPLATE_IDS = Object.freeze(['landing', 'dashboard', 'portfolio']);
const TEMPLATE_INFO = Object.freeze([
  { id: 'landing', name: 'Landing page', description: 'Hero, value proposition, primary action, and featured image.' },
  { id: 'dashboard', name: 'Dashboard', description: 'A responsive header and three activity metric cards.' },
  { id: 'portfolio', name: 'Portfolio', description: 'An introduction and a three-project showcase.' }
]);

function createDesignTemplate(templateId, design = {}, options = {}) {
  if (!TEMPLATE_IDS.includes(templateId)) {
    const error = new Error('Unsupported design template: ' + templateId);
    error.code = 'HEADLESS_TEMPLATE_NOT_FOUND';
    throw error;
  }
  const frameWidths = { mobile: 390, tablet: 768, desktop: 1440 };
  const frameWidth = Number.isFinite(design.canvasWidth) && design.canvasWidth > 0
    ? design.canvasWidth
    : (frameWidths[design.frame] || 1440);
  const compact = frameWidth <= 768;
  const pad = compact ? 24 : 80;
  const contentWidth = Math.max(250, frameWidth - pad * 2);
  const idFactory = typeof options.idFactory === 'function'
    ? options.idFactory
    : () => 'el_' + crypto.randomUUID();
  const make = (type, label, text, x, y, width, height, style = {}) => ({
    id: idFactory(),
    type,
    label,
    text: text || '',
    x, y, width, height,
    color: style.color || '#111827',
    background: style.background || 'transparent',
    fontSize: style.fontSize || 18,
    weight: style.weight || 400,
    radius: style.radius || 0,
    textAlign: style.textAlign || 'left',
    ...(type === 'image' ? { src: '', alt: label, objectFit: 'cover' } : {})
  });

  let elements = [];
  let background = '#ffffff';
  if (templateId === 'landing') {
    elements = [
      make('heading', 'Título principal', 'Tu producto, en primer plano', pad, 50, contentWidth, 76, { fontSize: compact ? 30 : 44, weight: 700 }),
      make('text', 'Descripción', 'Explica el valor de tu idea con una frase breve y clara.', pad, 138, contentWidth, 70, { fontSize: compact ? 16 : 20, color: '#475569' }),
      make('button', 'Acción principal', 'Comenzar', pad, 230, compact ? contentWidth : 190, 52, { fontSize: 16, weight: 700, color: '#ffffff', background: '#7c3aed', radius: 12 }),
      make('image', 'Imagen principal', '', pad, 320, contentWidth, compact ? 220 : 300, { background: '#e0e7ff', radius: 18 })
    ];
  } else if (templateId === 'dashboard') {
    background = '#f8fafc';
    elements.push(make('heading', 'Título del panel', 'Panel de control', pad, 38, contentWidth, 64, { fontSize: compact ? 28 : 36, weight: 700 }));
    elements.push(make('text', 'Subtítulo', 'Resumen de actividad', pad, 105, contentWidth, 36, { fontSize: 16, color: '#64748b' }));
    const metrics = [
      { title: 'Usuarios', value: '12.8k', color: '#dbeafe' },
      { title: 'Ingresos', value: '$24.6k', color: '#dcfce7' },
      { title: 'Conversión', value: '8.4%', color: '#f3e8ff' }
    ];
    const gap = 16;
    const cardWidth = compact ? contentWidth : Math.floor((contentWidth - gap * 2) / 3);
    metrics.forEach((metric, i) => {
      const x = compact ? pad : pad + i * (cardWidth + gap);
      const y = compact ? 170 + i * 150 : 170;
      elements.push(make('rectangle', metric.title + ' tarjeta', '', x, y, cardWidth, 128, { background: metric.color, radius: 14 }));
      elements.push(make('text', metric.title, metric.title, x + 16, y + 18, cardWidth - 32, 30, { fontSize: 14, color: '#475569' }));
      elements.push(make('heading', metric.title + ' valor', metric.value, x + 16, y + 52, cardWidth - 32, 48, { fontSize: compact ? 26 : 30, weight: 700 }));
    });
  } else if (templateId === 'portfolio') {
    elements.push(make('heading', 'Nombre del portfolio', 'Mi portfolio', pad, 48, contentWidth, 70, { fontSize: compact ? 32 : 42, weight: 700 }));
    elements.push(make('text', 'Introducción', 'Una selección de proyectos y trabajos recientes.', pad, 128, contentWidth, 52, { fontSize: 18, color: '#64748b' }));
    const cards = [
      { title: 'Proyecto Alpha', color: '#dbeafe' },
      { title: 'Proyecto Beta', color: '#fce7f3' },
      { title: 'Proyecto Gamma', color: '#dcfce7' }
    ];
    const gap = 16;
    const cardWidth = compact ? contentWidth : Math.floor((contentWidth - gap * 2) / 3);
    cards.forEach((card, i) => {
      const x = compact ? pad : pad + i * (cardWidth + gap);
      const y = compact ? 205 + i * 180 : 205;
      elements.push(make('rectangle', card.title + ' tarjeta', '', x, y, cardWidth, 150, { background: card.color, radius: 16 }));
      elements.push(make('heading', card.title, card.title, x + 14, y + 45, cardWidth - 28, 55, { fontSize: compact ? 20 : 22, weight: 700 }));
    });
  }
  return { templateId, background, elements, compact, canvasWidth: frameWidth };
}

module.exports = { TEMPLATE_IDS, TEMPLATE_INFO, createDesignTemplate };
