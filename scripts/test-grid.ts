import fs from 'node:fs';
import { PNG } from 'pngjs';
import { detectGrid, cropCells } from '../src/lib/vision/grid';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { DEFAULT_KEY } from '../src/lib/config';
import { scoreScan } from '../src/lib/scoring';
import { SET_IDS, type SetId } from '../src/types';

const png = PNG.sync.read(fs.readFileSync(process.argv[2] ?? 'samples/proto-warp.png'));
const data = new Uint8ClampedArray(png.width * png.height * 4);
for (let i = 0; i < png.width * png.height; i++) {
  data[i * 4] = png.data[i * 4];
  data[i * 4 + 1] = png.data[i * 4 + 1];
  data[i * 4 + 2] = png.data[i * 4 + 2];
  data[i * 4 + 3] = 255;
}
const image = { data, width: png.width, height: png.height } as ImageData;
const geometry = detectGrid(image);
console.log('grid', JSON.stringify(geometry));
const cells = cropCells(image, geometry);
const results = {} as Record<SetId, ReturnType<typeof recognizeCell>[]>;
const t0 = performance.now();
for (const set of SET_IDS) {
  results[set] = cells[set].map((cell, index) =>
    recognizeCell(cell, { confidenceThreshold: 0.7, marginThreshold: 0.35 }, index + 1),
  );
}
const scored = scoreScan(results, DEFAULT_KEY, 'wrong');
for (const set of SET_IDS) {
  console.log(
    `Set ${set}: ${scored.sets[set].score}/12`,
    results[set]
      .map((c, i) => `${i + 1}:${c.digit ?? '?'}${c.state === 'answered' ? '' : `(${c.state[0]})`}`)
      .join(' '),
  );
}
console.log(`TOTAL ${scored.total}/${scored.totalPossible} rec ${(performance.now() - t0).toFixed(0)} ms`);
