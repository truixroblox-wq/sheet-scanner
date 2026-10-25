/**
 * Compact the import-time prediction record and attach the exact grid geometry
 * used for each review table. The large per-cell HOG vectors are import-time
 * scratch data, not ground truth, and are removed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { detectGrid } from '../src/lib/vision/grid';
import type { SetId } from '../src/types';

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

const ROOT = path.resolve('samples/student-set-1');
const predictions = JSON.parse(fs.readFileSync(path.join(ROOT, 'predictions.json'), 'utf8')) as {
  sheets: Record<
    string,
    {
      dHash: string;
      cells: Record<SetId, Array<Record<string, unknown>>>;
    }
  >;
};

const out: Record<string, unknown> = {};
for (const [id, sheet] of Object.entries(predictions.sheets)) {
  const table = path.join(ROOT, 'review-tables', `${id}.jpg`);
  let geometry: unknown = null;
  if (fs.existsSync(table)) {
    const decoded = jpeg.decode(fs.readFileSync(table), {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: true,
    });
    const image = {
      data: new Uint8ClampedArray(decoded.data),
      width: decoded.width,
      height: decoded.height,
    } as ImageData;
    const grid = detectGrid(image);
    geometry = {
      rowLines: grid.rowLines,
      studentColumns: grid.studentColumns,
      usedFallback: grid.usedFallback,
    };
  }
  const cells: Record<string, unknown[]> = {};
  for (const [set, list] of Object.entries(sheet.cells)) {
    cells[set] = list.map((cell) => {
      const { vector: _vector, ...rest } = cell;
      void _vector;
      return rest;
    });
  }
  out[id] = { dHash: sheet.dHash, geometry, cells };
}
fs.writeFileSync(path.join(ROOT, 'predictions.json'), JSON.stringify({ sheets: out }, null, 2));
console.log(`Compacted ${Object.keys(out).length} sheets`);
