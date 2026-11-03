export const MAX_ATLAS_DIMENSION = 8192;
export const MAX_ATLAS_PIXELS = 64_000_000;

export function createSpriteSheetLayout(frameCount, frameWidth, frameHeight, { columns = Math.ceil(Math.sqrt(frameCount)), padding = 1 } = {}) {
  if (![frameCount, frameWidth, frameHeight, columns, padding].every(Number.isInteger) || frameCount < 1 || frameWidth < 1 || frameHeight < 1 || columns < 1 || columns > frameCount || padding < 0 || padding > 32) {
    throw new RangeError('Sprite sheet dimensions, frame count, columns, and padding must be valid positive integers.');
  }
  const cellWidth = frameWidth + padding * 2, cellHeight = frameHeight + padding * 2;
  const rows = Math.ceil(frameCount / columns), width = columns * cellWidth, height = rows * cellHeight;
  if (width > MAX_ATLAS_DIMENSION || height > MAX_ATLAS_DIMENSION || width * height > MAX_ATLAS_PIXELS) {
    throw new RangeError('Sprite sheet exceeds safe export limits. Reduce frame size, frame count, or columns.');
  }
  const frames = Array.from({ length: frameCount }, (_, index) => {
    const column = index % columns, row = Math.floor(index / columns);
    return { index, x: column * cellWidth + padding, y: row * cellHeight + padding, width: frameWidth, height: frameHeight, pivotX: Math.floor(frameWidth / 2), pivotY: Math.floor(frameHeight / 2) };
  });
  return { width, height, frameWidth, frameHeight, frameCount, columns, rows, padding, frames };
}
