/**
 * Run every imported original through the production scan stages and report
 * measured processing time. Model/reference decode and the first warm-up sheet
 * are excluded from the timing summary.
 *
 * This is a Node harness: it uses the same detection, rectification, grid,
 * crop, recognition, and reference code as the browser, but decodes JPEG with
 * jpeg-js instead of the browser image pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { DEFAULT_SETTINGS } from '../src/lib/config';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { getReferenceCorpus } from '../src/lib/ocr/reference';
import { SET_IDS } from '../src/types';

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

const root = path.resolve('samples/student-set-1/originals');
function readJpeg(file: string): ImageData {
  const decoded = jpeg.decode(fs.readFileSync(file), {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
  });
  return new NodeImageData(decoded.data as Uint8ClampedArray, decoded.width, decoded.height);
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
  return new NodeImageData(data, width, height);
}

const referenceCorpus = getReferenceCorpus();
const timings: Array<{
  id: string;
  detectMs: number;
  warpMs: number;
  gridMs: number;
  recognizeMs: number;
  totalMs: number;
  tableDetected: boolean;
  answered: number;
}> = [];

// Warm up the model, TTA maps, and reference matcher before timing.
{
  const id = 'S001';
  const source = readJpeg(path.join(root, `${id}.jpeg`));
  const small = resize(source, 1200);
  const quad = detectTableQuad(grayscale(small), small.width, small.height);
  if (quad) {
    const full = quad.map((point) => ({
      x: point.x * (source.width / small.width),
      y: point.y * (source.height / small.height),
    }));
    const warped = warpPerspective(source, full, 1500, 1463);
    const cells = cropCells(warped, detectGrid(warped));
    for (const set of SET_IDS) {
      for (let index = 0; index < 12; index++) {
        recognizeCell(cells[set][index], DEFAULT_SETTINGS, index + 1, { referenceCorpus });
      }
    }
  }
}

const files = fs
  .readdirSync(root)
  .filter((name) => /^S\d{3}\.jpeg$/i.test(name))
  .sort();
for (const file of files) {
  const id = file.replace(/\.jpeg$/i, '');
  const started = performance.now();
  const source = readJpeg(path.join(root, file));
  const small = resize(source, 1200);
  const detectStart = performance.now();
  const quad = detectTableQuad(grayscale(small), small.width, small.height);
  const detectMs = performance.now() - detectStart;
  let tableDetected = Boolean(quad);
  let warped: ImageData;
  let warpMs = 0;
  if (quad) {
    const full = quad.map((point) => ({
      x: point.x * (source.width / small.width),
      y: point.y * (source.height / small.height),
    }));
    const warpStart = performance.now();
    warped = warpPerspective(source, full, 1500, 1463);
    warpMs = performance.now() - warpStart;
  } else {
    warped = resize(source, 1500);
    tableDetected = false;
  }
  const gridStart = performance.now();
  const geometry = detectGrid(warped);
  const cells = cropCells(warped, geometry);
  const gridMs = performance.now() - gridStart;
  const recognizeStart = performance.now();
  let answered = 0;
  for (const set of SET_IDS) {
    for (let index = 0; index < 12; index++) {
      const result = recognizeCell(cells[set][index], DEFAULT_SETTINGS, index + 1, {
        referenceCorpus,
      });
      if (result.state === 'answered') answered++;
    }
  }
  const recognizeMs = performance.now() - recognizeStart;
  const totalMs = performance.now() - started;
  timings.push({ id, detectMs, warpMs, gridMs, recognizeMs, totalMs, tableDetected, answered });
  console.log(
    `${id}: ${totalMs.toFixed(0)} ms (detect ${detectMs.toFixed(0)}, warp ${warpMs.toFixed(0)}, grid ${gridMs.toFixed(0)}, recognize ${recognizeMs.toFixed(0)}), answered ${answered}/60${tableDetected ? '' : ' [NO TABLE]'}`,
  );
}

const values = timings.map((row) => row.totalMs).sort((a, b) => a - b);
const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
const median =
  values.length % 2
    ? values[Math.floor(values.length / 2)]
    : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
console.log('\nSummary');
console.log(`  sheets: ${timings.length}`);
console.log(`  table detected: ${timings.filter((row) => row.tableDetected).length}/${timings.length}`);
console.log(`  mean ${mean.toFixed(0)} ms/sheet; median ${median.toFixed(0)} ms; p95 ${p95.toFixed(0)} ms`);
console.log(`  min ${values[0].toFixed(0)} ms; max ${values[values.length - 1].toFixed(0)} ms`);
console.log(
  `  mean phases: detect ${(timings.reduce((sum, row) => sum + row.detectMs, 0) / timings.length).toFixed(0)} ms, warp ${(timings.reduce((sum, row) => sum + row.warpMs, 0) / timings.length).toFixed(0)} ms, grid+crop ${(timings.reduce((sum, row) => sum + row.gridMs, 0) / timings.length).toFixed(0)} ms, recognition ${(timings.reduce((sum, row) => sum + row.recognizeMs, 0) / timings.length).toFixed(0)} ms`,
);
