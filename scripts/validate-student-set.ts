/**
 * Validate the handwritten-digit pipeline on the hand-verified student set.
 *
 * Input tables are the production rectified tables (1500x1463), so this
 * measures grid alignment, segmentation, recognition, and confidence gating
 * but excludes table detection and perspective correction. Timing excludes
 * one warm-up recognition pass and the one-time model/reference decode.
 *
 * Usage:
 *   npx tsx scripts/validate-student-set.ts
 *   npx tsx scripts/validate-student-set.ts --mode merged --side 0.04
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { getReferenceCorpus } from '../src/lib/ocr/reference';
import {
  DEFAULT_SETTINGS,
  MAX_CLASS,
  MIN_CLASS,
} from '../src/lib/config';
import { SET_IDS, type CellResult, type SetId } from '../src/types';

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
const argValue = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const mode = argValue('--mode', 'merged') as 'legacy' | 'merged';
const sideFraction = Number(argValue('--side', '0.04'));
const devIds = ['S001', 'S002', 'S003', 'S004'];
const testIds = ['S005', 'S006', 'S007', 'S008'];
const ids = [...devIds, ...testIds].filter((id) => labels.sheets[id]?.verified);

function readJpeg(file: string): ImageData {
  const decoded = jpeg.decode(fs.readFileSync(file), {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
  });
  return new NodeImageData(decoded.data as Uint8ClampedArray, decoded.width, decoded.height);
}

function clearSides(cell: ImageData, fraction: number): ImageData {
  if (fraction <= 0) return cell;
  const copy = new NodeImageData(new Uint8ClampedArray(cell.data), cell.width, cell.height);
  const margin = Math.round(cell.width * fraction);
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < margin; x++) {
      for (const xx of [x, cell.width - 1 - x]) {
        const i = (y * cell.width + xx) * 4;
        copy.data[i] = 245;
        copy.data[i + 1] = 245;
        copy.data[i + 2] = 245;
        copy.data[i + 3] = 255;
      }
    }
  }
  return copy;
}

interface RecordRow {
  sheet: string;
  fold: 'dev' | 'test';
  set: SetId;
  row: number;
  label: number;
  result: CellResult;
}

const referenceCorpus = getReferenceCorpus();
if (!referenceCorpus) throw new Error('reference corpus is unavailable');

// Warm up the CNN, TTA rotation maps, and reference matcher.
{
  const warm = new NodeImageData(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64);
  recognizeCell(warm, DEFAULT_SETTINGS, 1, {
    referenceCorpus,
    segmentation: mode,
  });
}

const records: RecordRow[] = [];
const timings: Array<{ sheet: string; ms: number }> = [];
for (const id of ids) {
  const started = performance.now();
  const table = readJpeg(path.join(root, 'review-tables', `${id}.jpg`));
  const geometry = detectGrid(table);
  const cells = cropCells(table, geometry);
  for (let s = 0; s < SET_IDS.length; s++) {
    const set = SET_IDS[s];
    for (let r = 0; r < 12; r++) {
      const label = labels.sheets[id].labels[set][r];
      const cell = clearSides(cells[set][r], sideFraction);
      const result = recognizeCell(cell, DEFAULT_SETTINGS, r + 1, {
        referenceCorpus,
        segmentation: mode,
      });
      if (label == null) continue;
      records.push({
        sheet: id,
        fold: devIds.includes(id) ? 'dev' : 'test',
        set,
        row: r + 1,
        label,
        result,
      });
    }
  }
  timings.push({ sheet: id, ms: performance.now() - started });
}

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) : 'n/a');
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function summarize(label: string, subset: RecordRow[]) {
  const total = subset.length;
  const correct = subset.filter((r) => r.result.digit === r.label).length;
  const accepted = subset.filter((r) => r.result.state === 'answered');
  const acceptedCorrect = accepted.filter((r) => r.result.digit === r.label).length;
  const uncertain = subset.filter((r) => r.result.state === 'uncertain').length;
  const blank = subset.filter((r) => r.result.state === 'blank').length;
  const obstructed = subset.filter((r) => r.result.state === 'obstructed').length;
  const confidentErrors = subset.filter(
    (r) =>
      r.result.state === 'answered' &&
      r.result.digit !== r.label,
  );
  const gateErrors = subset.filter(
    (r) =>
      r.result.digit !== r.label &&
      r.result.confidence >= DEFAULT_SETTINGS.confidenceThreshold &&
      r.result.margin >= DEFAULT_SETTINGS.marginThreshold,
  );
  console.log(`\n${label}`);
  console.log(`  verified cells: ${total}`);
  console.log(`  correct: ${correct} (${pct(correct, total)}%)`);
  console.log(`  auto-accepted: ${accepted.length} (${pct(accepted.length, total)}%), precision ${pct(acceptedCorrect, accepted.length)}%`);
  console.log(`  reviewable: uncertain ${uncertain}, blank ${blank}, obstructed ${obstructed}`);
  console.log(`  high-confidence errors (answered): ${confidentErrors.length}`);
  console.log(`  gate-passing errors (conf/margin): ${gateErrors.length}`);
  if (confidentErrors.length) {
    console.log(
      `  ${confidentErrors
        .map(
          (r) =>
            `${r.sheet}-${r.set}${r.row}: pred ${r.result.digit} vs ${r.label} (${r.result.confidence.toFixed(2)}/${r.result.margin.toFixed(2)})`,
        )
        .join('; ')}`,
    );
  }
}

console.log(`mode=${mode} sideMargin=${sideFraction}`);
console.log('Development S001-S004; held-out test S005-S008.');
summarize('ALL', records);
summarize('DEV', records.filter((r) => r.fold === 'dev'));
summarize('TEST', records.filter((r) => r.fold === 'test'));

for (const fold of ['dev', 'test'] as const) {
  console.log(`\nPer sheet (${fold})`);
  for (const id of fold === 'dev' ? devIds : testIds) {
    const subset = records.filter((r) => r.sheet === id);
    const correct = subset.filter((r) => r.result.digit === r.label).length;
    const accepted = subset.filter((r) => r.result.state === 'answered');
    const acceptedCorrect = accepted.filter((r) => r.result.digit === r.label).length;
    console.log(
      `  ${id}: ${correct}/${subset.length} (${pct(correct, subset.length)}%), accepted ${accepted.length}/${subset.length}, accepted-correct ${acceptedCorrect}`,
    );
  }
}

console.log('\nPer digit (all verified cells)');
for (let digit = MIN_CLASS; digit <= MAX_CLASS; digit++) {
  const subset = records.filter((r) => r.label === digit);
  const correct = subset.filter((r) => r.result.digit === digit).length;
  console.log(`  ${digit}: ${correct}/${subset.length} (${pct(correct, subset.length)}%)`);
}

console.log('\nPer set (all verified cells)');
for (const set of SET_IDS) {
  const subset = records.filter((r) => r.set === set);
  const correct = subset.filter((r) => r.result.digit === r.label).length;
  console.log(`  ${set}: ${correct}/${subset.length} (${pct(correct, subset.length)}%)`);
}

if (args.includes('--errors')) {
  console.log('\nAll digit errors');
  const errors = records.filter((r) => r.result.digit !== r.label);
  const pairs = new Map<string, number>();
  for (const r of errors) {
    const key = `${r.result.digit}->${r.label}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  console.log(
    `  confusion counts: ${[...pairs.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key} x${count}`)
      .join(', ')}`,
  );
  for (const r of errors) {
    console.log(
      `  ${r.sheet}-${r.set}${r.row} pred=${r.result.digit} label=${r.label} state=${r.result.state} conf=${r.result.confidence.toFixed(2)} margin=${r.result.margin.toFixed(2)} area=${r.result.area}`,
    );
  }
}

const summarizeJson = (subset: RecordRow[]) => {
  const total = subset.length;
  const correct = subset.filter((r) => r.result.digit === r.label).length;
  const accepted = subset.filter((r) => r.result.state === 'answered');
  const acceptedCorrect = accepted.filter((r) => r.result.digit === r.label).length;
  return {
    cells: total,
    correct,
    accuracyPct: total ? Number(((correct / total) * 100).toFixed(2)) : null,
    autoAccepted: accepted.length,
    autoAcceptRatePct: total ? Number(((accepted.length / total) * 100).toFixed(2)) : null,
    autoAcceptedCorrect: acceptedCorrect,
    autoAcceptedPrecisionPct: accepted.length
      ? Number(((acceptedCorrect / accepted.length) * 100).toFixed(2))
      : null,
    uncertain: subset.filter((r) => r.result.state === 'uncertain').length,
    blank: subset.filter((r) => r.result.state === 'blank').length,
    obstructed: subset.filter((r) => r.result.state === 'obstructed').length,
    highConfidenceErrors: subset.filter(
      (r) => r.result.state === 'answered' && r.result.digit !== r.label,
    ).length,
    gatePassingErrors: subset.filter(
      (r) =>
        r.result.digit !== r.label &&
        r.result.confidence >= DEFAULT_SETTINGS.confidenceThreshold &&
        r.result.margin >= DEFAULT_SETTINGS.marginThreshold,
    ).length,
  };
};

const report = {
  dataset: 'samples/student-set-1',
  mode,
  sideMargin: sideFraction,
  thresholds: {
    confidence: DEFAULT_SETTINGS.confidenceThreshold,
    margin: DEFAULT_SETTINGS.marginThreshold,
  },
  split: {
    development: devIds,
    heldOutTest: testIds,
  },
  all: summarizeJson(records),
  dev: summarizeJson(records.filter((r) => r.fold === 'dev')),
  test: summarizeJson(records.filter((r) => r.fold === 'test')),
  perSheet: Object.fromEntries(
    ids.map((id) => [id, summarizeJson(records.filter((r) => r.sheet === id))]),
  ),
  perSet: Object.fromEntries(
    SET_IDS.map((set) => [
      set,
      summarizeJson(records.filter((r) => r.set === set)),
    ]),
  ),
  perDigit: Object.fromEntries(
    Array.from({ length: MAX_CLASS - MIN_CLASS + 1 }, (_, index) => {
      const digit = MIN_CLASS + index;
      return [
        digit,
        summarizeJson(records.filter((r) => r.label === digit)),
      ];
    }),
  ),
  errors: records
    .filter((r) => r.result.digit !== r.label)
    .map((r) => ({
      sheet: r.sheet,
      set: r.set,
      row: r.row,
      predicted: r.result.digit,
      actual: r.label,
      state: r.result.state,
      confidence: Number(r.result.confidence.toFixed(4)),
      margin: Number(r.result.margin.toFixed(4)),
    })),
  timing: {
    scope: 'rectified table -> detection/crop + 60 recognitions; warm, excludes JPEG decode and model load',
    sheetCount: timings.length,
    totalMs: Number(timings.reduce((sum, t) => sum + t.ms, 0).toFixed(0)),
    meanMs: Number((timings.reduce((sum, t) => sum + t.ms, 0) / timings.length).toFixed(0)),
    medianMs: Number(median(timings.map((t) => t.ms)).toFixed(0)),
    minMs: Number(Math.min(...timings.map((t) => t.ms)).toFixed(0)),
    maxMs: Number(Math.max(...timings.map((t) => t.ms)).toFixed(0)),
  },
};
const jsonOutIndex = args.indexOf('--json-out');
if (jsonOutIndex >= 0 && args[jsonOutIndex + 1]) {
  const file = path.resolve(args[jsonOutIndex + 1]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${file}`);
}

const times = timings.map((t) => t.ms);
console.log('\nTiming (rectified 1500x1463 table -> 60 recognitions, warm)');
console.log(`  total ${times.reduce((a, b) => a + b, 0).toFixed(0)} ms`);
console.log(`  mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(0)} ms/sheet`);
console.log(`  median ${median(times).toFixed(0)} ms/sheet`);
console.log(`  min ${Math.min(...times).toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms`);
