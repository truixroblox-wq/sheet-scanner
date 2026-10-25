/**
 * Measure cell-crop inset and segmentation variants on a small hand-labeled
 * development set. This is a scratch experiment, not the production path.
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { detectGrid } from '../src/lib/vision/grid';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { extractCell } from '../src/lib/ocr/preprocess';
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

function cropAt(
  image: ImageData,
  left: number,
  right: number,
  top: number,
  bottom: number,
  inset: number,
): ImageData {
  const rowHeight = bottom - top;
  const y0 = Math.round(top + rowHeight * inset);
  const y1 = Math.round(bottom - rowHeight * inset);
  const width = right - left;
  const height = Math.max(1, y1 - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const source = ((y0 + y) * image.width + left) * 4;
    data.set(image.data.subarray(source, source + width * 4), y * width * 4);
  }
  return { data, width, height } as ImageData;
}

const insets = [0.12, 0.16, 0.2, 0.24];
for (const inset of insets) {
  let total = 0;
  let correct = 0;
  const errors: string[] = [];
  for (const [id, labels] of Object.entries(LABELS)) {
    const table = readJpeg(path.join(root, 'review-tables', `${id}.jpg`));
    const geometry = detectGrid(table);
    for (let s = 0; s < 5; s++) {
      const set = SET_IDS[s];
      const column = geometry.studentColumns[s];
      for (let r = 0; r < 12; r++) {
        const cell = cropAt(
          table,
          column.left,
          column.right,
          geometry.rowLines[r],
          geometry.rowLines[r + 1],
          inset,
        );
        const result = recognizeCell(cell, { confidenceThreshold: 0, marginThreshold: 0 }, r + 1);
        const label = labels[set][r];
        total++;
        if (result.digit === label) correct++;
        else errors.push(`${id}-${set}${r + 1}:${result.digit}->${label}`);
      }
    }
  }
  console.log(
    `inset=${inset.toFixed(2)} accuracy=${((correct / total) * 100).toFixed(1)}% (${correct}/${total})`,
  );
  console.log(`  ${errors.join(' ')}`);
}

// Inspect the problematic cells at each inset.
for (const [id, set, row] of [
  ['S001', 'A', 6],
  ['S001', 'A', 7],
  ['S003', 'B', 3],
  ['S003', 'B', 4],
] as const) {
  const table = readJpeg(path.join(root, 'review-tables', `${id}.jpg`));
  const geometry = detectGrid(table);
  const s = SET_IDS.indexOf(set);
  const column = geometry.studentColumns[s];
  for (const inset of insets) {
    const cell = cropAt(
      table,
      column.left,
      column.right,
      geometry.rowLines[row - 1],
      geometry.rowLines[row],
      inset,
    );
    const extraction = extractCell(cell);
    const result = recognizeCell(cell, { confidenceThreshold: 0, marginThreshold: 0 }, row);
    console.log(
      `${id}-${set}${row} inset=${inset}: ${cell.width}x${cell.height} best=${
        extraction.best ? `${extraction.best.minX},${extraction.best.minY}-${extraction.best.maxX},${extraction.best.maxY}` : 'none'
      } pred=${result.digit} conf=${result.confidence.toFixed(2)}`,
    );
  }
}
