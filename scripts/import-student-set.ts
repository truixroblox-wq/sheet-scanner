/**
 * Import the supplied student answer-sheet photos into an anonymous, repeatable
 * local dataset.
 *
 * The originals are copied byte-for-byte so the source is preserved. The
 * recognition dataset never stores names: every sheet gets an opaque ID and all
 * derived/report data is keyed by that ID. A table-only copy is written for
 * visual review so the header area (which may contain a name) is not used by
 * the review tooling.
 *
 * Usage:
 *   npx tsx scripts/import-student-set.ts [sourceDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { extractCell, normalizeCell } from '../src/lib/ocr/preprocess';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { hogFeatures } from '../src/lib/ocr/features';
import { getReferenceCorpus } from '../src/lib/ocr/reference';
import { DEFAULT_SETTINGS, TABLE_HEIGHT, TABLE_WIDTH } from '../src/lib/config';
import { SET_IDS, type CellResult, type SetId } from '../src/types';

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

const SOURCE = path.resolve(process.argv[2] ?? 'D:/PMA REVIEWER/REBUILDING/Reference');
const OUT = path.resolve('samples/student-set-1');
const ORIGINALS = path.join(OUT, 'originals');
const TABLES = path.join(OUT, 'review-tables');
const CONTACTS = path.join(OUT, 'review-contacts');

interface SheetMeta {
  id: string;
  sourceFile: string;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  meanLuminance: number;
  blurScore: number;
  tableDetected: boolean;
  gridFallback: boolean;
  inkRatio: number | null;
  answered: number;
  blanks: number;
  obstructed: number;
  redRatio: number;
  usable: boolean;
  notes: string[];
}

interface SheetCells {
  set: SetId;
  row: number;
  digit: number | null;
  confidence: number;
  margin: number;
  state: CellResult['state'];
  area: number;
  inkRatio: number;
  redRatio: number;
  vector: Uint8Array | null;
}

function decode(file: string): ImageData {
  const decoded = jpeg.decode(fs.readFileSync(file), {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxMemoryUsageInMB: 512,
  });
  return {
    data: new Uint8ClampedArray(decoded.data),
    width: decoded.width,
    height: decoded.height,
  } as ImageData;
}

/** Bilinear resize, matching the browser's default smoothing more closely than nearest-neighbour. */
function resize(image: ImageData, maxSide: number): ImageData {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  if (width === image.width && height === image.height) return image;
  const data = new Uint8ClampedArray(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      const di = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = image.data[(y0 * image.width + x0) * 4 + c] * (1 - fx) +
          image.data[(y0 * image.width + x1) * 4 + c] * fx;
        const bottom = image.data[(y1 * image.width + x0) * 4 + c] * (1 - fx) +
          image.data[(y1 * image.width + x1) * 4 + c] * fx;
        data[di + c] = top * (1 - fy) + bottom * fy;
      }
      data[di + 3] = 255;
    }
  }
  return { data, width, height } as ImageData;
}

function measureQuality(image: ImageData): { meanLuminance: number; blurScore: number } {
  const { width, height, data } = image;
  const gray = new Uint8ClampedArray(width * height);
  let sum = 0;
  for (let i = 0; i < width * height; i++) {
    const value = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    gray[i] = value;
    sum += value;
  }
  const meanLuminance = sum / (width * height);
  const step = Math.max(1, Math.floor(Math.min(width, height) / 500));
  let lapSum = 0;
  let lapSqSum = 0;
  let count = 0;
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const i = y * width + x;
      const lap =
        4 * gray[i] - gray[i - step] - gray[i + step] - gray[i - width * step] - gray[i + width * step];
      lapSum += lap;
      lapSqSum += lap * lap;
      count++;
    }
  }
  const mean = count ? lapSum / count : 0;
  return { meanLuminance, blurScore: count ? lapSqSum / count - mean * mean : 0 };
}

function writePng(file: string, image: ImageData): void {
  const png = new PNG({ width: image.width, height: image.height });
  for (let i = 0; i < image.width * image.height; i++) {
    png.data[i * 4] = image.data[i * 4];
    png.data[i * 4 + 1] = image.data[i * 4 + 1];
    png.data[i * 4 + 2] = image.data[i * 4 + 2];
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 2 }));
}

function writeJpeg(file: string, image: ImageData, quality = 92): void {
  const encoded = jpeg.encode(
    { data: Buffer.from(image.data), width: image.width, height: image.height },
    quality,
  );
  fs.writeFileSync(file, encoded.data);
}

/** 64-bit difference hash on the rectified table, used for duplicate detection. */
function tableDHash(image: ImageData): string {
  const small = resize(image, 72);
  const w = 9;
  const h = 8;
  const values = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(small.width - 1, Math.floor(((x + 0.5) / w) * small.width));
      const sy = Math.min(small.height - 1, Math.floor(((y + 0.5) / h) * small.height));
      const i = (sy * small.width + sx) * 4;
      values[y * w + x] = 0.299 * small.data[i] + 0.587 * small.data[i + 1] + 0.114 * small.data[i + 2];
    }
  }
  let bits = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) bits += values[y * w + x] > values[y * w + x + 1] ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function hamming(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

function makeContact(sheetId: string, cells: Record<SetId, ImageData[]>, sheetCells: SheetCells[]): void {
  const cellW = 150;
  const cellH = 96;
  const labelH = 30;
  const headerH = 34;
  const width = cellW * 12;
  const height = headerH + (cellH + labelH) * 5;
  const canvas = new Uint8ClampedArray(width * height * 4).fill(255);
  const predicted = new Map<string, SheetCells>();
  for (const cell of sheetCells) predicted.set(`${cell.set}-${cell.row}`, cell);

  const drawText = (_text: string, _x: number, _y: number) => {
    // Simple 5x7 bitmap font; enough to label the review sheet without a canvas dependency.
    const font: Record<string, string[]> = {
      '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
      '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
      '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
      '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
      '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
      '.': ['000', '000', '000', '000', '010'], '-': ['000', '000', '111', '000', '000'],
      '/': ['001', '001', '010', '100', '100'], ':': ['000', '010', '000', '010', '000'],
      '?': ['111', '001', '011', '000', '010'], ' ': ['000', '000', '000', '000', '000'],
      'A': ['010', '101', '111', '101', '101'], 'B': ['110', '101', '110', '101', '110'],
      'C': ['011', '100', '100', '100', '011'], 'D': ['110', '101', '101', '101', '110'],
      'E': ['111', '100', '110', '100', '111'], 'S': ['011', '100', '010', '001', '110'],
      'T': ['111', '010', '010', '010', '010'], 'U': ['101', '101', '101', '101', '111'],
      'V': ['101', '101', '101', '101', '010'], 'W': ['101', '101', '111', '111', '101'],
      'X': ['101', '101', '010', '101', '101'], 'Y': ['101', '101', '010', '010', '010'],
      'Z': ['111', '001', '010', '100', '111'], '_': ['000', '000', '000', '000', '111'],
    };
    const scale = 3;
    let cursor = _x;
    for (const char of _text.toUpperCase()) {
      const glyph = font[char] ?? font['?'];
      for (let gy = 0; gy < glyph.length; gy++) {
        for (let gx = 0; gx < glyph[gy].length; gx++) {
          if (glyph[gy][gx] !== '1') continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = cursor + gx * scale + dx;
              const py = _y + gy * scale + dy;
              if (px < 0 || px >= width || py < 0 || py >= height) continue;
              const i = (py * width + px) * 4;
              canvas[i] = 20; canvas[i + 1] = 20; canvas[i + 2] = 20; canvas[i + 3] = 255;
            }
          }
        }
      }
      cursor += 4 * scale;
    }
  };

  drawText(`SHEET ${sheetId}  REVIEW CROPS  PREDICTION UNDER EACH CELL`, 6, 8);
  for (let s = 0; s < SET_IDS.length; s++) {
    const set = SET_IDS[s];
    for (let r = 0; r < 12; r++) {
      const source = cells[set][r];
      const x0 = r * cellW;
      const y0 = headerH + s * (cellH + labelH);
      const scale = Math.min((cellW - 8) / source.width, (cellH - 8) / source.height);
      const dw = Math.max(1, Math.round(source.width * scale));
      const dh = Math.max(1, Math.round(source.height * scale));
      const ox = x0 + Math.floor((cellW - dw) / 2);
      const oy = y0 + Math.floor((cellH - dh) / 2);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const sx = Math.min(source.width - 1, Math.floor((x / dw) * source.width));
          const sy = Math.min(source.height - 1, Math.floor((y / dh) * source.height));
          const si = (sy * source.width + sx) * 4;
          const di = ((oy + y) * width + ox + x) * 4;
          canvas[di] = source.data[si];
          canvas[di + 1] = source.data[si + 1];
          canvas[di + 2] = source.data[si + 2];
          canvas[di + 3] = 255;
        }
      }
      const cell = predicted.get(`${set}-${r + 1}`)!;
      const text = cell.digit == null
        ? '?'
        : `${cell.digit}${cell.state === 'answered' ? '' : '?'}`;
      drawText(`${set}${r + 1} ${text}`, x0 + 4, y0 + cellH + 4);
    }
  }
  writePng(path.join(CONTACTS, `${sheetId}.png`), { data: canvas, width, height } as ImageData);
}

function main(): void {
  for (const dir of [OUT, ORIGINALS, TABLES, CONTACTS]) fs.mkdirSync(dir, { recursive: true });
  const files = fs
    .readdirSync(SOURCE)
    .filter((name) => /\.(jpe?g|png)$/i.test(name))
    .sort();
  const manifest: SheetMeta[] = [];
  const predictions: Record<string, { cells: Record<SetId, SheetCells[]>; dHash: string }> = {};
  const vectors: Record<string, Uint8Array[]> = {};
  let index = 0;

  for (const file of files) {
    index++;
    const id = `S${String(index).padStart(3, '0')}`;
    const full = path.join(SOURCE, file);
    const buffer = fs.readFileSync(full);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    fs.writeFileSync(path.join(ORIGINALS, `${id}.jpeg`), buffer);
    const source = decode(full);
    const notes: string[] = [];
    let tableDetected = false;
    let gridFallback = false;
    let rectified: ImageData;
    let quality = { meanLuminance: 0, blurScore: 0 };
    let cells: Record<SetId, ImageData[]> | null = null;
    let sheetCells: SheetCells[] = [];
    let redRatio = 0;
    let inkRatio: number | null = null;

    const detection = resize(source, 1200);
    const quad = detectTableQuad(grayscale(detection), detection.width, detection.height);
    if (!quad) {
      notes.push('table border not detected');
      rectified = resize(source, Math.max(TABLE_WIDTH, TABLE_HEIGHT));
    } else {
      tableDetected = true;
      const quadFull = quad.map((point) => ({
        x: point.x * (source.width / detection.width),
        y: point.y * (source.height / detection.height),
      }));
      rectified = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
    }
    quality = measureQuality(rectified);

    if (tableDetected) {
      const geometry = detectGrid(rectified);
      gridFallback = geometry.usedFallback;
      cells = cropCells(rectified, geometry);
      const corpus = getReferenceCorpus();
      for (const set of SET_IDS) {
        cells[set].forEach((cellImage, i) => {
          const extraction = extractCell(cellImage);
          const result = recognizeCell(
            cellImage,
            { confidenceThreshold: 0, marginThreshold: 0 },
            i + 1,
            { referenceCorpus: corpus },
          );
          redRatio += extraction.redRatio / 60;
          inkRatio = ((inkRatio ?? 0) + extraction.inkRatio / 60);
          sheetCells.push({
            set,
            row: i + 1,
            digit: result.digit,
            confidence: result.confidence,
            margin: result.margin,
            state: result.state,
            area: result.area,
            inkRatio: extraction.inkRatio,
            redRatio: extraction.redRatio,
            vector:
              extraction.best && extraction.best.area >= 18
                ? hogFeatures(normalizeCell(extraction, extraction.best))
                : null,
          });
        });
      }
      if (rectified.width === TABLE_WIDTH && rectified.height === TABLE_HEIGHT) {
        writeJpeg(path.join(TABLES, `${id}.jpg`), rectified);
        makeContact(id, cells, sheetCells);
      }
      vectors[id] = sheetCells.map((cell) => cell.vector).filter((v): v is Uint8Array => !!v);
    }

    const answered = sheetCells.filter((cell) => cell.digit != null && cell.state !== 'obstructed').length;
    const obstructed = sheetCells.filter((cell) => cell.state === 'obstructed').length;
    const blanks = sheetCells.filter((cell) => cell.digit == null && cell.state !== 'obstructed').length;
    if (!tableDetected) notes.push('unusable for scoring');
    if (quality.meanLuminance < 70) notes.push('dark');
    if (quality.meanLuminance > 235) notes.push('overexposed');
    if (quality.blurScore < 55) notes.push('possibly blurry');
    if (redRatio > 0.02) notes.push('substantial red ink');

    manifest.push({
      id,
      sourceFile: file,
      sha256,
      width: source.width,
      height: source.height,
      bytes: buffer.length,
      meanLuminance: Number(quality.meanLuminance.toFixed(1)),
      blurScore: Number(quality.blurScore.toFixed(1)),
      tableDetected,
      gridFallback,
      inkRatio: inkRatio == null ? null : Number(inkRatio.toFixed(4)),
      answered,
      blanks,
      obstructed,
      redRatio: Number(redRatio.toFixed(4)),
      usable: tableDetected && answered >= 20,
      notes,
    });
    predictions[id] = { cells: Object.fromEntries(SET_IDS.map((set) => [set, sheetCells.filter((c) => c.set === set)])), dHash: tableDHash(rectified) };

    // Pairwise fingerprint distance: mean HOG distance over comparable cells.
    const fingerprints: { id: string; distance: number; shared: number }[] = [];
    for (const [otherId, otherVectors] of Object.entries(vectors)) {
      if (otherId === id) continue;
      const count = Math.min(vectors[id].length, otherVectors.length);
      if (count < 20) continue;
      let sum = 0;
      for (let i = 0; i < count; i++) {
        const a = vectors[id][i];
        const b = otherVectors[i];
        let d = 0;
        for (let j = 0; j < a.length; j++) d += Math.abs(a[j] - b[j]);
        sum += d / a.length;
      }
      fingerprints.push({ id: otherId, distance: sum / count, shared: count });
    }
    fingerprints.sort((a, b) => a.distance - b.distance);
    (manifest[manifest.length - 1] as SheetMeta & { nearest?: unknown }).nearest = fingerprints.slice(0, 3);

    console.log(
      `${id} ${file} ${source.width}x${source.height} table=${tableDetected} ` +
        `answered=${answered} blur=${quality.blurScore.toFixed(0)} red=${redRatio.toFixed(3)} ` +
        `nearest=${fingerprints.slice(0, 2).map((f) => `${f.id}:${f.distance.toFixed(1)}`).join(',')}`,
    );
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ source: SOURCE, sheets: manifest }, null, 2));
  fs.writeFileSync(path.join(OUT, 'predictions.json'), JSON.stringify({ sheets: predictions }, null, 2));
  console.log(`Imported ${manifest.length} files into ${OUT}`);
}

main();
