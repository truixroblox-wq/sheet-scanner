import fs from 'node:fs';
import { PNG } from 'pngjs';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { recognizeCell, type RecognitionSettings } from '../src/lib/ocr/recognize';
import {
  matchReference,
  shouldFlagReference,
  hogFeatures,
  type ReferenceCorpus,
  type ReferenceMatch,
} from '../src/lib/ocr/features';
import { DEFAULT_KEY, DEFAULT_SETTINGS, TABLE_HEIGHT, TABLE_WIDTH } from '../src/lib/config';
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

interface LabelSheet {
  id: string;
  file: string;
  notes?: string;
  labels: Record<SetId, Array<number | null>>;
}

interface CellData {
  sheet: string;
  set: SetId;
  row: number;
  label: number | null;
  vector: Float32Array | null;
  baseline: CellResult;
  reference?: ReferenceMatch | null;
  state?: CellResult['state'];
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

function isCorrect(cell: CellData, state: CellResult['state']): boolean {
  return cell.baseline.digit === cell.label && state !== 'obstructed';
}

function percentage(value: number, total: number): string {
  return total ? `${((value / total) * 100).toFixed(1)}%` : 'n/a';
}

function buildCorpus(cells: CellData[], excludedSheet: string): ReferenceCorpus {
  const features: Uint8Array[] = [];
  const labels: number[] = [];
  for (const cell of cells) {
    if (cell.sheet === excludedSheet || cell.label === null || !cell.vector) continue;
    features.push(hogFeatures(cell.vector));
    labels.push(cell.label);
  }
  return {
    features,
    labels: Uint8Array.from(labels),
  };
}

function summarize(cells: CellData[], useReference: boolean) {
  let accepted = 0;
  let acceptedCorrect = 0;
  let acceptedWrong = 0;
  let flagged = 0;
  let flaggedWrong = 0;
  let wrong = 0;
  for (const cell of cells) {
    const state = useReference ? (cell.state ?? cell.baseline.state) : cell.baseline.state;
    const digit = cell.baseline.digit;
    const correct = digit === cell.label;
    if (!correct) wrong++;
    if (state === 'answered') {
      accepted++;
      if (correct) acceptedCorrect++;
      else acceptedWrong++;
    } else {
      flagged++;
      if (!correct) flaggedWrong++;
    }
  }
  return { accepted, acceptedCorrect, acceptedWrong, flagged, flaggedWrong, wrong };
}

const settings: RecognitionSettings = {
  confidenceThreshold: DEFAULT_SETTINGS.confidenceThreshold,
  marginThreshold: DEFAULT_SETTINGS.marginThreshold,
};
const setLabels = JSON.parse(
  fs.readFileSync('samples/validation/reference-set-3/labels.json', 'utf8'),
) as { sheets: LabelSheet[] };
const reference2 = JSON.parse(
  fs.readFileSync('samples/validation/reference-2-labels.json', 'utf8'),
) as { labels: Record<SetId, number[]> };
const allSheets: LabelSheet[] = [
  ...setLabels.sheets,
  {
    id: 'reference-2',
    file: 'samples/reference-2.png',
    labels: reference2.labels,
  },
];

const allCells: CellData[] = [];
const sheetTimes = new Map<string, number>();
const matchTimes = new Map<string, number>();
const totalStarted = performance.now();

for (const sheet of allSheets) {
  const started = performance.now();
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
    cells[set].forEach((cellImage, index) => {
      const row = index + 1;
      const label = sheet.labels[set][index] ?? null;
      const baseline = recognizeCell(cellImage, settings, row);
      const extraction = extractCell(cellImage);
      const vector =
        extraction.best && extraction.best.area >= 18
          ? normalizeCell(extraction, extraction.best)
          : null;
      allCells.push({
        sheet: sheet.id,
        set,
        row,
        label,
        vector,
        baseline,
      });
    });
  }
  sheetTimes.set(sheet.id, performance.now() - started);
}

const set3Cells = allCells.filter((cell) => cell.sheet.startsWith('reference-set-3-'));
const set3Sheets = setLabels.sheets.map((sheet) => sheet.id);
const perSheet: Array<{
  id: string;
  baseline: ReturnType<typeof summarize>;
  reference: ReturnType<typeof summarize>;
  caught: number;
  lost: number;
  matchMs: number;
}> = [];

for (const sheetId of set3Sheets) {
  const corpus = buildCorpus(allCells, sheetId);
  const cells = set3Cells.filter((cell) => cell.sheet === sheetId);
  const matchStarted = performance.now();
  for (const cell of cells) {
    if (cell.baseline.state === 'answered' && cell.vector) {
      const match = matchReference(cell.vector, corpus);
      cell.reference = match;
      cell.state = shouldFlagReference(cell.baseline.digit, match)
        ? 'uncertain'
        : cell.baseline.state;
    } else {
      cell.reference = null;
      cell.state = cell.baseline.state;
    }
  }
  const baseline = summarize(cells, false);
  const reference = summarize(cells, true);
  const caught = cells.filter(
    (cell) =>
      cell.baseline.digit !== cell.label &&
      cell.baseline.state === 'answered' &&
      cell.state !== 'answered',
  ).length;
  const lost = cells.filter(
    (cell) =>
      cell.baseline.digit === cell.label &&
      cell.baseline.state === 'answered' &&
      cell.state !== 'answered',
  ).length;
  perSheet.push({
    id: sheetId,
    baseline,
    reference,
    caught,
    lost,
    matchMs: performance.now() - matchStarted,
  });
}

const totalMs = performance.now() - totalStarted;
const baseline = summarize(set3Cells, false);
const reference = summarize(set3Cells, true);
const labeledCells = set3Cells.filter((cell) => cell.label !== null).length;
const blankCells = set3Cells.length - labeledCells;
const blankClean = set3Cells.filter(
  (cell) => cell.label === null && cell.baseline.state === 'blank',
).length;
const caught = perSheet.reduce((sum, sheet) => sum + sheet.caught, 0);
const lost = perSheet.reduce((sum, sheet) => sum + sheet.lost, 0);
const totalMatchMs = perSheet.reduce((sum, sheet) => sum + sheet.matchMs, 0);

console.log('Reference set 3 metrics (leave-one-sheet-out reference corpus)');
console.log(
  `cells ${set3Cells.length}, labeled ${labeledCells}, blank ${blankCells}, clean blanks ${blankClean}/${blankCells}`,
);
console.log(
  `baseline: wrong ${baseline.wrong} (${percentage(baseline.wrong, set3Cells.length)}), accuracy ${percentage(set3Cells.length - baseline.wrong, set3Cells.length)}, auto ${baseline.accepted}, auto-correct ${baseline.acceptedCorrect}, auto-wrong ${baseline.acceptedWrong}, flagged ${baseline.flagged}`,
);
console.log(
  `reference: wrong ${reference.wrong} (${percentage(reference.wrong, set3Cells.length)}), accuracy ${percentage(set3Cells.length - reference.wrong, set3Cells.length)}, auto ${reference.accepted}, auto-correct ${reference.acceptedCorrect}, auto-wrong ${reference.acceptedWrong}, flagged ${reference.flagged}`,
);
console.log(
  `reference check caught ${caught} confident errors, added ${lost} correct cells to review, match time ${totalMatchMs.toFixed(0)} ms total (${(totalMatchMs / set3Sheets.length).toFixed(0)} ms/sheet)`,
);
console.log(`full validation run ${(totalMs / 1000).toFixed(1)} s`);

for (const sheet of perSheet) {
  console.log(
    `${sheet.id}: baseline auto ${sheet.baseline.accepted}/60 wrong ${sheet.baseline.acceptedWrong}; reference auto ${sheet.reference.accepted}/60 wrong ${sheet.reference.acceptedWrong}; flagged ${sheet.reference.flagged}; caught ${sheet.caught}, lost ${sheet.lost}, ${sheet.matchMs.toFixed(0)} ms`,
  );
  const errors = set3Cells.filter(
    (cell) => cell.sheet === sheet.id && cell.state === 'answered' && cell.baseline.digit !== cell.label,
  );
  if (errors.length) {
    console.log(
      `  remaining confident errors: ${errors
        .map(
          (cell) =>
            `${cell.set}${cell.row} ${cell.label}->${cell.baseline.digit} (ref ${cell.reference?.digit ?? '?'}@${cell.reference?.confidence.toFixed(2) ?? '0'})`,
        )
        .join(', ')}`,
    );
  }
}

const ref2Cells = allCells.filter((cell) => cell.sheet === 'reference-2');
const ref2Corpus = buildCorpus(allCells, 'reference-2');
for (const cell of ref2Cells) {
  if (cell.baseline.state === 'answered' && cell.vector) {
    const match = matchReference(cell.vector, ref2Corpus);
    cell.reference = match;
    cell.state = shouldFlagReference(cell.baseline.digit, match)
      ? 'uncertain'
      : cell.baseline.state;
  } else {
    cell.reference = null;
    cell.state = cell.baseline.state;
  }
}
function reference2Score(useReference: boolean): number {
  const results = {} as Record<SetId, CellResult[]>;
  for (const set of SET_IDS) {
    results[set] = ref2Cells
      .filter((cell) => cell.set === set)
      .map((cell) => ({
        ...cell.baseline,
        state: useReference ? (cell.state ?? cell.baseline.state) : cell.baseline.state,
      }));
  }
  return scoreScan(results, DEFAULT_KEY, 'wrong').total;
}
const ref2Baseline = summarize(ref2Cells, false);
const ref2Reference = summarize(ref2Cells, true);
console.log(
  `reference-2: model score ${reference2Score(false)} baseline / ${reference2Score(true)} reference; auto ${ref2Baseline.accepted}->${ref2Reference.accepted}, auto-wrong ${ref2Baseline.acceptedWrong}->${ref2Reference.acceptedWrong}, flagged ${ref2Baseline.flagged}->${ref2Reference.flagged}`,
);

const predictions = allCells.map((cell) => ({
  sheet: cell.sheet,
  set: cell.set,
  row: cell.row,
  label: cell.label,
  digit: cell.baseline.digit,
  confidence: cell.baseline.confidence,
  margin: cell.baseline.margin,
  baselineState: cell.baseline.state,
  state: cell.state ?? cell.baseline.state,
  referenceDigit: cell.reference?.digit ?? null,
  referenceConfidence: cell.reference?.confidence ?? null,
  referenceMargin: cell.reference?.margin ?? null,
  referenceDistance: cell.reference?.distance ?? null,
  holes: cell.reference?.holes ?? null,
  area: cell.baseline.area,
}));

fs.writeFileSync(
  'samples/validation/reference-set-3/pipeline-predictions.json',
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      settings,
      summary: {
        total: set3Cells.length,
        labeledCells,
        blankCells,
        blankClean,
        baseline,
        reference,
        caught,
        lost,
        totalMatchMs,
        totalMs,
      },
      perSheet,
      reference2: {
        baseline: ref2Baseline,
        reference: ref2Reference,
        modelScoreBaseline: reference2Score(false),
        modelScoreReference: reference2Score(true),
      },
      predictions,
    },
    null,
    2,
  )}\n`,
);
console.log('Wrote samples/validation/reference-set-3/pipeline-predictions.json');
