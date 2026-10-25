/**
 * Compare legacy vs merged stroke grouping on the 3-sheet development sample.
 * Also tests a small left/right border clear that removes neighbour strokes
 * without clipping the vertically centred digit.
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { detectGrid } from '../src/lib/vision/grid';
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
function crop(
  image: ImageData,
  left: number,
  right: number,
  top: number,
  bottom: number,
  inset = 0.12,
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
function clearSides(cell: ImageData, fraction: number): ImageData {
  if (!fraction) return cell;
  const copy = { data: new Uint8ClampedArray(cell.data), width: cell.width, height: cell.height } as ImageData;
  const mx = Math.round(cell.width * fraction);
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < mx; x++) {
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

const sheets = Object.keys(LABELS).map((id) => {
  const table = readJpeg(path.join(root, 'review-tables', `${id}.jpg`));
  return { id, table, labels: LABELS[id], geometry: detectGrid(table) };
});

for (const grouping of ['legacy', 'merged'] as const) {
  for (const side of [0, 0.02, 0.04, 0.06]) {
    let total = 0;
    let correct = 0;
    const errors: string[] = [];
    for (const sheet of sheets) {
      for (let s = 0; s < 5; s++) {
        const set = SET_IDS[s];
        const column = sheet.geometry.studentColumns[s];
        for (let r = 0; r < 12; r++) {
          const raw = crop(
            sheet.table,
            column.left,
            column.right,
            sheet.geometry.rowLines[r],
            sheet.geometry.rowLines[r + 1],
          );
          const cell = clearSides(raw, side);
          const result = recognizeCell(
            cell,
            { confidenceThreshold: 0, marginThreshold: 0 },
            r + 1,
            { segmentation: grouping },
          );
          const label = sheet.labels[set][r];
          total++;
          if (result.digit === label) correct++;
          else errors.push(`${sheet.id}-${set}${r + 1}:${result.digit}->${label}`);
        }
      }
    }
    console.log(
      `${grouping} side=${side.toFixed(2)} acc=${((correct / total) * 100).toFixed(1)}% (${correct}/${total})`,
    );
    console.log(`  ${errors.join(' ')}`);
  }
}
