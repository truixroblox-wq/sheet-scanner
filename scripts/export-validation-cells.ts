import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { recognizeCell, type RecognitionSettings } from '../src/lib/ocr/recognize';
import { getReferenceCorpus } from '../src/lib/ocr/reference';
import { DEFAULT_KEY, DEFAULT_SETTINGS, TABLE_HEIGHT, TABLE_WIDTH } from '../src/lib/config';
import { scoreScan } from '../src/lib/scoring';
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

function fill(canvas: Canvas, x: number, y: number, value: number, alpha = 255): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  canvas.data[i] = value;
  canvas.data[i + 1] = value;
  canvas.data[i + 2] = value;
  canvas.data[i + 3] = alpha;
}

function drawRect(
  target: Canvas,
  x: number,
  y: number,
  width: number,
  height: number,
  value: number,
): void {
  for (let yy = y; yy < y + height; yy++) {
    for (let xx = x; xx < x + width; xx++) fill(target, xx, yy, value);
  }
}

function stamp(target: Canvas, source: ImageData, x: number, y: number, scale: number): void {
  for (let sy = 0; sy < source.height; sy++) {
    for (let sx = 0; sx < source.width; sx++) {
      const si = (sy * source.width + sx) * 4;
      const value = Math.round(
        0.299 * source.data[si] + 0.587 * source.data[si + 1] + 0.114 * source.data[si + 2],
      );
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          fill(target, x + sx * scale + dx, y + sy * scale + dy, value);
        }
      }
    }
  }
}

// 5x7 digits and set labels, enough for a self-describing contact sheet.
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};

function drawText(target: Canvas, text: string, x: number, y: number, scale = 2): void {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char];
    if (glyph) {
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy][gx] !== '1') continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              fill(target, cursor + gx * scale + sx, y + gy * scale + sy, 20);
            }
          }
        }
      }
      cursor += 6 * scale;
    } else {
      cursor += 3 * scale;
    }
  }
}

function savePng(file: string, image: Canvas): void {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

function contactSheet(cells: ImageData[], set: SetId, file: string): void {
  const scale = 3;
  const cellW = Math.max(...cells.map((cell) => cell.width)) * scale;
  const cellH = Math.max(...cells.map((cell) => cell.height)) * scale;
  const gap = 10;
  const marginLeft = 70;
  const marginTop = 36;
  const columns = 4;
  const rows = 3;
  const sheet = canvas(
    marginLeft + columns * cellW + (columns - 1) * gap + gap,
    marginTop + rows * cellH + (rows - 1) * gap + gap,
  );

  for (let row = 0; row < rows; row++) {
    drawText(sheet, String(row * columns + 1), 22, marginTop + row * (cellH + gap) + 8, 2);
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      const x = marginLeft + column * (cellW + gap);
      const y = marginTop + row * (cellH + gap);
      drawRect(sheet, x - 2, y - 2, cellW + 4, cellH + 4, 40);
      stamp(sheet, cells[index], x, y, scale);
    }
  }
  drawText(sheet, `Set ${set}`, marginLeft, 8, 3);
  savePng(file, sheet);
}

const file = process.argv[2] ?? 'samples/reference-2.png';
const outputDir = process.argv[3] ?? 'samples/validation';
const settings: RecognitionSettings = {
  confidenceThreshold: DEFAULT_SETTINGS.confidenceThreshold,
  marginThreshold: DEFAULT_SETTINGS.marginThreshold,
};

const source = readImage(file);
const small = resize(source, 1200);
const quad = detectTableQuad(grayscale(small), small.width, small.height);
if (!quad) throw new Error(`Could not detect the table in ${file}`);
const quadFull = quad.map((point) => ({
  x: point.x * (source.width / small.width),
  y: point.y * (source.height / small.height),
}));
const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
const geometry = detectGrid(warped);
const cells = cropCells(warped, geometry);

const referenceCorpus = getReferenceCorpus();
const results = {} as Record<SetId, ReturnType<typeof recognizeCell>[]>;
const payload = {
  source: file,
  generatedAt: new Date().toISOString(),
  referenceCells: referenceCorpus?.features.length ?? 0,
  sets: {} as Record<string, unknown>,
};

for (const set of SET_IDS) {
  results[set] = cells[set].map((cell, index) =>
    recognizeCell(cell, settings, index + 1, { referenceCorpus }),
  );
  contactSheet(cells[set], set, path.join(outputDir, `${path.basename(file, '.png')}-${set}.png`));
  payload.sets[set] = results[set].map((cell, index) => ({
    row: index + 1,
    key: DEFAULT_KEY[set][index],
    digit: cell.digit,
    confidence: Number(cell.confidence.toFixed(4)),
    margin: Number(cell.margin.toFixed(4)),
    state: cell.state,
    area: cell.area,
  }));
}
const scored = scoreScan(results, DEFAULT_KEY, 'wrong');
const summary = {
  ...payload,
  score: {
    A: scored.sets.A.score,
    B: scored.sets.B.score,
    C: scored.sets.C.score,
    D: scored.sets.D.score,
    E: scored.sets.E.score,
    total: scored.total,
  },
};
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, `${path.basename(file, '.png')}-predictions.json`),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(`Wrote contact sheets and predictions to ${outputDir}`);
console.log(`Warp quadrilateral: ${JSON.stringify(quadFull)}`);
console.log(`Score: ${JSON.stringify(summary.score)}`);
