import { describe, expect, it } from 'vitest';
import { extractCell } from '../src/lib/ocr/preprocess';

function syntheticCell(
  width: number,
  height: number,
  paint: (set: (x: number, y: number) => void) => void,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 224;
    data[i * 4 + 1] = 224;
    data[i * 4 + 2] = 224;
    data[i * 4 + 3] = 255;
  }
  paint((x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = 18;
    data[i + 1] = 18;
    data[i + 2] = 18;
  });
  return { data, width, height } as ImageData;
}

describe('cell stroke grouping', () => {
  it('joins a pen-lift split stroke only in merged mode', () => {
    // A 1-like digit written as a small top hook plus two vertical fragments.
    const cell = syntheticCell(160, 90, (set) => {
      for (let x = 62; x <= 78; x++) set(x, 10);
      for (let y = 10; y <= 16; y++) set(78, y);
      for (let y = 10; y <= 48; y++) {
        set(76, y);
        set(77, y);
        set(78, y);
      }
      for (let y = 55; y <= 82; y++) {
        set(76, y);
        set(77, y);
        set(78, y);
      }
    });

    const legacy = extractCell(cell, { grouping: 'legacy' });
    const merged = extractCell(cell, { grouping: 'merged' });
    expect(legacy.best).not.toBeNull();
    expect(merged.best).not.toBeNull();
    if (!legacy.best || !merged.best) return;

    const legacyHeight = legacy.best.maxY - legacy.best.minY + 1;
    const mergedHeight = merged.best.maxY - merged.best.minY + 1;
    expect(mergedHeight).toBeGreaterThan(legacyHeight + 20);
    expect(mergedHeight).toBeGreaterThanOrEqual(65);
    expect(merged.best.minY).toBeLessThanOrEqual(12);
    expect(merged.best.maxY).toBeGreaterThanOrEqual(80);
  });
});
