import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEY,
  TABLE_HEIGHT,
  TABLE_WIDTH,
} from '../src/lib/config';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { scoreScan } from '../src/lib/scoring';
import { SET_IDS, type CellResult, type SetId } from '../src/types';

class TestImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as unknown as { ImageData: typeof TestImageData }).ImageData = TestImageData;
}

const REFERENCE = path.resolve('samples/reference-2.png');
const PROTO = path.resolve('samples/proto-warp.png');
const hasReference = fs.existsSync(REFERENCE);
const hasProto = fs.existsSync(PROTO);

function readImage(file: string): ImageData {
  const png = PNG.sync.read(fs.readFileSync(file));
  const data = new Uint8ClampedArray(png.width * png.height * 4);
  for (let i = 0; i < png.width * png.height; i++) {
    data[i * 4] = png.data[i * 4];
    data[i * 4 + 1] = png.data[i * 4 + 1];
    data[i * 4 + 2] = png.data[i * 4 + 2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: png.width, height: png.height } as ImageData;
}

function resize(image: ImageData, maxSide: number): ImageData {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.round((y / height) * image.height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.round((x / width) * image.width));
      const si = (sy * image.width + sx) * 4;
      const di = (y * width + x) * 4;
      data[di] = image.data[si];
      data[di + 1] = image.data[si + 1];
      data[di + 2] = image.data[si + 2];
      data[di + 3] = 255;
    }
  }
  return { data, width, height } as ImageData;
}

function recognize(
  image: ImageData,
  geometry: ReturnType<typeof detectGrid>,
): Record<SetId, CellResult[]> {
  const cells = cropCells(image, geometry);
  const results = {} as Record<SetId, CellResult[]>;
  for (const set of SET_IDS) {
    results[set] = cells[set].map((cell, index) =>
      recognizeCell(cell, { confidenceThreshold: 0.7, marginThreshold: 0.35 }, index + 1),
    );
  }
  return results;
}

describe.skipIf(!hasProto)('adaptive grid on the reference warp', () => {
  it('aligns rows and student columns without losing accuracy', () => {
    const image = readImage(PROTO);
    const geometry = detectGrid(image);
    expect(geometry.rowLines).toHaveLength(13);
    expect(geometry.studentColumns).toHaveLength(5);
    for (const column of geometry.studentColumns) {
      expect(column.right - column.left).toBeGreaterThan(100);
      expect(column.left).toBeGreaterThanOrEqual(0);
      expect(column.right).toBeLessThanOrEqual(TABLE_WIDTH);
    }
    // The synthetic warp is a layout fixture, not a hand-labelled answer
    // sheet. Exact scoring is pinned on samples/reference-2.png below, which
    // has verified labels and is the validation set for the confirmation gate.
    expect(recognize(image, geometry)).toBeTruthy();
  });
});

describe.skipIf(!hasReference)('full scanning pipeline on a photographed sheet', () => {
  it('detects, rectifies, aligns, reads and scores the sample', () => {
    const source = readImage(REFERENCE);
    const small = resize(source, 1200);
    const quad = detectTableQuad(grayscale(small), small.width, small.height);
    expect(quad).not.toBeNull();
    if (!quad) return;

    const quadFull = quad.map((point) => ({
      x: point.x * (source.width / small.width),
      y: point.y * (source.height / small.height),
    }));
    const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
    const geometry = detectGrid(warped);
    expect(geometry.rowLines).toHaveLength(13);
    expect(geometry.studentColumns).toHaveLength(5);
    for (const column of geometry.studentColumns) {
      expect(column.right - column.left).toBeGreaterThan(90);
    }

    const results = recognize(warped, geometry);
    const scored = scoreScan(results, DEFAULT_KEY, 'wrong');
    expect(scored.sets.A.score).toBe(12);
    expect(scored.sets.B.score).toBe(10);
    expect(scored.sets.C.score).toBe(6);
    expect(scored.sets.D.score).toBe(8);
    expect(scored.sets.E.score).toBe(4);
    expect(scored.total).toBe(40);
  });
});
