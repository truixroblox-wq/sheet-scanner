import fs from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_KEY, TABLE_HEIGHT, TABLE_WIDTH } from '../src/lib/config';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { predictMnist } from '../src/lib/ocr/cnn';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { scoreScan } from '../src/lib/scoring';
import { SET_IDS, type CellResult, type SetId } from '../src/types';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';

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

function run(file: string): void {
  const source = readImage(file);
  const detectionCopy = resize(source, 1200);

  const detectStart = performance.now();
  const quad = detectTableQuad(
    grayscale(detectionCopy),
    detectionCopy.width,
    detectionCopy.height,
  );
  const detectMs = performance.now() - detectStart;
  if (!quad) throw new Error('Table not found');

  const quadFull = quad.map((point) => ({
    x: point.x * (source.width / detectionCopy.width),
    y: point.y * (source.height / detectionCopy.height),
  }));

  const warpStart = performance.now();
  const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
  const warpMs = performance.now() - warpStart;

  const gridStart = performance.now();
  const geometry = detectGrid(warped);
  const gridMs = performance.now() - gridStart;

  const cropStart = performance.now();
  const cells = cropCells(warped, geometry);
  const cropMs = performance.now() - cropStart;

  const settings = { confidenceThreshold: 0.7, marginThreshold: 0.35 };
  const results = {} as Record<SetId, CellResult[]>;
  const recognizeStart = performance.now();
  for (const set of SET_IDS) {
    results[set] = cells[set].map((cell, index) => recognizeCell(cell, settings, index + 1));
  }
  const recognizeMs = performance.now() - recognizeStart;

  // Separate breakdown for diagnostics only. This pass is not part of the
  // reported recognition time above.
  let extractMs = 0;
  let cnnMs = 0;
  for (const set of SET_IDS) {
    for (const cell of cells[set]) {
      const extractStart = performance.now();
      const extraction = extractCell(cell);
      extractMs += performance.now() - extractStart;
      if (extraction.best && extraction.best.area >= 18) {
        const norm = normalizeCell(extraction, extraction.best);
        const cnnStart = performance.now();
        predictMnist(norm);
        cnnMs += performance.now() - cnnStart;
      }
    }
  }

  const scored = scoreScan(results, DEFAULT_KEY, 'wrong');
  console.log(file);
  console.log(
    `  detect ${detectMs.toFixed(0)} ms | warp ${warpMs.toFixed(0)} ms | grid ${gridMs.toFixed(0)} ms | ` +
      `crop ${cropMs.toFixed(0)} ms | recognize ${recognizeMs.toFixed(0)} ms | total ` +
      `${(detectMs + warpMs + gridMs + cropMs + recognizeMs).toFixed(0)} ms`,
  );
  console.log(
    `  diagnostic pass: extraction ${extractMs.toFixed(0)} ms, one CNN pass ${cnnMs.toFixed(0)} ms`,
  );
  console.log(`  score ${scored.total}/${scored.totalPossible}`);
}

// Warm up the embedded weights before timing.
predictMnist(new Float32Array(784));
run(process.argv[2] ?? 'samples/reference-2.png');
