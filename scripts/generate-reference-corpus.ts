import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { HOG_DIMENSIONS, hogFeatures } from '../src/lib/ocr/features';
import { TABLE_HEIGHT, TABLE_WIDTH } from '../src/lib/config';
import { SET_IDS, type SetId } from '../src/types';

class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

(globalThis as unknown as { ImageData: typeof FakeImageData }).ImageData = FakeImageData;

interface LabelSheet {
  id: string;
  file: string;
  labels: Record<SetId, Array<number | null>>;
}

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

const setLabels = JSON.parse(
  fs.readFileSync('samples/validation/reference-set-3/labels.json', 'utf8'),
) as { sheets: LabelSheet[] };
const reference2 = JSON.parse(
  fs.readFileSync('samples/validation/reference-2-labels.json', 'utf8'),
) as { labels: Record<SetId, number[]> };
const sheets: LabelSheet[] = [
  ...setLabels.sheets,
  {
    id: 'reference-2',
    file: 'samples/reference-2.png',
    labels: reference2.labels,
  },
];

const features: Uint8Array[] = [];
const labels: number[] = [];
const perSheet: Record<string, number> = {};
let skippedBlank = 0;
let skippedUnextractable = 0;

for (const sheet of sheets) {
  let count = 0;
  const source = readImage(sheet.file);
  const small = resize(source, 1200);
  const quad = detectTableQuad(grayscale(small), small.width, small.height);
  if (!quad) throw new Error(`Could not detect table in ${sheet.file}`);
  const quadFull = quad.map((point) => ({
    x: point.x * (source.width / small.width),
    y: point.y * (source.height / small.height),
  }));
  const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
  const geometry = detectGrid(warped);
  const cells = cropCells(warped, geometry);

  for (const set of SET_IDS) {
    cells[set].forEach((cell, index) => {
      const label = sheet.labels[set][index] ?? null;
      if (label === null) {
        skippedBlank++;
        return;
      }
      const extraction = extractCell(cell);
      if (!extraction.best || extraction.best.area < 18) {
        skippedUnextractable++;
        return;
      }
      const vector = normalizeCell(extraction, extraction.best);
      const hog = hogFeatures(vector);
      if (hog.length !== HOG_DIMENSIONS) {
        throw new Error(`Unexpected HOG length ${hog.length}`);
      }
      features.push(hog);
      labels.push(label);
      count++;
    });
  }
  perSheet[sheet.id] = count;
  console.log(`${sheet.id}: ${count} verified cells`);
}

const flat = new Uint8Array(features.length * HOG_DIMENSIONS);
for (let i = 0; i < features.length; i++) flat.set(features[i], i * HOG_DIMENSIONS);
const base64 = Buffer.from(flat).toString('base64');
const digest = crypto.createHash('sha256').update(flat).digest('hex');
const labelString = labels.join('');

const output = `/**
 * Generated from the hand-verified reference sheets.
 * Run \`npm run generate:reference-corpus\` to rebuild after adding references.
 * Do not edit by hand.
 *
 * Sheets: ${sheets.length}
 * Verified cells: ${features.length}
 * HOG dimensions: ${HOG_DIMENSIONS}
 * Quantisation: 8-bit per bin
 * SHA-256 of raw feature bytes: ${digest}
 */
export const REFERENCE_CELL_COUNT = ${features.length};
export const REFERENCE_LABELS = '${labelString}';
export const REFERENCE_HOG_BASE64 =
  '${base64}';
`;
fs.writeFileSync(path.resolve('src/lib/ocr/reference-corpus.ts'), output);

const manifest = {
  generatedAt: new Date().toISOString(),
  sheets: sheets.length,
  cells: features.length,
  hogDimensions: HOG_DIMENSIONS,
  quantisation: 'uint8',
  rawBytes: flat.length,
  base64Bytes: base64.length,
  sha256: digest,
  skippedBlank,
  skippedUnextractable,
  perSheet,
  sources: [
    'samples/validation/reference-set-3/labels.json',
    'samples/validation/reference-2-labels.json',
  ],
};
fs.mkdirSync('samples/validation/reference-set-3', { recursive: true });
fs.writeFileSync(
  'samples/validation/reference-set-3/reference-corpus-manifest.json',
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `Wrote ${features.length} cells (${(flat.length / 1024).toFixed(0)} KiB) to src/lib/ocr/reference-corpus.ts`,
);
console.log(`Skipped ${skippedBlank} blank and ${skippedUnextractable} unextractable labels`);
