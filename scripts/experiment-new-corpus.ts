/**
 * Scratch experiment: build a small verified HOG corpus from the four
 * development sheets and use it as a nearest-neighbour classifier on the four
 * held-out sheets. Test labels are only used for scoring, never for the corpus.
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { hogFeatures, matchReference, type ReferenceCorpus } from '../src/lib/ocr/features';
import { recognizeCell } from '../src/lib/ocr/recognize';
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

const root = path.resolve('samples/student-set-1');
const labels = JSON.parse(fs.readFileSync(path.join(root, 'labels.json'), 'utf8')) as {
  sheets: Record<string, { labels: Record<SetId, Array<number | null>> }>;
};
const devIds = ['S001', 'S002', 'S003', 'S004'];
const testIds = ['S005', 'S006', 'S007', 'S008'];

function readJpeg(file: string): ImageData {
  const decoded = jpeg.decode(fs.readFileSync(file), {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
  });
  return new NodeImageData(decoded.data as Uint8ClampedArray, decoded.width, decoded.height);
}

interface Item {
  sheet: string;
  set: SetId;
  row: number;
  label: number;
  vector: Float32Array;
  cnn: number | null;
}
function collect(ids: string[]): Item[] {
  const out: Item[] = [];
  for (const id of ids) {
    const table = readJpeg(path.join(root, 'review-tables', `${id}.jpg`));
    const cells = cropCells(table, detectGrid(table));
    for (const set of SET_IDS) {
      for (let index = 0; index < 12; index++) {
        const label = labels.sheets[id].labels[set][index];
        const extraction = extractCell(cells[set][index], { grouping: 'merged' });
        if (label == null || !extraction.best) continue;
        out.push({
          sheet: id,
          set,
          row: index + 1,
          label,
          vector: normalizeCell(extraction, extraction.best),
          cnn: recognizeCell(
            cells[set][index],
            { confidenceThreshold: 0.96, marginThreshold: 0.9 },
            index + 1,
            { segmentation: 'merged' },
          ).digit,
        });
      }
    }
  }
  return out;
}

const dev = collect(devIds);
const test = collect(testIds);
const corpus: ReferenceCorpus = {
  features: dev.map((item) => hogFeatures(item.vector)),
  labels: Uint8Array.from(dev.map((item) => item.label)),
};

console.log(`dev corpus ${dev.length} cells; test ${test.length} cells`);
for (const k of [1, 3, 5, 7, 9]) {
  let correct = 0;
  const errors: string[] = [];
  for (const item of test) {
    const match = matchReference(item.vector, corpus, k);
    if (match?.digit === item.label) correct++;
    else errors.push(`${item.sheet}-${item.set}${item.row}:${match?.digit}->${item.label}`);
  }
  console.log(
    `k=${k}: ${correct}/${test.length} (${((correct / test.length) * 100).toFixed(1)}%) ${errors.slice(0, 8).join(' ')}`,
  );
}

const cnnCorrect = test.filter((item) => item.cnn === item.label).length;
console.log(`CNN baseline: ${cnnCorrect}/${test.length} (${((cnnCorrect / test.length) * 100).toFixed(1)}%)`);
for (const k of [1, 3, 5]) {
  for (const threshold of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    let correct = 0;
    let changed = 0;
    for (const item of test) {
      const match = matchReference(item.vector, corpus, k);
      let digit = item.cnn;
      if (item.cnn === 7 && match && match.confidence >= threshold) {
        digit = match.digit;
        if (digit !== item.cnn) changed++;
      }
      if (digit === item.label) correct++;
    }
    console.log(
      `hybrid k=${k} conf>=${threshold} on CNN 7: ${correct}/${test.length} (${((correct / test.length) * 100).toFixed(1)}%), changed ${changed}`,
    );
  }
}

// Leave-one-development-sheet-out estimate on the same corpus.
for (const heldOut of devIds) {
  const train = dev.filter((item) => item.sheet !== heldOut);
  const fold = dev.filter((item) => item.sheet === heldOut);
  const foldCorpus: ReferenceCorpus = {
    features: train.map((item) => hogFeatures(item.vector)),
    labels: Uint8Array.from(train.map((item) => item.label)),
  };
  let correct = 0;
  for (const item of fold) {
    if (matchReference(item.vector, foldCorpus)?.digit === item.label) correct++;
  }
  console.log(`LODO ${heldOut}: ${correct}/${fold.length} (${((correct / fold.length) * 100).toFixed(1)}%)`);
}
