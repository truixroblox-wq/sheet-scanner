import fs from 'node:fs';
import path from 'node:path';
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

type Canvas = { width: number; height: number; data: Uint8ClampedArray };
function canvas(width: number, height: number, fill = 255): Canvas {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill;
    data[i * 4 + 1] = fill;
    data[i * 4 + 2] = fill;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
function setPixel(target: Canvas, x: number, y: number, value: number): void {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
  const i = (y * target.width + x) * 4;
  target.data[i] = value;
  target.data[i + 1] = value;
  target.data[i + 2] = value;
}
function stamp(target: Canvas, source: ImageData, x: number, y: number, scale: number): void {
  for (let sy = 0; sy < source.height; sy++) {
    for (let sx = 0; sx < source.width; sx++) {
      const si = (sy * source.width + sx) * 4;
      const value = Math.round(
        0.299 * source.data[si] + 0.587 * source.data[si + 1] + 0.114 * source.data[si + 2],
      );
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) setPixel(target, x + sx * scale + dx, y + sy * scale + dy, value);
      }
    }
  }
}
function savePng(file: string, image: Canvas): void {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

const file = process.argv[2] ?? 'samples/reference-2.png';
const set = (process.argv[3] ?? 'C') as SetId;
const rows = (process.argv[4] ?? '1,2,3,4')
  .split(',')
  .map((value) => Number.parseInt(value, 10))
  .filter((value) => value >= 1 && value <= 12);

const source = readImage(file);
const small = resize(source, 1200);
const quad = detectTableQuad(grayscale(small), small.width, small.height);
if (!quad) throw new Error('Table not found');
const quadFull = quad.map((point) => ({
  x: point.x * (source.width / small.width),
  y: point.y * (source.height / small.height),
}));
const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
const geometry = detectGrid(warped);
const cells = cropCells(warped, geometry)[set];

for (const row of rows) {
  const cell = cells[row - 1];
  const extraction = extractCell(cell);
  const norm = extraction.best ? normalizeCell(extraction, extraction.best) : new Float32Array(784);
  const rawScale = 5;
  const normScale = 8;
  const gap = 24;
  const out = canvas(
    cell.width * rawScale + gap + 28 * normScale + gap,
    Math.max(cell.height * rawScale, 28 * normScale) + gap * 2,
    255,
  );
  stamp(out, cell, gap, gap, rawScale);
  for (let y = 0; y < 28; y++) {
    for (let x = 0; x < 28; x++) {
      const value = Math.round(255 - Math.max(0, Math.min(1, norm[y * 28 + x])) * 255);
      for (let dy = 0; dy < normScale; dy++) {
        for (let dx = 0; dx < normScale; dx++) {
          setPixel(
            out,
            gap + cell.width * rawScale + gap + x * normScale + dx,
            gap + y * normScale + dy,
            value,
          );
        }
      }
    }
  }
  savePng(path.join('samples/validation/detail', `${path.basename(file, '.png')}-${set}-${row}.png`), out);
  console.log(
    `${set}${row}: best=${extraction.best ? JSON.stringify(extraction.best) : 'none'} ` +
      `ink=${(extraction.inkRatio * 100).toFixed(1)}% dark=${(extraction.darkRatio * 100).toFixed(1)}%`,
  );
}
