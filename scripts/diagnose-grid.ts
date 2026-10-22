import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import { detectGrid } from '../src/lib/vision/grid';
import { TABLE_HEIGHT, TABLE_WIDTH } from '../src/lib/config';

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
function savePng(file: string, image: ImageData): void {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}
function toGray(image: ImageData): Float32Array {
  const gray = new Float32Array(image.width * image.height);
  const { data, width, height } = image;
  for (let i = 0; i < width * height; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return gray;
}
function otsu(gray: Float32Array): number {
  const hist = new Array<number>(256).fill(0);
  let total = 0;
  for (let i = 0; i < gray.length; i++) {
    const value = Math.max(0, Math.min(255, Math.round(gray[i])));
    hist[value]++;
    total++;
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = i; }
  }
  return threshold;
}
function smooth(values: Float64Array): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const a = values[Math.max(0, i - 1)];
    const b = values[i];
    const c = values[Math.min(values.length - 1, i + 1)];
    out[i] = (a + b * 2 + c) / 4;
  }
  return out;
}
function rowProfile(gray: Float32Array, w: number, h: number, threshold: number): Float64Array {
  const profile = new Float64Array(h);
  const x0 = Math.round(w * 0.04);
  const x1 = Math.round(w * 0.96);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const base = y * w;
    for (let x = x0; x < x1; x++) if (gray[base + x] < threshold) count++;
    profile[y] = count;
  }
  return smooth(profile);
}

const file = process.argv[2];
if (!file) throw new Error('usage: diagnose-grid.ts <image>');
const source = readImage(file);
const small = resize(source, 1200);
const quad = detectTableQuad(grayscale(small), small.width, small.height);
if (!quad) throw new Error('no quad');
const quadFull = quad.map((p) => ({
  x: p.x * (source.width / small.width),
  y: p.y * (source.height / small.height),
}));
const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
const stem = path.basename(file, '.png');
savePng(path.join('samples/validation/reference-set-3/warped', `${stem}.png`), warped);

const gray = toGray(warped);
const threshold = Math.max(45, otsu(gray));
const profile = rowProfile(gray, warped.width, warped.height, threshold);
const peaks: { y: number; v: number }[] = [];
for (let y = 1; y < profile.length - 1; y++) {
  if (profile[y] >= profile[y - 1] && profile[y] > profile[y + 1]) peaks.push({ y, v: profile[y] });
}
peaks.sort((a, b) => b.v - a.v);
function fitRowLattice(profile: Float64Array): { scale: number; offset: number; score: number; lines: number[] } {
  const expected = [101, 196, 296, 393, 489, 593, 698, 800, 899, 1007, 1107, 1215, 1318];
  let best = { scale: 1, offset: 0, score: -Infinity, lines: [] as number[] };
  for (let scale = 0.94; scale <= 1.121; scale += 0.002) {
    for (let offset = -40; offset <= 50; offset += 1) {
      let score = 0;
      const lines: number[] = [];
      for (const base of expected) {
        const pos = Math.round(base * scale + offset);
        if (pos < 1 || pos >= profile.length - 1) { score = -Infinity; break; }
        let peak = 0;
        for (let d = -14; d <= 14; d++) peak = Math.max(peak, profile[pos + d] ?? 0);
        score += peak;
        lines.push(pos);
      }
      if (score > best.score) best = { scale, offset, score, lines };
    }
  }
  return best;
}
const fit = fitRowLattice(profile);
console.log('fit', fit.scale.toFixed(3), fit.offset, fit.score.toFixed(0), fit.lines.join(','));
const snapped = fit.lines.map((pos) => {
  let bestPos = pos;
  let bestDistance = Infinity;
  let bestValue = -Infinity;
  for (let d = -22; d <= 22; d++) {
    const p = pos + d;
    if (p < 1 || p >= profile.length - 1) continue;
    if (profile[p] < profile[p - 1] || profile[p] <= profile[p + 1]) continue;
    if (profile[p] < warped.width * 0.15) continue;
    const distance = Math.abs(d);
    if (distance < bestDistance || (distance === bestDistance && profile[p] > bestValue)) {
      bestDistance = distance;
      bestValue = profile[p];
      bestPos = p;
    }
  }
  return bestPos;
});
console.log('snap', snapped.join(','));
console.log('spac', snapped.slice(1).map((v, i) => v - snapped[i]).join(','));
const geometry = detectGrid(warped);
console.log('file', stem);
console.log('quad', JSON.stringify(quadFull));
console.log('threshold', threshold);
console.log('top peaks', peaks.slice(0, 30).map((p) => `${p.y}:${p.v.toFixed(0)}`).join(' '));
console.log('rowLines', geometry.rowLines.join(','));
console.log('row spacing', geometry.rowLines.slice(1).map((v, i) => v - geometry.rowLines[i]).join(','));
console.log('row fallback', geometry.usedFallback);
console.log('columns', geometry.studentColumns.map((c) => `${c.left}-${c.right}`).join(','));
const colProfile = new Float64Array(warped.width);
const cy0 = geometry.rowLines[0] + 4;
const cy1 = geometry.rowLines[geometry.rowLines.length - 1] - 4;
for (let y = cy0; y < cy1; y++) {
  const base = y * warped.width;
  for (let x = 1; x < warped.width - 1; x++) {
    if (gray[base + x - 1] < threshold || gray[base + x] < threshold || gray[base + x + 1] < threshold) {
      colProfile[x]++;
    }
  }
}
const colPeaks: { x: number; v: number }[] = [];
for (let x = 1; x < colProfile.length - 1; x++) {
  if (colProfile[x] >= colProfile[x - 1] && colProfile[x] > colProfile[x + 1]) colPeaks.push({ x, v: colProfile[x] });
}
colPeaks.sort((a, b) => b.v - a.v);
console.log('col peaks', colPeaks.slice(0, 30).map((p) => `${p.x}:${p.v.toFixed(0)}`).join(' '));
