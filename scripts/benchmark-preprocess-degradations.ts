/**
 * Measure handwritten-digit recognition on the hand-verified student set after
 * deterministic, cell-level degradations. This is a regression harness for the
 * preprocessing changes: it uses the same crop and recognition code as the app
 * and reports raw digit accuracy, not just "looks better".
 *
 * Usage:
 *   npx tsx scripts/benchmark-preprocess-degradations.ts
 *   npx tsx scripts/benchmark-preprocess-degradations.ts --sets S005,S006
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { DEFAULT_SETTINGS } from '../src/lib/config';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { SET_IDS, type SetId } from '../src/types';

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

interface LabelSheet {
  verified: boolean;
  labels: Record<SetId, Array<number | null>>;
}
interface LabelFile {
  sheets: Record<string, LabelSheet>;
}

const root = path.resolve('samples/student-set-1');
const labels = JSON.parse(fs.readFileSync(path.join(root, 'labels.json'), 'utf8')) as LabelFile;
const args = process.argv.slice(2);
const setsArg = args.includes('--sets') ? args[args.indexOf('--sets') + 1] : '';
const requested = setsArg ? new Set(setsArg.split(',').map((id) => id.trim().toUpperCase())) : null;
const floorArg = args.includes('--floor') ? Number(args[args.indexOf('--floor') + 1]) : null;
const fractionArg = args.includes('--fraction')
  ? Number(args[args.indexOf('--fraction') + 1])
  : null;
const recognitionOptions =
  floorArg != null || fractionArg != null
    ? {
        extraction: {
          ...(floorArg != null ? { thresholdFloor: floorArg } : {}),
          ...(fractionArg != null ? { thresholdFraction: fractionArg } : {}),
        },
      }
    : undefined;
const ids = ['S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007', 'S008'].filter(
  (id) => labels.sheets[id]?.verified && (!requested || requested.has(id)),
);

function readJpeg(file: string): ImageData {
  const decoded = jpeg.decode(fs.readFileSync(file), {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
  });
  return new NodeImageData(decoded.data as Uint8ClampedArray, decoded.width, decoded.height);
}

function clone(cell: ImageData): ImageData {
  return new NodeImageData(new Uint8ClampedArray(cell.data), cell.width, cell.height);
}

function cornerBackground(cell: ImageData): [number, number, number] {
  const { width, height, data } = cell;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const [x, y] of [
    [1, 1],
    [width - 2, 1],
    [1, height - 2],
    [width - 2, height - 2],
  ]) {
    const i = (y * width + x) * 4;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  return [r / n, g / n, b / n];
}

function mapChannels(
  cell: ImageData,
  fn: (value: number, x: number, y: number) => number,
): ImageData {
  const out = clone(cell);
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const i = (y * cell.width + x) * 4;
      out.data[i] = fn(cell.data[i], x, y);
      out.data[i + 1] = fn(cell.data[i + 1], x, y);
      out.data[i + 2] = fn(cell.data[i + 2], x, y);
      out.data[i + 3] = 255;
    }
  }
  return out;
}

function rotate(cell: ImageData, degrees: number): ImageData {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = (cell.width - 1) / 2;
  const cy = (cell.height - 1) / 2;
  const [br, bg, bb] = cornerBackground(cell);
  const out = new NodeImageData(new Uint8ClampedArray(cell.width * cell.height * 4), cell.width, cell.height);
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      const di = (y * cell.width + x) * 4;
      if (sx < 0 || sy < 0 || sx > cell.width - 1 || sy > cell.height - 1) {
        out.data[di] = br;
        out.data[di + 1] = bg;
        out.data[di + 2] = bb;
      } else {
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(cell.width - 1, x0 + 1);
        const y1 = Math.min(cell.height - 1, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        const i00 = (y0 * cell.width + x0) * 4;
        const i10 = (y0 * cell.width + x1) * 4;
        const i01 = (y1 * cell.width + x0) * 4;
        const i11 = (y1 * cell.width + x1) * 4;
        for (let c = 0; c < 3; c++) {
          out.data[di + c] =
            (cell.data[i00 + c] * (1 - fx) + cell.data[i10 + c] * fx) * (1 - fy) +
            (cell.data[i01 + c] * (1 - fx) + cell.data[i11 + c] * fx) * fy;
        }
      }
      out.data[di + 3] = 255;
    }
  }
  return out;
}

function shear(cell: ImageData, amount: number): ImageData {
  const [br, bg, bb] = cornerBackground(cell);
  const out = new NodeImageData(new Uint8ClampedArray(cell.width * cell.height * 4), cell.width, cell.height);
  for (let y = 0; y < cell.height; y++) {
    const shift = amount * (y - cell.height / 2);
    for (let x = 0; x < cell.width; x++) {
      const sx = x - shift;
      const di = (y * cell.width + x) * 4;
      if (sx < 0 || sx > cell.width - 1) {
        out.data[di] = br;
        out.data[di + 1] = bg;
        out.data[di + 2] = bb;
      } else {
        const x0 = Math.floor(sx);
        const x1 = Math.min(cell.width - 1, x0 + 1);
        const fx = sx - x0;
        for (let c = 0; c < 3; c++) {
          const si0 = (y * cell.width + x0) * 4 + c;
          const si1 = (y * cell.width + x1) * 4 + c;
          out.data[di + c] = cell.data[si0] * (1 - fx) + cell.data[si1] * fx;
        }
      }
      out.data[di + 3] = 255;
    }
  }
  return out;
}

function blur(cell: ImageData): ImageData {
  const out = clone(cell);
  const radius = 1;
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const di = (y * cell.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let yy = Math.max(0, y - radius); yy <= Math.min(cell.height - 1, y + radius); yy++) {
          for (let xx = Math.max(0, x - radius); xx <= Math.min(cell.width - 1, x + radius); xx++) {
            sum += cell.data[(yy * cell.width + xx) * 4 + c];
            n++;
          }
        }
        out.data[di + c] = sum / n;
      }
      out.data[di + 3] = 255;
    }
  }
  return out;
}

function faint(cell: ImageData): ImageData {
  const [br] = cornerBackground(cell);
  return mapChannels(cell, (value) => br * 0.92 + (value - br * 0.92) * 0.32);
}

function lowContrast(cell: ImageData): ImageData {
  const center = 205;
  return mapChannels(cell, (value) => center + (value - center) * 0.42);
}

function shadow(cell: ImageData): ImageData {
  return mapChannels(cell, (value, x, y) => {
    const light = 1 - 0.32 * (x / Math.max(1, cell.width - 1)) - 0.12 * (y / Math.max(1, cell.height - 1));
    return value * light + 10;
  });
}

function noise(cell: ImageData): ImageData {
  let seed = 1234567;
  return mapChannels(cell, (value) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const jitter = ((seed >>> 16) % 17) - 8;
    return value + jitter;
  });
}

type Transform = { name: string; apply: (cell: ImageData) => ImageData };

const transforms: Transform[] = [
  { name: 'clean', apply: (cell) => cell },
  { name: 'rotated+7', apply: (cell) => rotate(cell, 7) },
  { name: 'rotated-7', apply: (cell) => rotate(cell, -7) },
  { name: 'shear8%', apply: (cell) => shear(cell, 0.08) },
  { name: 'faint32%', apply: faint },
  { name: 'blur3x3', apply: blur },
  { name: 'lowContrast42%', apply: lowContrast },
  { name: 'shadow', apply: shadow },
  { name: 'noise', apply: noise },
];

interface Row {
  sheet: string;
  set: SetId;
  row: number;
  label: number;
  cell: ImageData;
}

const rows: Row[] = [];
for (const id of ids) {
  const table = readJpeg(path.join(root, 'review-tables', `${id}.jpg`));
  const cells = cropCells(table, detectGrid(table));
  for (const set of SET_IDS) {
    for (let r = 0; r < 12; r++) {
      const label = labels.sheets[id].labels[set][r];
      if (label == null) continue;
      rows.push({ sheet: id, set, row: r + 1, label, cell: cells[set][r] });
    }
  }
}

console.log(`sheets=${ids.join(',')} labeledCells=${rows.length}`);
const variantsArg = args.includes('--variants') ? args[args.indexOf('--variants') + 1] : '';
const activeTransforms = variantsArg
  ? transforms.filter((transform) => variantsArg.split(',').includes(transform.name))
  : transforms;
const debugCell = args.includes('--cell') ? args[args.indexOf('--cell') + 1] : '';
if (args.includes('--debug') && rows[0]) {
  const sample = debugCell
    ? rows.find((row) => `${row.sheet}-${row.set}${row.row}` === debugCell) ?? rows[0]
    : rows[0];
  console.log(`debug sample ${sample.sheet}-${sample.set}${sample.row} label=${sample.label}`);
  for (const transform of transforms) {
    const cell = transform.apply(sample.cell);
    const extraction = extractCell(cell);
    const result = recognizeCell(cell, DEFAULT_SETTINGS, sample.row, recognitionOptions);
    const norm = extraction.best ? normalizeCell(extraction, extraction.best) : null;
    const values = norm ? Array.from(norm).filter((value) => value > 0).sort((a, b) => a - b) : [];
    const p = (fraction: number) =>
      values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] : 0;
    console.log(
      `  ${transform.name.padEnd(14)} threshold=${extraction.threshold.toFixed(1)} bg=${extraction.meanBackground.toFixed(1)} peak=${extraction.contrastPeak} inkRatio=${extraction.inkRatio.toFixed(4)} comps=${extraction.components.length} groups=${extraction.groups.length} best=${
        extraction.best
          ? `${extraction.best.minX},${extraction.best.minY}-${extraction.best.maxX},${extraction.best.maxY} area=${extraction.best.area}`
          : 'none'
      } norm p50=${p(0.5).toFixed(2)} p90=${p(0.9).toFixed(2)} p99=${p(0.99).toFixed(2)} max=${values.at(-1)?.toFixed(2) ?? '0'} pred=${result.digit} state=${result.state} conf=${result.confidence.toFixed(2)}`,
    );
  }
}
for (const transform of activeTransforms) {
  let correct = 0;
  let accepted = 0;
  let acceptedCorrect = 0;
  let blank = 0;
  const errors: string[] = [];
  const acceptedErrors: string[] = [];
  for (const row of rows) {
    const cell = transform.apply(row.cell);
    const result = recognizeCell(cell, DEFAULT_SETTINGS, row.row, recognitionOptions);
    if (result.digit === row.label) correct++;
    else errors.push(`${row.sheet}-${row.set}${row.row}:${result.digit ?? 'null'}->${row.label}`);
    if (result.state === 'answered') {
      accepted++;
      if (result.digit === row.label) acceptedCorrect++;
      else {
        acceptedErrors.push(
          `${row.sheet}-${row.set}${row.row}:${result.digit ?? 'null'}->${row.label} (${result.confidence.toFixed(3)}/${result.margin.toFixed(3)})`,
        );
      }
    }
    if (result.state === 'blank') blank++;
  }
  const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) : 'n/a');
  console.log(
    `${transform.name.padEnd(14)} ${correct}/${rows.length} (${pct(correct, rows.length)}%) accepted=${accepted} acceptedCorrect=${acceptedCorrect} (${pct(acceptedCorrect, accepted)}%) blank=${blank}`,
  );
  if (process.argv.includes('--errors')) {
    console.log(`  errors: ${errors.join(' ')}`);
    console.log(`  accepted errors: ${acceptedErrors.join(' ')}`);
  }
}
