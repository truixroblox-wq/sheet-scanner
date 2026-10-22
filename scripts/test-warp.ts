import fs from 'node:fs';
import { PNG } from 'pngjs';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { DEFAULT_KEY, TABLE_HEIGHT, TABLE_WIDTH } from '../src/lib/config';
import { scoreScan } from '../src/lib/scoring';
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

const file = process.argv[2] ?? 'samples/reference-2.png';
const source = readImage(file);
const small = resize(source, 1200);
const detectStarted = performance.now();
const quad = detectTableQuad(grayscale(small), small.width, small.height);
const detectMs = performance.now() - detectStarted;

console.log(`source ${source.width}x${source.height}; detection copy ${small.width}x${small.height}`);
console.log(`quad ${quad ? JSON.stringify(quad) : 'not found'} (${detectMs.toFixed(0)} ms)`);
if (!quad) process.exit(1);

const warpStarted = performance.now();
const quadFull = quad.map((point) => ({
  x: point.x * (source.width / small.width),
  y: point.y * (source.height / small.height),
}));
const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
const warpMs = performance.now() - warpStarted;

const geometry = detectGrid(warped);
console.log(
  `warp ${warpMs.toFixed(0)} ms; rows ${geometry.rowLines.length}; ` +
    `student columns ${geometry.studentColumns.map((c) => `${c.left}-${c.right}`).join(', ')}` +
    `${geometry.usedFallback ? ' (fallback used)' : ''}`,
);

const recognizeStarted = performance.now();
const cells = cropCells(warped, geometry);
const results = {} as Record<SetId, ReturnType<typeof recognizeCell>[]>;
for (const set of SET_IDS) {
  results[set] = cells[set].map((cell, index) =>
    recognizeCell(cell, { confidenceThreshold: 0.7, marginThreshold: 0.35 }, index + 1),
  );
}
const recognizeMs = performance.now() - recognizeStarted;
const scored = scoreScan(results, DEFAULT_KEY, 'wrong');

for (const set of SET_IDS) {
  console.log(`\nSet ${set}: ${scored.sets[set].score}/12`);
  console.log(
    results[set]
      .map(
        (cell, index) =>
          `${index + 1}:${cell.digit ?? '?'}${cell.state === 'answered' ? '' : `(${cell.state[0]})`} ` +
          `c${cell.confidence.toFixed(2)}`,
      )
      .join(' '),
  );
}

console.log(
  `\nTOTAL ${scored.total}/${scored.totalPossible} | ` +
    `detect ${detectMs.toFixed(0)} ms, warp ${warpMs.toFixed(0)} ms, ` +
    `recognize ${recognizeMs.toFixed(0)} ms`,
);
