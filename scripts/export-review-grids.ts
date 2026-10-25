/**
 * Export a high-contrast, prediction-free review grid for each imported sheet.
 *
 * The crop is the same cell the production pipeline reads. `extractCell` removes
 * the printed rules, red annotations and local paper background, so faint pencil
 * answers are much easier to verify by eye than in the raw photo.
 *
 * Layout: 5 rows (Sets A-E, top to bottom) x 12 columns (rows 1-12).
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { extractCell } from '../src/lib/ocr/preprocess';
import type { SetId } from '../src/types';

class NodeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}
(globalThis as unknown as { ImageData: typeof NodeImageData }).ImageData = NodeImageData;

const ROOT = path.resolve('samples/student-set-1');
const OUT = path.join(ROOT, 'review-grids');
fs.mkdirSync(OUT, { recursive: true });

interface Geometry {
  rowLines: number[];
  studentColumns: Array<{ left: number; right: number }>;
}

const predictions = JSON.parse(fs.readFileSync(path.join(ROOT, 'predictions.json'), 'utf8')) as {
  sheets: Record<string, { geometry: Geometry | null; cells: Record<SetId, Array<{ row: number }>> }>;
};

const CELL_W = 150;
const CELL_H = 96;
const GAP = 4;
const PAD = 8;

function readJpeg(file: string): ImageData {
  const decoded = jpeg.decode(fs.readFileSync(file), {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
  });
  return {
    data: new Uint8ClampedArray(decoded.data),
    width: decoded.width,
    height: decoded.height,
  } as ImageData;
}

function crop(image: ImageData, left: number, top: number, width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const source = ((top + y) * image.width + left) * 4;
    data.set(image.data.subarray(source, source + width * 4), y * width * 4);
  }
  return { data, width, height } as ImageData;
}

function drawEnhanced(
  target: ImageData,
  source: ImageData,
  ink: Float32Array,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  for (let y = 0; y < height; y++) {
    const sy = Math.min(source.height - 1, Math.floor((y / height) * source.height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(source.width - 1, Math.floor((x / width) * source.width));
      const value = Math.max(0, Math.min(1, ink[sy * source.width + sx] * 1.15));
      const gray = Math.round(255 - value * 235);
      const i = ((top + y) * target.width + left + x) * 4;
      target.data[i] = gray;
      target.data[i + 1] = gray;
      target.data[i + 2] = gray;
      target.data[i + 3] = 255;
    }
  }
}

function writePng(file: string, image: ImageData): void {
  const png = new PNG({ width: image.width, height: image.height });
  for (let i = 0; i < image.width * image.height; i++) {
    png.data[i * 4] = image.data[i * 4];
    png.data[i * 4 + 1] = image.data[i * 4 + 1];
    png.data[i * 4 + 2] = image.data[i * 4 + 2];
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 2 }));
}

for (const [id, sheet] of Object.entries(predictions.sheets)) {
  if (!sheet.geometry) continue;
  const table = readJpeg(path.join(ROOT, 'review-tables', `${id}.jpg`));
  const width = PAD * 2 + 12 * CELL_W + 11 * GAP;
  const height = PAD * 2 + 5 * CELL_H + 4 * GAP;
  const grid = { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height } as ImageData;
  const sets: SetId[] = ['A', 'B', 'C', 'D', 'E'];
  for (let s = 0; s < sets.length; s++) {
    const column = sheet.geometry.studentColumns[s];
    for (let r = 0; r < 12; r++) {
      const rowTop = sheet.geometry.rowLines[r];
      const rowBottom = sheet.geometry.rowLines[r + 1];
      const inset = Math.round((rowBottom - rowTop) * 0.12);
      const cell = crop(
        table,
        column.left,
        rowTop + inset,
        column.right - column.left,
        Math.max(1, rowBottom - rowTop - inset * 2),
      );
      const extraction = extractCell(cell);
      const left = PAD + r * (CELL_W + GAP);
      const top = PAD + s * (CELL_H + GAP);
      drawEnhanced(grid, cell, extraction.inkFloat, left, top, CELL_W, CELL_H);
      // Light frame so row boundaries are unambiguous.
      for (let x = 0; x < CELL_W; x++) {
        for (const y of [top - 1, top + CELL_H]) {
          const i = (y * width + left + x) * 4;
          grid.data[i] = 180;
          grid.data[i + 1] = 180;
          grid.data[i + 2] = 180;
        }
      }
    }
  }
  writePng(path.join(OUT, `${id}.png`), grid);
  console.log(`${id} review grid`);
}
