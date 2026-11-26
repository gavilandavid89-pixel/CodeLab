export const VIDEO_COMPOSITION_PROFILES = Object.freeze({
  'youtube-landscape': Object.freeze({ id: 'youtube-landscape', platform: 'YouTube', aspect: '16:9', width1080: 1920, height1080: 1080 }),
  'tiktok-vertical': Object.freeze({ id: 'tiktok-vertical', platform: 'TikTok', aspect: '9:16', width1080: 1080, height1080: 1920 }),
  'shorts-vertical': Object.freeze({ id: 'shorts-vertical', platform: 'YouTube Shorts', aspect: '9:16', width1080: 1080, height1080: 1920 }),
  'instagram-feed': Object.freeze({ id: 'instagram-feed', platform: 'Instagram', aspect: '4:5', width1080: 1080, height1080: 1350 }),
  'instagram-square': Object.freeze({ id: 'instagram-square', platform: 'Instagram', aspect: '1:1', width1080: 1080, height1080: 1080 }),
  'facebook-landscape': Object.freeze({ id: 'facebook-landscape', platform: 'Facebook', aspect: '16:9', width1080: 1920, height1080: 1080 }),
});

export function getVideoCompositionProfile(profileId) {
  return VIDEO_COMPOSITION_PROFILES[profileId] || null;
}

export function getCaptureDimensions(resolution, aspect, sourceWidth, sourceHeight) {
  const base = Number(resolution) === 720 ? 720 : 1080;
  const profile = Object.values(VIDEO_COMPOSITION_PROFILES).find(item => item.aspect === aspect);
  const ratio = profile ? profile.width1080 / profile.height1080 : aspect === 'auto'
    ? Math.max(1 / 3, Math.min(3, sourceWidth / sourceHeight)) : 16 / 9;
  let width;
  let height;
  if (ratio >= 1) { height = base; width = Math.round(base * ratio); }
  else { width = base; height = Math.round(base / ratio); }
  return { width, height };
}

export function containRect(sourceWidth, sourceHeight, x, y, width, height) {
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  return {
    x: Math.round(x + (width - drawWidth) / 2),
    y: Math.round(y + (height - drawHeight) / 2),
    width: drawWidth,
    height: drawHeight,
  };
}

export function coverSourceRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Source and target dimensions must be positive finite numbers.');
  }
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  if (sourceRatio > targetRatio) {
    const width = sourceHeight * targetRatio;
    return { x: (sourceWidth - width) / 2, y: 0, width, height: sourceHeight };
  }
  const height = sourceWidth / targetRatio;
  return { x: 0, y: (sourceHeight - height) / 2, width: sourceWidth, height };
}

export function coverSourceRectAtFocalPoint(sourceWidth, sourceHeight, targetWidth, targetHeight, focalPoint = { x: 0.5, y: 0.5 }) {
  const centered = coverSourceRect(sourceWidth, sourceHeight, targetWidth, targetHeight);
  const fx = Math.max(0, Math.min(1, Number(focalPoint?.x ?? 0.5)));
  const fy = Math.max(0, Math.min(1, Number(focalPoint?.y ?? 0.5)));
  const desiredX = fx * sourceWidth - centered.width / 2;
  const desiredY = fy * sourceHeight - centered.height / 2;
  return {
    x: Math.max(0, Math.min(sourceWidth - centered.width, desiredX)),
    y: Math.max(0, Math.min(sourceHeight - centered.height, desiredY)),
    width: centered.width,
    height: centered.height,
  };
}

export function getPlatformCompositionGuide(sourceWidth, sourceHeight, profileId) {
  const profile = getVideoCompositionProfile(profileId);
  if (!profile) throw new RangeError('Unknown video composition profile: ' + profileId);
  const resolution = profile.width1080 === 1080 && profile.height1080 === 1920 ? '1080' : '1080';
  const target = getCaptureDimensions(resolution, profile.aspect, sourceWidth, sourceHeight);
  return { profile, ...getCompositionGuide(sourceWidth, sourceHeight, target.width, target.height) };
}

export function getCompositionGuide(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const safeArea = coverSourceRect(sourceWidth, sourceHeight, targetWidth, targetHeight);
  return {
    type: 'aspect-ratio-guide',
    aspectRatio: targetWidth + ':' + targetHeight,
    source: { width: sourceWidth, height: sourceHeight },
    target: { width: targetWidth, height: targetHeight },
    safeArea: {
      x: Math.round(safeArea.x),
      y: Math.round(safeArea.y),
      width: Math.round(safeArea.width),
      height: Math.round(safeArea.height),
    },
    normalizedSafeArea: {
      x: safeArea.x / sourceWidth,
      y: safeArea.y / sourceHeight,
      width: safeArea.width / sourceWidth,
      height: safeArea.height / sourceHeight,
    },
  };
}

export function getSourceQualityAssessment(sourceWidth, sourceHeight, outputWidth, outputHeight, { fitMode = 'contain' } = {}) {
  if (![sourceWidth, sourceHeight, outputWidth, outputHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Source and output dimensions must be positive finite numbers.');
  }
  const covering = fitMode === 'cover';
  const sourceRect = covering
    ? coverSourceRect(sourceWidth, sourceHeight, outputWidth, outputHeight)
    : { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  const scale = covering
    ? Math.max(outputWidth / sourceRect.width, outputHeight / sourceRect.height)
    : Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const rect = covering
    ? { width: outputWidth, height: outputHeight }
    : containRect(sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
  return {
    scale,
    upscaled: scale > 1.001,
    downscaled: scale < 0.999,
    sourceWidth,
    sourceHeight,
    sourceCrop: sourceRect,
    contentWidth: rect.width,
    contentHeight: rect.height,
    fitMode: covering ? 'cover' : 'contain',
  };
}

export function drawFrameToCanvas(context, bitmap, width, height, options = {}) {
  if (!context || !bitmap || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new TypeError('A canvas context, bitmap and valid output dimensions are required.');
  }
  const fitMode = options.fitMode === 'cover' ? 'cover' : 'contain';
  const rect = fitMode === 'cover'
    ? coverSourceRectAtFocalPoint(bitmap.width, bitmap.height, width, height, options.focalPoint)
    : containRect(bitmap.width, bitmap.height, 0, 0, width, height);
  const scalingMode = options.scalingMode === 'pixelated' ? 'pixelated' : 'smooth';
  context.save();
  context.clearRect(0, 0, width, height);
  if (options.backgroundColor) {
    context.fillStyle = options.backgroundColor;
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingEnabled = scalingMode !== 'pixelated';
  if (context.imageSmoothingEnabled) context.imageSmoothingQuality = 'high';
  if (fitMode === 'cover') {
    context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
  } else {
    context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
  }
  context.restore();
  return rect;
}

export function drawLayeredFrameToCanvas(context, layers, sourceWidth, sourceHeight, width, height, options = {}) {
  if (!context || !Array.isArray(layers) || !layers.length ||
      ![sourceWidth, sourceHeight, width, height].every(value => Number.isFinite(value) && value > 0)) {
    throw new TypeError('A canvas context, source layers and valid source/output dimensions are required.');
  }
  const fitMode = options.fitMode === 'cover' ? 'cover' : 'contain';
  let scale, cropX = 0, cropY = 0, offsetX = 0, offsetY = 0;
  if (fitMode === 'cover') {
    const crop = coverSourceRectAtFocalPoint(sourceWidth, sourceHeight, width, height, options.focalPoint);
    cropX = crop.x; cropY = crop.y;
    scale = width / crop.width;
  } else {
    scale = Math.min(width / sourceWidth, height / sourceHeight);
    offsetX = (width - sourceWidth * scale) / 2;
    offsetY = (height - sourceHeight * scale) / 2;
  }
  const destinationX = Number(options.destinationX) || 0;
  const destinationY = Number(options.destinationY) || 0;
  if (options.clearCanvas !== false) {
    context.clearRect(destinationX, destinationY, width, height);
    if (options.backgroundColor) {
      context.fillStyle = options.backgroundColor;
      context.fillRect(destinationX, destinationY, width, height);
    }
  }
  context.save();
  context.translate(destinationX + offsetX - cropX * scale, destinationY + offsetY - cropY * scale);
  context.scale(scale, scale);
  for (const layer of layers) {
    const bitmap = layer.bitmap || layer.image;
    if (!bitmap) throw new TypeError('Every composed layer must provide a decoded bitmap.');
    const mode = layer.authoringMode === 'pixel-art' ? 'pixel-art' : 'illustration';
    context.save();
    context.imageSmoothingEnabled = mode !== 'pixel-art';
    if (context.imageSmoothingEnabled) context.imageSmoothingQuality = 'high';
    context.globalAlpha = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)));
    const blend = String(layer.blendMode || 'source-over');
    context.globalCompositeOperation = ['source-over','multiply','screen','overlay','darken','lighten','difference','exclusion','lighter'].includes(blend)
      ? blend : 'source-over';
    const x = Number(layer.x ?? 0), y = Number(layer.y ?? 0);
    const scaleX = Number(layer.scaleX ?? 1), scaleY = Number(layer.scaleY ?? 1);
    const rotation = Number(layer.rotation ?? 0);
    context.translate(sourceWidth / 2 + x, sourceHeight / 2 + y);
    context.rotate(rotation * Math.PI / 180);
    context.scale(Number.isFinite(scaleX) ? scaleX : 1, Number.isFinite(scaleY) ? scaleY : 1);
    context.drawImage(bitmap, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
    context.restore();
  }
  context.restore();
  return { scale, cropX, cropY, offsetX, offsetY, fitMode };
}

export function drawContentComposition(context, bitmap, frameIndex, dimensions, thumbnails, options = {}) {
  const { width, height } = dimensions;
  const sourceWidth = options.sourceWidth || bitmap.width;
  const sourceHeight = options.sourceHeight || bitmap.height;
  context.save();
  context.imageSmoothingEnabled = options.scalingMode !== 'pixelated';
  if (context.imageSmoothingEnabled) context.imageSmoothingQuality = 'high';
  context.fillStyle = options.background || '#101116';
  context.fillRect(0, 0, width, height);
  const unit = Math.max(1, Math.round(Math.min(width, height) / 720));
  const headerHeight = Math.round(height * 0.105);
  const timelineHeight = Math.round(height * 0.205);
  context.fillStyle = '#171a23';
  context.fillRect(0, 0, width, headerHeight);
  context.fillStyle = '#e9eaf2';
  context.font = '700 ' + Math.round(22 * unit) + 'px system-ui, sans-serif';
  context.fillText(options.title || 'PixelForge · Animación', Math.round(28 * unit), Math.round(headerHeight * 0.47));
  context.fillStyle = '#a79aff';
  context.font = '500 ' + Math.round(12 * unit) + 'px system-ui, sans-serif';
  context.fillText('FRAME ' + String(frameIndex + 1).padStart(2, '0') + '  /  ' + String(options.frameCount || thumbnails.length), Math.round(28 * unit), Math.round(headerHeight * 0.78));

  const artX = Math.round(width * 0.045);
  const artY = headerHeight + Math.round(height * 0.025);
  const artWidth = width - artX * 2;
  const artHeight = height - headerHeight - timelineHeight - Math.round(height * 0.045);
  context.fillStyle = '#20232d';
  context.fillRect(artX, artY, artWidth, artHeight);
  const inset = Math.round(Math.min(width, height) * 0.045);
  const targetX = artX + inset, targetY = artY + inset;
  const targetWidth = artWidth - inset * 2, targetHeight = artHeight - inset * 2;
  if (Array.isArray(options.layers) && options.layers.length) {
    drawLayeredFrameToCanvas(context, options.layers, sourceWidth, sourceHeight, targetWidth, targetHeight, {
      fitMode: options.fitMode, clearCanvas: false, destinationX: targetX, destinationY: targetY,
    });
  } else if (options.fitMode === 'cover') {
    const crop = coverSourceRect(sourceWidth, sourceHeight, targetWidth, targetHeight);
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, targetX, targetY, targetWidth, targetHeight);
  } else {
    const rect = containRect(sourceWidth, sourceHeight, targetX, targetY, targetWidth, targetHeight);
    context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
  }

  const stripY = height - timelineHeight;
  context.fillStyle = '#171a23';
  context.fillRect(0, stripY, width, timelineHeight);
  context.fillStyle = '#cfd2dc';
  context.font = '600 ' + Math.round(14 * unit) + 'px system-ui, sans-serif';
  context.fillText('FOTOGRAMAS', Math.round(28 * unit), stripY + Math.round(24 * unit));
  const gap = Math.round(10 * unit);
  const thumbSize = Math.min(Math.round(82 * unit), Math.round(timelineHeight * 0.58));
  const available = width - Math.round(56 * unit);
  const count = Math.max(1, Math.min(thumbnails.length, Math.floor((available + gap) / (thumbSize + gap))));
  const selected = thumbnails.findIndex(item => item.index === frameIndex);
  const start = selected < 0 ? 0 : Math.max(0, Math.min(thumbnails.length - count, selected - Math.floor(count / 2)));
  const shown = thumbnails.slice(start, start + count);
  let x = Math.round(28 * unit);
  const y = stripY + Math.round(34 * unit);
  for (const item of shown) {
    context.fillStyle = item.index === frameIndex ? '#a79aff' : '#303441';
    context.fillRect(x - 3 * unit, y - 3 * unit, thumbSize + 6 * unit, thumbSize + 6 * unit);
    const thumbRect = containRect(item.bitmap.width, item.bitmap.height, x, y, thumbSize, thumbSize);
    context.drawImage(item.bitmap, thumbRect.x, thumbRect.y, thumbRect.width, thumbRect.height);
    context.fillStyle = '#e6e7ef';
    context.font = '500 ' + Math.round(10 * unit) + 'px system-ui, sans-serif';
    context.fillText(String(item.index + 1).padStart(2, '0'), x, y + thumbSize + Math.round(15 * unit));
    x += thumbSize + gap;
  }
  context.restore();
}
