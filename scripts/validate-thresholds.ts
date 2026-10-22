import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { recognizeCell } from '../src/lib/ocr/recognize';
import {
  DEFAULT_KEY,
  TABLE_HEIGHT,
  TABLE_WIDTH,
  VALIDATED_CONFIDENCE_THRESHOLD,
  VALIDATED_MARGIN_THRESHOLD,
} from '../src/lib/config';
import { scoreScan } from '../src/lib/scoring';
import { SET_IDS, type CellResult, type SetId } from '../src/types';

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

const sample = process.argv[2] ?? 'samples/reference-2.png';
const labelsFile = process.argv[3] ?? 'samples/validation/reference-2-labels.json';
const labels = (
  JSON.parse(fs.readFileSync(path.resolve(labelsFile), 'utf8')) as {
    labels: Record<SetId, number[]>;
  }
).labels;

const source = readImage(path.resolve(sample));
const detectionCopy = resize(source, 1200);
const quad = detectTableQuad(
  grayscale(detectionCopy),
  detectionCopy.width,
  detectionCopy.height,
);
if (!quad) throw new Error(`Could not detect the table in ${sample}`);
const quadFull = quad.map((point) => ({
  x: point.x * (source.width / detectionCopy.width),
  y: point.y * (source.height / detectionCopy.height),
}));
const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
const geometry = detectGrid(warped);
const cells = cropCells(warped, geometry);

// Use a permissive recognition gate here so this script records the raw
// confidence and margin; the sweep below applies the candidate gate itself.
const results = {} as Record<SetId, CellResult[]>;
for (const set of SET_IDS) {
  results[set] = cells[set].map((cell, index) =>
    recognizeCell(cell, { confidenceThreshold: 0, marginThreshold: 0 }, index + 1),
  );
}

let total = 0;
let correct = 0;
const errors: Array<{
  set: SetId;
  row: number;
  truth: number;
  digit: number | null;
  confidence: number;
  margin: number;
  state: CellResult['state'];
}> = [];
for (const set of SET_IDS) {
  results[set].forEach((cell, index) => {
    total++;
    const truth = labels[set][index];
    if (cell.digit === truth) correct++;
    else {
      errors.push({
        set,
        row: index + 1,
        truth,
        digit: cell.digit,
        confidence: cell.confidence,
        margin: cell.margin,
        state: cell.state,
      });
    }
  });
}

console.log(`sample: ${sample}`);
console.log(`labeled cells: ${total}; model correct: ${correct}; model errors: ${errors.length}`);
console.log(
  errors
    .map(
      (error) =>
        `  ${error.set}${error.row}: truth ${error.truth}, read ${error.digit ?? 'blank'} ` +
        `(conf ${(error.confidence * 100).toFixed(1)}%, margin ${(error.margin * 100).toFixed(1)}%, ` +
        `${error.state})`,
    )
    .join('\n') || '  none',
);

const scored = scoreScan(results, DEFAULT_KEY, 'wrong');
console.log(
  `model score vs key: A ${scored.sets.A.score}, B ${scored.sets.B.score}, C ${scored.sets.C.score}, ` +
    `D ${scored.sets.D.score}, E ${scored.sets.E.score}; total ${scored.total}/60`,
);
console.log('\nthreshold sweep (auto-accepted cells only):');
console.log('confidence  margin  accepted  flagged  errors-accepted  errors-flagged');

const pairs = [
  [0.7, 0.35],
  [0.8, 0.5],
  [0.9, 0.7],
  [0.95, 0.85],
  [0.95, 0.9],
  [0.96, 0.9],
  [0.96, 0.95],
  [0.97, 0.9],
  [0.98, 0.95],
];
for (const [confidenceThreshold, marginThreshold] of pairs) {
  let accepted = 0;
  let flagged = 0;
  let errorsAccepted = 0;
  let errorsFlagged = 0;
  for (const set of SET_IDS) {
    results[set].forEach((cell, index) => {
      const isError = cell.digit !== labels[set][index];
      const flag =
        cell.state === 'obstructed' ||
        cell.state === 'uncertain' ||
        (cell.digit != null &&
          (cell.confidence < confidenceThreshold || cell.margin < marginThreshold));
      if (flag) {
        flagged++;
        if (isError) errorsFlagged++;
      } else {
        accepted++;
        if (isError) errorsAccepted++;
      }
    });
  }
  const marker =
    confidenceThreshold === VALIDATED_CONFIDENCE_THRESHOLD &&
    marginThreshold === VALIDATED_MARGIN_THRESHOLD
      ? '  <- validated default'
      : '';
  console.log(
    `${confidenceThreshold.toFixed(2)}       ${marginThreshold.toFixed(2)}    ` +
      `${String(accepted).padStart(2)}        ${String(flagged).padStart(2)}       ` +
      `${String(errorsAccepted).padStart(2)}               ${String(errorsFlagged).padStart(2)}` +
      marker,
  );
}
