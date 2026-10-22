import fs from 'node:fs';
import { PNG } from 'pngjs';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { TABLE_HEIGHT, TABLE_WIDTH } from '../src/lib/config';
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

const file = process.argv[2];
const set = process.argv[3] as SetId;
const row = Number(process.argv[4]);
const source = readImage(file);
const small = resize(source, 1200);
const quad = detectTableQuad(grayscale(small), small.width, small.height);
if (!quad) throw new Error('no quad');
const warped = warpPerspective(
  source,
  quad.map((p) => ({ x: p.x * (source.width / small.width), y: p.y * (source.height / small.height) })),
  TABLE_WIDTH,
  TABLE_HEIGHT,
);
const geometry = detectGrid(warped);
const cells = cropCells(warped, geometry);
const cell = cells[set][row - 1];
const extraction = extractCell(cell);
console.log('cell', cell.width, cell.height, 'threshold', extraction.threshold, 'bg', extraction.meanBackground);
console.log('components:');
for (const c of extraction.components) {
  console.log(
    `  area=${c.area} bbox=${c.minX},${c.minY}-${c.maxX},${c.maxY} w=${c.maxX - c.minX + 1} h=${c.maxY - c.minY + 1}`,
  );
}
console.log('groups:');
for (const g of extraction.groups.slice(0, 8)) {
  console.log(
    `  area=${g.area} bbox=${g.minX},${g.minY}-${g.maxX},${g.maxY} w=${g.maxX - g.minX + 1} h=${g.maxY - g.minY + 1}`,
  );
}
console.log('best', extraction.best);
if (extraction.best) {
  const norm = normalizeCell(extraction, extraction.best);
  const png = new PNG({ width: 28, height: 28 });
  for (let i = 0; i < 784; i++) {
    const v = Math.round(255 * (1 - Math.min(1, Math.max(0, norm[i]))));
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  fs.mkdirSync('samples/validation/norm-debug', { recursive: true });
  fs.writeFileSync(`samples/validation/norm-debug/${set}-${row}.png`, PNG.sync.write(png));
}
