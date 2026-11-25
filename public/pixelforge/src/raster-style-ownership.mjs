/**
 * Pixel-level ownership rules for mixed Illustration / Pixel Art cels.
 * Owner values: 0 = unowned/legacy, 1 = Illustration, 2 = Pixel Art.
 * This pure guard must run at the shared tiled-cel write boundary. Callers
 * must commit the returned owner plane atomically with the RGBA patch.
 */
export const PIXEL_STYLE_OWNER = Object.freeze({ UNOWNED: 0, ILLUSTRATION: 1, PIXEL_ART: 2 });

export function normalizeAuthoringMode(mode) {
  if (mode === 'illustration') return PIXEL_STYLE_OWNER.ILLUSTRATION;
  if (mode === 'pixel-art') return PIXEL_STYLE_OWNER.PIXEL_ART;
  throw new TypeError('A valid authoringMode (illustration or pixel-art) is required.');
}

/**
 * Drawing can claim unowned pixels and edit same-style pixels. Erasing can
 * affect only pixels already owned by the active style. Foreign-owned pixels
 * are restored byte-for-byte. Fully transparent results become unowned.
 */
export function guardStyleOwnedPixels({ before, after, owners, authoringMode, operation = 'draw' } = {}) {
  if (!(before instanceof Uint8Array || before instanceof Uint8ClampedArray) ||
      !(after instanceof Uint8Array || after instanceof Uint8ClampedArray) ||
      before.byteLength !== after.byteLength || before.byteLength % 4 !== 0) {
    throw new TypeError('Style ownership guard requires matching RGBA before/after buffers.');
  }
  if (!(owners instanceof Uint8Array) || owners.byteLength !== before.byteLength / 4) {
    throw new TypeError('Style ownership guard requires one owner byte per pixel.');
  }
  const owner = normalizeAuthoringMode(authoringMode);
  if (!['draw', 'erase', 'restore'].includes(operation)) throw new TypeError('Unsupported style ownership operation.');
  const pixels = new Uint8ClampedArray(after);
  const nextOwners = new Uint8Array(owners);
  let changedPixels = 0, blockedPixels = 0;
  for (let pixel = 0; pixel < nextOwners.length; pixel++) {
    const offset = pixel * 4, currentOwner = nextOwners[pixel];
    if (currentOwner > PIXEL_STYLE_OWNER.PIXEL_ART) throw new TypeError('Pixel ownership plane contains an unsupported owner value.');
    if (operation !== 'restore' && currentOwner !== PIXEL_STYLE_OWNER.UNOWNED && currentOwner !== owner) {
      pixels.set(before.subarray(offset, offset + 4), offset); blockedPixels++; continue;
    }
    if (operation === 'erase' && currentOwner !== owner) {
      pixels.set(before.subarray(offset, offset + 4), offset); blockedPixels++; continue;
    }
    const changed = pixels[offset] !== before[offset] || pixels[offset + 1] !== before[offset + 1] ||
      pixels[offset + 2] !== before[offset + 2] || pixels[offset + 3] !== before[offset + 3];
    if (changed) changedPixels++;
    if (operation !== 'restore') {
      if (pixels[offset + 3] === 0) nextOwners[pixel] = PIXEL_STYLE_OWNER.UNOWNED;
      else if (currentOwner === PIXEL_STYLE_OWNER.UNOWNED) nextOwners[pixel] = owner;
    }
  }
  return { pixels, owners: nextOwners, changedPixels, blockedPixels };
}
