/**
 * Measure the existing HOG k-NN second opinion and simple hybrid rules on the
 * hand-labeled development cells. The k-NN corpus is the previously verified
 * 719-cell reference set, not these sheets.
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { detectGrid } from '../src/lib/vision/grid';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { matchReference } from '../src/lib/ocr/features';
import { getReferenceCorpus } from '../src/lib/ocr/reference';
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

const LABELS: Record<string, Record<SetId, Array<number | null>>> = {
  S001: {
    A: [4, 5, 1, 2, 6, 3, 6, 2, 1, 3, 5, 5],
    B: [2, 6, 1, 2, 1, 3, 1, 6, 4, 3, 4, 5],
    C: [8, 2, 3, 8, 7, 4, 5, 1, 7, 6, 1, 3],
    D: [3, 4, 3, 7, 8, 6, 5, 4, 1, 2, 5, 8],
    E: [1, 6, 2, 8, 7, 2, 1, 6, 4, 7, 1, 3],
  },
  S002: {
    A: [4, 5, 1, 2, 6, 3, 6, 2, 1, 3, 4, 5],
    B: [2, 6, 1, 2, 1, 3, 5, 6, 4, 3, 4, 5],
    C: [8, 2, 3, 8, 7, 4, 5, 1, 1, 6, 1, 2],
    D: [3, 4, 3, 7, 8, 6, 5, 4, 1, 2, 5, 6],
    E: [7, 6, 8, 2, 1, 5, 1, 6, 3, 2, 4, 1],
  },
  S003: {
    A: [4, 5, 1, 2, 6, 3, 6, 2, 1, 3, 4, 5],
    B: [2, 6, 1, 2, 1, 3, 5, 5, 4, 3, 4, 6],
    C: [8, 2, 3, 8, 7, 4, 5, 7, 1, 8, 3, 4],
    D: [3, 4, 3, 7, 8, 6, 5, 4, 1, 2, 7, 7],
    E: [6, 6, 6, 6, 2, 2, 7, 8, 8, 7, 3, 3],
  },
};

const root = path.resolve('samples/student-set-1');
function readJpeg(file: string): ImageData {
  const decoded = jpeg.decode(fs.readFileSync(file), {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
  });
  return {
    data: new Uint8ClampedArray(decoded.data),
    width: decoded.width,
    height: decoded.height,
  } as ImageData;
}
function crop(image: ImageData, left: number, right: number, top: number, bottom: number): ImageData {
  const rowHeight = bottom - top;
  const y0 = Math.round(top + rowHeight * 0.12);
  const y1 = Math.round(bottom - rowHeight * 0.12);
  const width = right - left;
  const height = Math.max(1, y1 - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const source = ((y0 + y) * image.width + left) * 4;
    data.set(image.data.subarray(source, source + width * 4), y * width * 4);
  }
  return { data, width, height } as ImageData;
}

interface Row {
  id: string;
  set: SetId;
  row: number;
  label: number;
  cnn: number | null;
  knn: number | null;
  knnConfidence: number;
  cnnConfidence: number;
}
const rows: Row[] = [];
const corpus = getReferenceCorpus();
if (!corpus) throw new Error('reference corpus missing');

for (const [id, labels] of Object.entries(LABELS)) {
  const table = readJpeg(path.join(root, 'review-tables', `${id}.jpg`));
  const geometry = detectGrid(table);
  for (let s = 0; s < 5; s++) {
    const set = SET_IDS[s];
    const column = geometry.studentColumns[s];
    for (let r = 0; r < 12; r++) {
      const cell = crop(
        table,
        column.left,
        column.right,
        geometry.rowLines[r],
        geometry.rowLines[r + 1],
      );
      const cnn = recognizeCell(
        cell,
        { confidenceThreshold: 0, marginThreshold: 0 },
        r + 1,
        { segmentation: 'merged' },
      );
      const extraction = extractCell(cell, { grouping: 'merged' });
      const match = extraction.best
        ? matchReference(normalizeCell(extraction, extraction.best), corpus)
        : null;
      const label = labels[set][r];
      if (label == null) continue;
      rows.push({
        id,
        set,
        row: r + 1,
        label,
        cnn: cnn.digit,
        knn: match?.digit ?? null,
        knnConfidence: match?.confidence ?? 0,
        cnnConfidence: cnn.confidence,
      });
    }
  }
}

function accuracy(predict: (row: Row) => number | null): void {
  const correct = rows.filter((row) => predict(row) === row.label).length;
  console.log(`${((correct / rows.length) * 100).toFixed(1)}% (${correct}/${rows.length})`);
}
console.log('CNN'); accuracy((r) => r.cnn);
console.log('kNN'); accuracy((r) => r.knn);
for (const threshold of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  console.log(`kNN replace when conf>=${threshold} & disagree`);
  accuracy((r) => (r.knn !== r.cnn && r.knnConfidence >= threshold ? r.knn : r.cnn));
}
for (const threshold of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  console.log(`kNN replace 7->2 when conf>=${threshold}`);
  accuracy((r) => (r.cnn === 7 && r.knn === 2 && r.knnConfidence >= threshold ? 2 : r.cnn));
}
console.log('disagreements');
for (const row of rows.filter((row) => row.knn !== row.cnn)) {
  console.log(
    `${row.id}-${row.set}${row.row} label=${row.label} cnn=${row.cnn}(${row.cnnConfidence.toFixed(2)}) knn=${row.knn}(${row.knnConfidence.toFixed(2)})`,
  );
}
