import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { predictMnist } from '../src/lib/ocr/cnn';
import { recognizeCell, type RecognitionSettings } from '../src/lib/ocr/recognize';
import { DEFAULT_SETTINGS, TABLE_HEIGHT, TABLE_WIDTH } from '../src/lib/config';
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

interface SheetLabels {
  id: string;
  file: string;
  labels: Record<SetId, Array<number | null>>;
}

interface Sample {
  sheet: string;
  set: SetId;
  row: number;
  label: number | null;
  vector: Float32Array | null;
  holes: number;
  cnnDigit: number | null;
  cnnConfidence: number;
  cnnMargin: number;
  cnnState: string;
  cnnProbabilities: Float32Array | null;
}

function countHoles(vector: Float32Array, threshold = 0.2): number {
  const size = 28;
  const ink = new Uint8Array(size * size);
  for (let i = 0; i < ink.length; i++) ink[i] = vector[i] > threshold ? 1 : 0;
  const visited = new Uint8Array(size * size);
  let holes = 0;
  for (let start = 0; start < ink.length; start++) {
    if (ink[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    let area = 0;
    let touchesBorder = false;
    while (stack.length) {
      const index = stack.pop()!;
      const x = index % size;
      const y = (index / size) | 0;
      area++;
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) touchesBorder = true;
      for (const next of [index - 1, index + 1, index - size, index + size]) {
        if (next < 0 || next >= ink.length) continue;
        const nx = next % size;
        if (Math.abs(nx - x) > 1) continue;
        if (ink[next] || visited[next]) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }
    if (!touchesBorder && area >= 2) holes++;
  }
  return holes;
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

function permitted(probabilities: ArrayLike<number>) {
  let total = 0;
  for (let d = 1; d <= 8; d++) total += probabilities[d];
  if (total <= 0) return null;
  let digit = 1;
  let best = 0;
  let second = 0;
  for (let d = 1; d <= 8; d++) {
    const p = probabilities[d];
    if (p > best) {
      second = best;
      best = p;
      digit = d;
    } else if (p > second) {
      second = p;
    }
  }
  return { digit, confidence: best / total, margin: (best - second) / total };
}

function downsample(vector: Float32Array, size: number): Float32Array {
  const out = new Float32Array(size * size);
  const block = 28 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let count = 0;
      const x0 = Math.floor(x * block);
      const y0 = Math.floor(y * block);
      const x1 = Math.floor((x + 1) * block);
      const y1 = Math.floor((y + 1) * block);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += vector[sy * 28 + sx];
          count++;
        }
      }
      out[y * size + x] = count ? sum / count : 0;
    }
  }
  return out;
}

function hog(vector: Float32Array, cellSize = 7, bins = 9): Float32Array {
  const size = 28;
  const cells = Math.floor(size / cellSize);
  const hist = new Float32Array(cells * cells * bins);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const gx = vector[y * size + x + 1] - vector[y * size + x - 1];
      const gy = vector[(y + 1) * size + x] - vector[(y - 1) * size + x];
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < 1e-4) continue;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      if (angle >= Math.PI) angle -= Math.PI;
      const bin = Math.min(bins - 1, Math.floor((angle / Math.PI) * bins));
      const cellX = Math.min(cells - 1, Math.floor(x / cellSize));
      const cellY = Math.min(cells - 1, Math.floor(y / cellSize));
      hist[(cellY * cells + cellX) * bins + bin] += magnitude;
    }
  }
  const blocks: number[] = [];
  for (let by = 0; by < cells - 1; by++) {
    for (let bx = 0; bx < cells - 1; bx++) {
      const block: number[] = [];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const base = ((by + dy) * cells + (bx + dx)) * bins;
          for (let b = 0; b < bins; b++) block.push(hist[base + b]);
        }
      }
      const norm = Math.sqrt(block.reduce((sum, value) => sum + value * value, 0)) + 1e-6;
      for (const value of block) blocks.push(value / norm);
    }
  }
  return new Float32Array(blocks);
}

function distance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

function neighbors(
  vector: Float32Array,
  train: Sample[],
  maxK: number,
  features: Map<Sample, Float32Array>,
): Array<{ label: number; distance: number }> {
  const result: Array<{ label: number; distance: number }> = [];
  for (const sample of train) {
    if (!sample.vector || sample.label === null) continue;
    const d = distance(vector, features.get(sample)!);
    if (result.length < maxK || d < result[result.length - 1].distance) {
      let index = result.length;
      while (index > 0 && result[index - 1].distance > d) index--;
      result.splice(index, 0, { label: sample.label, distance: d });
      if (result.length > maxK) result.pop();
    }
  }
  return result;
}

function fromNeighbors(
  list: Array<{ label: number; distance: number }>,
  k: number,
): { digit: number; confidence: number; margin: number; distance: number } | null {
  const selected = list.slice(0, k);
  if (!selected.length) return null;
  const weights = new Map<number, number>();
  for (const neighbor of selected) {
    const weight = 1 / (neighbor.distance + 1e-3);
    weights.set(neighbor.label, (weights.get(neighbor.label) ?? 0) + weight);
  }
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((sum, [, value]) => sum + value, 0);
  const [digit, best] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  return {
    digit,
    confidence: best / total,
    margin: (best - second) / total,
    distance: selected[0].distance,
  };
}

const settings: RecognitionSettings = {
  confidenceThreshold: DEFAULT_SETTINGS.confidenceThreshold,
  marginThreshold: DEFAULT_SETTINGS.marginThreshold,
};
const setLabels = JSON.parse(
  fs.readFileSync('samples/validation/reference-set-3/labels.json', 'utf8'),
) as { sheets: SheetLabels[] };
const reference2 = JSON.parse(
  fs.readFileSync('samples/validation/reference-2-labels.json', 'utf8'),
) as { labels: Record<SetId, number[]> };
const sheets: SheetLabels[] = [
  ...setLabels.sheets,
  {
    id: 'reference-2',
    file: 'samples/reference-2.png',
    labels: reference2.labels,
  },
];

const samples: Sample[] = [];
for (const sheet of sheets) {
  const source = readImage(sheet.file);
  const small = resize(source, 1200);
  const quad = detectTableQuad(grayscale(small), small.width, small.height);
  if (!quad) throw new Error(`No table in ${sheet.file}`);
  const quadFull = quad.map((point) => ({
    x: point.x * (source.width / small.width),
    y: point.y * (source.height / small.height),
  }));
  const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
  const geometry = detectGrid(warped);
  const cells = cropCells(warped, geometry);
  for (const set of SET_IDS) {
    cells[set].forEach((cell, index) => {
      const row = index + 1;
      const label = sheet.labels[set][index] ?? null;
      const result = recognizeCell(cell, settings, row);
      const extraction = extractCell(cell);
      let vector: Float32Array | null = null;
      let probabilities: Float32Array | null = null;
      if (extraction.best && extraction.best.area >= 18) {
        vector = normalizeCell(extraction, extraction.best);
        probabilities = predictMnist(vector).probabilities;
      }
      samples.push({
        sheet: sheet.id,
        set,
        row,
        label,
        vector,
        holes: vector ? countHoles(vector) : 0,
        cnnDigit: result.digit,
        cnnConfidence: result.confidence,
        cnnMargin: result.margin,
        cnnState: result.state,
        cnnProbabilities: probabilities,
      });
    });
  }
}

const digitSamples = samples.filter((sample) => sample.label !== null && sample.vector);
const sheetIds = [...new Set(samples.map((sample) => sample.sheet))];
const testSheetIds = setLabels.sheets.map((sheet) => sheet.id);
console.log(
  `samples ${samples.length}, labeled vectors ${digitSamples.length}, sheets ${sheetIds.length}`,
);

const verificationRecords: Array<{
  sample: Sample;
  cnnDistance: number;
  bestOther: number;
  bestOtherDistance: number;
  ratio: number;
  gap: number;
}> = [];

for (const sheet of testSheetIds) {
  const train = digitSamples.filter((sample) => sample.sheet !== sheet);
  const test = digitSamples.filter((sample) => sample.sheet === sheet);
  for (const sample of test) {
    if (!sample.vector || !sample.cnnDigit) continue;
    const mins = new Array<number>(9).fill(Infinity);
    for (const candidate of train) {
      if (!candidate.vector || candidate.label === null) continue;
      const d = distance(sample.vector, candidate.vector);
      if (d < mins[candidate.label]) mins[candidate.label] = d;
    }
    const cnnDistance = mins[sample.cnnDigit];
    let bestOther = 0;
    let bestOtherDistance = Infinity;
    for (let digit = 1; digit <= 8; digit++) {
      if (digit === sample.cnnDigit) continue;
      if (mins[digit] < bestOtherDistance) {
        bestOtherDistance = mins[digit];
        bestOther = digit;
      }
    }
    if (!Number.isFinite(cnnDistance) || !Number.isFinite(bestOtherDistance)) continue;
    verificationRecords.push({
      sample,
      cnnDistance,
      bestOther,
      bestOtherDistance,
      ratio: bestOtherDistance / Math.max(1e-6, cnnDistance),
      gap: cnnDistance - bestOtherDistance,
    });
  }
}

const baselineAutoWrong = verificationRecords.filter(
  (record) => record.sample.cnnState === 'answered' && record.sample.cnnDigit !== record.sample.label,
).length;
const baselineAutoCorrect = verificationRecords.filter(
  (record) => record.sample.cnnState === 'answered' && record.sample.cnnDigit === record.sample.label,
).length;
console.log(`verification baseline: auto-wrong ${baselineAutoWrong}, auto-correct ${baselineAutoCorrect}`);
for (const record of verificationRecords.filter(
  (item) => item.sample.cnnState === 'answered' && item.sample.cnnDigit !== item.sample.label,
)) {
  console.log(
    `  auto-error ${record.sample.sheet} ${record.sample.set}${record.sample.row} ${record.sample.label} cnn${record.sample.cnnDigit} holes=${record.sample.holes}: cnnD=${record.cnnDistance.toFixed(0)} other${record.bestOther}D=${record.bestOtherDistance.toFixed(0)} ratio=${record.ratio.toFixed(2)} gap=${record.gap.toFixed(0)}`,
  );
}
const autoAnswered = digitSamples.filter((sample) => sample.cnnState === 'answered');
const autoErrors = autoAnswered.filter((sample) => sample.cnnDigit !== sample.label);
for (const threshold of [1, 2]) {
  for (const digits of [
    [7],
    [2],
    [1],
    [6],
    [7, 2],
    [7, 2, 1],
  ]) {
    const flagged = autoAnswered.filter(
      (sample) => digits.includes(sample.cnnDigit ?? 0) && sample.holes >= threshold,
    );
    const caught = flagged.filter((sample) => sample.cnnDigit !== sample.label).length;
    const lost = flagged.filter((sample) => sample.cnnDigit === sample.label).length;
    console.log(
      `holes>=${threshold} digit ${digits.join('/')}: flagged ${flagged.length}, caught ${caught}/${autoErrors.length}, lost ${lost}, left ${autoErrors.length - caught}`,
    );
  }
}
const autoVerification = verificationRecords.filter(
  (record) => record.sample.cnnState === 'answered',
);
const autoVerificationErrors = autoVerification.filter(
  (record) => record.sample.cnnDigit !== record.sample.label,
);
for (const threshold of [20, 30, 40, 50, 60, 70, 80]) {
  const flagged = autoVerification.filter((record) => record.cnnDistance > threshold);
  const caught = flagged.filter((record) => record.sample.cnnDigit !== record.sample.label).length;
  const lost = flagged.filter((record) => record.sample.cnnDigit === record.sample.label).length;
  console.log(
    `reference distance >${threshold}: flagged ${flagged.length}, caught ${caught}/${autoVerificationErrors.length}, lost ${lost}, left ${autoVerificationErrors.length - caught}`,
  );
}
for (const ratio of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  for (const gap of [0, 10, 20, 30, 40]) {
    const condition = verificationRecords.filter(
      (record) =>
        record.sample.cnnState === 'answered' &&
        record.ratio < ratio &&
        record.gap > gap &&
        record.bestOther !== record.sample.cnnDigit,
    );
    const caughtErrors = condition.filter(
      (record) => record.sample.cnnDigit !== record.sample.label,
    ).length;
    const lostCorrect = condition.filter(
      (record) => record.sample.cnnDigit === record.sample.label,
    ).length;
    const repaired = condition.filter(
      (record) => record.bestOther === record.sample.label && record.sample.cnnDigit !== record.sample.label,
    ).length;
    console.log(
      `ratio<${ratio} gap>${gap}: condition ${condition.length}, caught ${caughtErrors}/${baselineAutoWrong}, lost ${lostCorrect}, repair ${repaired}`,
    );
  }
}
const kValues = [1, 3, 5, 7];
const featureSets: Array<{ name: string; map: Map<Sample, Float32Array> }> = [
  {
    name: 'raw28',
    map: new Map(digitSamples.map((sample) => [sample, sample.vector!])),
  },
  {
    name: 'down14',
    map: new Map(digitSamples.map((sample) => [sample, downsample(sample.vector!, 14)])),
  },
  {
    name: 'hog7',
    map: new Map(digitSamples.map((sample) => [sample, hog(sample.vector!, 7)])),
  },
  {
    name: 'hog4',
    map: new Map(digitSamples.map((sample) => [sample, hog(sample.vector!, 4)])),
  },
];

const ENABLE_KNN = false;
for (const feature of ENABLE_KNN ? featureSets : []) {
  const records = new Map<number, Array<{ sample: Sample; prediction: NonNullable<ReturnType<typeof fromNeighbors>> }>>(
    kValues.map((k) => [k, []]),
  );
  for (const sheet of testSheetIds) {
    const train = digitSamples.filter((sample) => sample.sheet !== sheet);
    const test = digitSamples.filter((sample) => sample.sheet === sheet);
    for (const sample of test) {
      const list = neighbors(feature.map.get(sample)!, train, 7, feature.map);
      for (const k of kValues) {
        const prediction = fromNeighbors(list, k);
        if (!prediction) continue;
        records.get(k)!.push({ sample, prediction });
      }
    }
  }

  for (const k of kValues) {
    const all = records.get(k)!;
    const total = all.length;
    const knnCorrect = all.filter(({ sample, prediction }) => prediction.digit === sample.label).length;
    const cnnCorrect = all.filter(({ sample }) => sample.cnnDigit === sample.label).length;
    const auto = all.filter(({ sample }) => sample.cnnState === 'answered');
    const autoWrong = auto.filter(({ sample }) => sample.cnnDigit !== sample.label);
    const agree = all.filter(({ sample, prediction }) => prediction.digit === sample.cnnDigit);
    const agreeCorrect = agree.filter(({ sample }) => sample.cnnDigit === sample.label).length;
    console.log(
      `feature ${feature.name} k=${k}: knn ${((knnCorrect / total) * 100).toFixed(1)}%, cnn ${((cnnCorrect / total) * 100).toFixed(1)}%, agreement ${agree.length}/${total} (${((agreeCorrect / Math.max(1, agree.length)) * 100).toFixed(1)}% correct)`,
    );
    for (const confidence of [0, 0.5, 0.6, 0.7, 0.8, 0.9]) {
      const flagged = auto.filter(
        ({ sample, prediction }) =>
          prediction.digit !== sample.cnnDigit && prediction.confidence >= confidence,
      );
      const caught = flagged.filter(({ sample }) => sample.cnnDigit !== sample.label).length;
      const lost = flagged.filter(({ sample }) => sample.cnnDigit === sample.label).length;
      console.log(
        `  flag disagreement conf>=${confidence}: flagged ${flagged.length}, caught ${caught}/${autoWrong.length}, lost correct ${lost}, auto-wrong left ${autoWrong.length - caught}`,
      );
    }
    if (feature.name === 'hog7' && k === 3) {
      const remaining = auto.filter(
        ({ sample, prediction }) =>
          sample.cnnDigit !== sample.label &&
          !(prediction.digit !== sample.cnnDigit && prediction.confidence >= 0.6),
      );
      console.log(
        `  remaining auto errors: ${remaining
          .map(
            ({ sample, prediction }) =>
              `${sample.sheet} ${sample.set}${sample.row} ${sample.label}->${sample.cnnDigit} (knn ${prediction.digit}@${prediction.confidence.toFixed(2)})`,
          )
          .join(', ')}`,
      );
    }
  }
}

const linearFeatures = new Map<Sample, Float32Array>();
for (const sample of digitSamples) {
  const hogVector = hog(sample.vector!, 7);
  const vector = new Float32Array(hogVector.length + 1);
  vector.set(hogVector);
  vector[hogVector.length] = sample.holes / 3;
  linearFeatures.set(sample, vector);
}

interface LinearModel {
  weights: Float32Array[];
  biases: Float32Array;
  mean: Float32Array;
  std: Float32Array;
}

function standardize(vector: Float32Array, mean: Float32Array, std: Float32Array): Float32Array {
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] - mean[i]) / std[i];
  return out;
}

function trainSoftmax(
  train: Sample[],
  features: Map<Sample, Float32Array>,
  epochs = 80,
  learningRate = 0.2,
  l2 = 1e-4,
): LinearModel {
  const F = features.get(train[0])!.length;
  const mean = new Float32Array(F);
  const std = new Float32Array(F);
  for (const sample of train) {
    const vector = features.get(sample)!;
    for (let i = 0; i < F; i++) mean[i] += vector[i];
  }
  for (let i = 0; i < F; i++) mean[i] /= train.length;
  for (const sample of train) {
    const vector = features.get(sample)!;
    for (let i = 0; i < F; i++) {
      const diff = vector[i] - mean[i];
      std[i] += diff * diff;
    }
  }
  for (let i = 0; i < F; i++) std[i] = Math.sqrt(std[i] / train.length) + 1e-6;
  const standardized = train.map((sample) => standardize(features.get(sample)!, mean, std));
  const weights = Array.from({ length: 8 }, () => new Float32Array(F));
  const biases = new Float32Array(8);
  const order = train.map((_, index) => index);
  let rate = learningRate;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const index of order) {
      const vector = standardized[index];
      const target = train[index].label! - 1;
      const logits = new Float32Array(8);
      let max = -Infinity;
      for (let digit = 0; digit < 8; digit++) {
        let sum = biases[digit];
        const row = weights[digit];
        for (let f = 0; f < F; f++) sum += row[f] * vector[f];
        logits[digit] = sum;
        if (sum > max) max = sum;
      }
      let total = 0;
      for (let digit = 0; digit < 8; digit++) {
        logits[digit] = Math.exp(logits[digit] - max);
        total += logits[digit];
      }
      for (let digit = 0; digit < 8; digit++) {
        const error = logits[digit] / total - (digit === target ? 1 : 0);
        const row = weights[digit];
        for (let f = 0; f < F; f++) row[f] -= rate * (error * vector[f] + l2 * row[f]);
        biases[digit] -= rate * error;
      }
    }
    rate *= 0.985;
  }
  return { weights, biases, mean, std };
}

function predictLinear(
  model: LinearModel,
  vector: Float32Array,
): { digit: number; confidence: number; margin: number; probabilities: Float32Array } {
  const x = standardize(vector, model.mean, model.std);
  const logits = new Float32Array(8);
  let max = -Infinity;
  for (let digit = 0; digit < 8; digit++) {
    let sum = model.biases[digit];
    const row = model.weights[digit];
    for (let f = 0; f < x.length; f++) sum += row[f] * x[f];
    logits[digit] = sum;
    if (sum > max) max = sum;
  }
  let total = 0;
  for (let digit = 0; digit < 8; digit++) {
    logits[digit] = Math.exp(logits[digit] - max);
    total += logits[digit];
  }
  for (let digit = 0; digit < 8; digit++) logits[digit] /= total;
  let digit = 1;
  let best = 0;
  let second = 0;
  for (let d = 0; d < 8; d++) {
    if (logits[d] > best) {
      second = best;
      best = logits[d];
      digit = d + 1;
    } else if (logits[d] > second) {
      second = logits[d];
    }
  }
  return { digit, confidence: best, margin: best - second, probabilities: logits };
}

const linearRecords: Array<{ sample: Sample; prediction: ReturnType<typeof predictLinear> }> = [];
const linearStarted = performance.now();
for (const sheet of testSheetIds) {
  const train = digitSamples.filter((sample) => sample.sheet !== sheet);
  const test = digitSamples.filter((sample) => sample.sheet === sheet);
  const model = trainSoftmax(train, linearFeatures, 80, 0.2, 1e-4);
  for (const sample of test) {
    linearRecords.push({ sample, prediction: predictLinear(model, linearFeatures.get(sample)!) });
  }
}
console.log(`linear training/eval ${((performance.now() - linearStarted) / 1000).toFixed(1)}s`);
const linearTotal = linearRecords.length;
const linearCorrect = linearRecords.filter(({ sample, prediction }) => prediction.digit === sample.label).length;
console.log(`linear hog+holes: ${((linearCorrect / linearTotal) * 100).toFixed(1)}%`);
const linearAuto = linearRecords.filter(({ sample }) => sample.cnnState === 'answered');
const linearAutoErrors = linearAuto.filter(({ sample }) => sample.cnnDigit !== sample.label);
for (const record of linearAutoErrors) {
  console.log(
    `  linear auto-error ${record.sample.sheet} ${record.sample.set}${record.sample.row} ${record.sample.label} cnn${record.sample.cnnDigit} -> linear${record.prediction.digit}@${record.prediction.confidence.toFixed(2)} margin=${record.prediction.margin.toFixed(2)} holes=${record.sample.holes}`,
  );
}
for (const confidence of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  const flagged = linearAuto.filter(
    ({ sample, prediction }) =>
      prediction.digit !== sample.cnnDigit && prediction.confidence >= confidence,
  );
  const caught = flagged.filter(({ sample }) => sample.cnnDigit !== sample.label).length;
  const lost = flagged.filter(({ sample }) => sample.cnnDigit === sample.label).length;
  console.log(
    `linear flag disagreement conf>=${confidence}: flagged ${flagged.length}, caught ${caught}/${linearAutoErrors.length}, lost ${lost}, left ${linearAutoErrors.length - caught}`,
  );
}
for (const confidence of [0.5, 0.6, 0.7, 0.8]) {
  const switched = linearAuto.map(({ sample, prediction }) => {
    if (prediction.digit === sample.cnnDigit || prediction.confidence < confidence) {
      return { sample, digit: sample.cnnDigit };
    }
    return { sample, digit: prediction.digit };
  });
  const wrong = switched.filter(({ sample, digit }) => digit !== sample.label).length;
  const correct = switched.filter(({ sample, digit }) => digit === sample.label).length;
  console.log(
    `linear switch conf>=${confidence}: auto-correct ${correct}/${switched.length}, auto-wrong ${wrong}`,
  );
}

const hogMap = featureSets.find((feature) => feature.name === 'hog7')!.map;
const quantizedHogMap = new Map<Sample, Float32Array>();
for (const sample of digitSamples) {
  const source = hogMap.get(sample)!;
  const quantized = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) quantized[i] = Math.round(source[i] * 255);
  quantizedHogMap.set(sample, quantized);
}
const allSheetIds = [...testSheetIds, 'reference-2'];
for (const threshold of [0.5, 0.6, 0.7, 0.8]) {
  for (const useHoles of [false, true]) {
    for (const group of [
      { name: 'set3', sheets: testSheetIds },
      { name: 'ref2', sheets: ['reference-2'] },
    ]) {
    let accepted = 0;
    let acceptedWrong = 0;
    let flagged = 0;
    let flaggedWrong = 0;
    let caught = 0;
    let lost = 0;
    const remaining: string[] = [];
    for (const sheet of group.sheets) {
      const train = digitSamples.filter((sample) => sample.sheet !== sheet);
      const test = digitSamples.filter((sample) => sample.sheet === sheet);
      for (const sample of test) {
        const list = neighbors(quantizedHogMap.get(sample)!, train, 7, quantizedHogMap);
        const prediction = fromNeighbors(list, 3)!;
        const cnnWrong = sample.cnnDigit !== sample.label;
        let isFlagged = sample.cnnState !== 'answered';
        if (!isFlagged) {
          const disagreement =
            prediction.digit !== sample.cnnDigit && prediction.confidence >= threshold;
          const hole7 = useHoles && sample.cnnDigit === 7 && sample.holes >= 1;
          if (disagreement || hole7) isFlagged = true;
        }
        if (isFlagged) {
          flagged++;
          if (cnnWrong) {
            flaggedWrong++;
            if (sample.cnnState === 'answered') caught++;
          } else if (sample.cnnState === 'answered') {
            lost++;
          }
        } else {
          accepted++;
          if (cnnWrong) {
            acceptedWrong++;
            remaining.push(
              `${sheet} ${sample.set}${sample.row} ${sample.label}->${sample.cnnDigit} (ref ${prediction.digit}@${prediction.confidence.toFixed(2)})`,
            );
          }
        }
      }
    }
    console.log(
      `combined ${group.name} threshold=${threshold} holes=${useHoles}: accepted ${accepted}, auto-wrong ${acceptedWrong}, flagged ${flagged} (wrong ${flaggedWrong}), caught ${caught}, lost ${lost}`,
    );
    console.log(`  remaining: ${remaining.join(', ')}`);
    }
  }
}
