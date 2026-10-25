/**
 * Diagnose one cell from the imported student set: components, normalized
 * 28x28 input, and base/ensemble class probabilities.
 *
 * Usage: npx tsx scripts/diagnose-sheet-cell.ts S003 B 3
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { predictMnist } from '../src/lib/ocr/cnn';
import { hogFeatures, matchReference } from '../src/lib/ocr/features';
import { getReferenceCorpus } from '../src/lib/ocr/reference';
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

function score(probabilities: ArrayLike<number>) {
  const total = Array.from({ length: 8 }, (_, i) => probabilities[i + 1]).reduce((a, b) => a + b, 0);
  return Array.from({ length: 8 }, (_, i) => {
    const digit = i + 1;
    return `${digit}:${((probabilities[digit] / total) * 100).toFixed(1)}`;
  }).join(' ');
}

const id = process.argv[2] ?? 'S003';
const set = (process.argv[3] ?? 'B') as SetId;
const row = Number(process.argv[4] ?? 3);
const root = path.resolve('samples/student-set-1');
const table = readJpeg(path.join(root, 'review-tables', `${id}.jpg`));
const geometry = detectGrid(table);
const crops = cropCells(table, geometry);
const cell = crops[set][row - 1];
const extraction = extractCell(cell);
console.log('cell', cell.width, cell.height, 'threshold', extraction.threshold, 'bg', extraction.meanBackground);
console.log('components', extraction.components.length);
for (const c of extraction.components) {
  console.log(`  area=${c.area} bbox=${c.minX},${c.minY}-${c.maxX},${c.maxY} w=${c.maxX - c.minX + 1} h=${c.maxY - c.minY + 1}`);
}
console.log('groups', extraction.groups.length);
for (const g of extraction.groups.slice(0, 6)) {
  console.log(`  area=${g.area} bbox=${g.minX},${g.minY}-${g.maxX},${g.maxY} w=${g.maxX - g.minX + 1} h=${g.maxY - g.minY + 1}`);
}
console.log('best', extraction.best);
if (!extraction.best) process.exit(0);
const norm = normalizeCell(extraction, extraction.best);
const base = predictMnist(norm);
console.log('base', base.digit, base.confidence.toFixed(3), base.margin.toFixed(3), score(base.probabilities));
const corpus = getReferenceCorpus();
if (corpus) {
  const match = matchReference(norm, corpus);
  const hog = hogFeatures(norm);
  console.log('reference', match, 'hog', hog.length);
}
const outDir = path.join(root, 'diagnostics');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, values] of [['norm', norm]] as const) {
  const scale = 12;
  const png = new PNG({ width: 28 * scale, height: 28 * scale });
  for (let y = 0; y < 28 * scale; y++) {
    for (let x = 0; x < 28 * scale; x++) {
      const value = values[Math.floor(y / scale) * 28 + Math.floor(x / scale)];
      const v = Math.round(255 * (1 - Math.min(1, Math.max(0, value))));
      const i = (y * 28 * scale + x) * 4;
      png.data[i] = v;
      png.data[i + 1] = v;
      png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
  const file = path.join(outDir, `${id}-${set}${row}-${name}.png`);
  fs.writeFileSync(file, PNG.sync.write(png));
  console.log(file);
}
