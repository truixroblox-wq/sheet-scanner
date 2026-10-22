import { TABLE_HEIGHT, TABLE_WIDTH } from '../config';

/**
 * Dependency-free table detection and perspective rectification.
 *
 * OpenCV.js is ~11 MB and blocks the browser main thread while compiling, so
 * the scanner uses a small pure-JS pipeline instead: local-background
 * thresholding, connected components, extreme-corner extraction, and a
 * homography with bilinear sampling. It is fast enough to run on every frame
 * and keeps the app fully local and dependency-light.
 */

export interface Point {
  x: number;
  y: number;
}

export interface WarpQuality {
  meanLuminance: number;
  blurScore: number;
  warnings: string[];
  usedFallback: boolean;
}

export interface RectifiedSheet {
  canvas: HTMLCanvasElement;
  quality: WarpQuality;
}

function boxBlur(gray: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += gray[row + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / n;
      sum += gray[row + Math.min(w - 1, x + radius + 1)] - gray[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum +=
        tmp[Math.min(h - 1, y + radius + 1) * w + x] -
        tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}

export function grayscale(image: ImageData): Float32Array {
  const { data, width, height } = image;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return gray;
}

function shoelace(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function isConvex(points: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const current = Math.sign(cross);
    if (current !== 0) {
      if (sign === 0) sign = current;
      else if (sign !== current) return false;
    }
  }
  return true;
}

export function buildTableMask(
  gray: Float32Array,
  w: number,
  h: number,
): { mask: Uint8Array; darkCount: number } {
  const pixels = w * h;
  const radius = Math.max(10, Math.round(Math.min(w, h) * 0.02));
  const background = boxBlur(gray, w, h, radius);
  const dark = new Uint8Array(pixels);
  let darkCount = 0;
  for (let i = 0; i < pixels; i++) {
    if (background[i] - gray[i] > 18 && gray[i] < 225) {
      dark[i] = 1;
      darkCount++;
    }
  }

  // Bridge small gaps in the printed grid before grouping.
  const joined = new Uint8Array(pixels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!dark[i]) continue;
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(h - 1, y + 1);
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) joined[row + xx] = 1;
      }
    }
  }
  return { mask: joined, darkCount };
}

export interface TableComponentInfo {
  id: number;
  count: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface TableDebugInfo {
  components: TableComponentInfo[];
  selected: number[];
  seedId: number;
}

/**
 * Find the four corners of the answer table from a grayscale image.
 * Returns points in TL, TR, BR, BL order, or null when no trustworthy table is
 * found.
 */
export function detectTableQuad(
  gray: Float32Array,
  w: number,
  h: number,
  debug?: (info: TableDebugInfo) => void,
): Point[] | null {
  const pixels = w * h;
  const { mask: joined, darkCount } = buildTableMask(gray, w, h);
  if (darkCount < pixels * 0.005) return null;

  const labels = new Int32Array(pixels).fill(-1);
  const stack = new Int32Array(pixels);
  const components: {
    id: number;
    count: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }[] = [];

  for (let start = 0; start < pixels; start++) {
    if (!joined[start] || labels[start] !== -1) continue;
    const id = components.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let count = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (sp > 0) {
      const index = stack[--sp];
      const x = index % w;
      const y = (index / w) | 0;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (joined[ni] && labels[ni] === -1) {
            labels[ni] = id;
            stack[sp++] = ni;
          }
        }
      }
    }
    components.push({ id, count, minX, maxX, minY, maxY });
  }

  let best: (typeof components)[number] | null = null;
  let bestScore = 0;
  for (const component of components) {
    const bw = component.maxX - component.minX + 1;
    const bh = component.maxY - component.minY + 1;
    const bboxArea = bw * bh;
    if (bw < w * 0.32 || bh < h * 0.32) continue;
    if (bboxArea < pixels * 0.16) continue;
    if (component.count < pixels * 0.004) continue;
    // A table grid is sparse inside its bounding box; a solid dark object is not.
    if (component.count / bboxArea > 0.62) continue;
    // Pixel count is a better discriminator than bbox area when a paper margin
    // is visible: the printed grid has far more ink than the page outline.
    const score = component.count;
    if (score > bestScore) {
      bestScore = score;
      best = component;
    }
  }
  if (!best) return null;

  // A fold, shadow, or lighting seam can split the table into several tall
  // components (for example one per block). Merge every tall, table-shaped
  // component that shares the seed's vertical band before taking corners.
  const selected = new Set<number>();
  const seed = best;
  const seedH = seed.maxY - seed.minY + 1;
  const seedY = (seed.minY + seed.maxY) / 2;
  for (const component of components) {
    const bw = component.maxX - component.minX + 1;
    const bh = component.maxY - component.minY + 1;
    const bboxArea = bw * bh;
    if (bw < w * 0.06 || bh < h * 0.2) continue;
    if (component.count < pixels * 0.001) continue;
    if (component.count / bboxArea > 0.62) continue;
    const height = component.maxY - component.minY + 1;
    const overlap = Math.min(component.maxY, seed.maxY) - Math.max(component.minY, seed.minY);
    const center = (component.minY + component.maxY) / 2;
    if (overlap >= Math.min(height, seedH) * 0.45 || Math.abs(center - seedY) < seedH * 0.35) {
      selected.add(component.id);
    }
  }
  if (selected.size === 0) selected.add(seed.id);
  debug?.({ components, selected: [...selected], seedId: seed.id });

  let tl = { x: 0, y: 0 };
  let tr = { x: 0, y: 0 };
  let br = { x: 0, y: 0 };
  let bl = { x: 0, y: 0 };
  let minSum = Number.POSITIVE_INFINITY;
  let maxSum = Number.NEGATIVE_INFINITY;
  let minDiff = Number.POSITIVE_INFINITY;
  let maxDiff = Number.NEGATIVE_INFINITY;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!selected.has(labels[row + x])) continue;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        tl = { x, y };
      }
      if (sum > maxSum) {
        maxSum = sum;
        br = { x, y };
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        tr = { x, y };
      }
      if (diff < minDiff) {
        minDiff = diff;
        bl = { x, y };
      }
    }
  }

  const quad = [tl, tr, br, bl];
  if (new Set(quad.map((p) => `${p.x},${p.y}`)).size !== 4) return null;
  if (!isConvex(quad)) return null;
  const area = shoelace(quad);
  if (area < pixels * 0.12) return null;
  const edges = quad.map((p, i) => {
    const q = quad[(i + 1) % 4];
    return Math.hypot(q.x - p.x, q.y - p.y);
  });
  if (edges.some((edge) => edge < Math.min(w, h) * 0.22)) return null;
  const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const aspect = (widthTop + widthBottom) / Math.max(1, heightLeft + heightRight);
  if (aspect < 0.45 || aspect > 2.3) return null;
  return quad;
}

/** Compute a 3x3 homography mapping src points to dst points. */
export function computeHomography(src: Point[], dst: Point[]): Float64Array | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    if (pivot !== col) {
      const tmp = a[pivot];
      a[pivot] = a[col];
      a[col] = tmp;
    }
    const div = a[col][col];
    for (let j = col; j < 9; j++) a[col][j] /= div;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (factor === 0) continue;
      for (let j = col; j < 9; j++) a[row][j] -= factor * a[col][j];
    }
  }
  const h = new Float64Array(9);
  for (let i = 0; i < 8; i++) h[i] = a[i][8];
  h[8] = 1;
  return h;
}

/** Perspective-warp an ImageData using a source quad and bilinear sampling. */
export function warpPerspective(
  source: ImageData,
  quad: Point[],
  outWidth = TABLE_WIDTH,
  outHeight = TABLE_HEIGHT,
): ImageData {
  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: outWidth - 1, y: 0 },
    { x: outWidth - 1, y: outHeight - 1 },
    { x: 0, y: outHeight - 1 },
  ];
  const h = computeHomography(dst, quad);
  if (!h) throw new Error('Could not compute the table perspective transform.');

  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const sw = source.width;
  const sh = source.height;
  const data = source.data;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;

  for (let y = 0; y < outHeight; y++) {
    const rowBase = y * outWidth * 4;
    for (let x = 0; x < outWidth; x++) {
      const den = h6 * x + h7 * y + 1;
      const sx = (h0 * x + h1 * y + h2) / den;
      const sy = (h3 * x + h4 * y + h5) / den;
      const di = rowBase + x * 4;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        out[di] = 245;
        out[di + 1] = 245;
        out[di + 2] = 245;
        out[di + 3] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
        const bottom = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
        out[di + c] = top * (1 - fy) + bottom * fy;
      }
      out[di + 3] = 255;
    }
  }
  return new ImageData(out, outWidth, outHeight);
}

function measureQuality(image: ImageData): { meanLuminance: number; blurScore: number } {
  const { width, height, data } = image;
  const gray = new Float32Array(width * height);
  let sum = 0;
  for (let i = 0; i < width * height; i++) {
    const value = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    gray[i] = value;
    sum += value;
  }
  const meanLuminance = sum / (width * height);

  // Laplacian variance on a bounded subset for a stable, cheap blur estimate.
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
  const variance = count ? lapSqSum / count - mean * mean : 0;
  return { meanLuminance, blurScore: variance };
}

function canvasFromImageData(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a drawing surface.');
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Find the table and perspective-correct it to the canonical 1500x1463 size.
 * Falls back to a full-frame resize when detection is not confident.
 */
function resizeToTable(source: HTMLCanvasElement): ImageData {
  const full = document.createElement('canvas');
  full.width = TABLE_WIDTH;
  full.height = TABLE_HEIGHT;
  const ctx = full.getContext('2d');
  if (!ctx) throw new Error('Could not create a drawing surface.');
  ctx.drawImage(source, 0, 0, TABLE_WIDTH, TABLE_HEIGHT);
  return ctx.getImageData(0, 0, TABLE_WIDTH, TABLE_HEIGHT);
}

export async function rectifySheet(source: HTMLCanvasElement): Promise<RectifiedSheet> {
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const sw = Math.max(1, Math.round(source.width * scale));
  const sh = Math.max(1, Math.round(source.height * scale));

  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const smallCtx = small.getContext('2d', { willReadFrequently: true });
  if (!smallCtx) throw new Error('Could not read the input image.');
  smallCtx.drawImage(source, 0, 0, sw, sh);
  const smallImage = smallCtx.getImageData(0, 0, sw, sh);

  const quadSmall = detectTableQuad(grayscale(smallImage), sw, sh);
  const usedFallback = !quadSmall;

  // Warp from the sharpest source we can afford, not from the detection copy.
  // Sampling a downscaled image would blur the handwriting and cost accuracy.
  const warpCap = 3000;
  const warpScale = Math.min(1, warpCap / Math.max(source.width, source.height));
  let warpImage: ImageData;
  if (warpScale < 1) {
    const warpCanvas = document.createElement('canvas');
    warpCanvas.width = Math.max(1, Math.round(source.width * warpScale));
    warpCanvas.height = Math.max(1, Math.round(source.height * warpScale));
    const ctx = warpCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not read the input image.');
    ctx.drawImage(source, 0, 0, warpCanvas.width, warpCanvas.height);
    warpImage = ctx.getImageData(0, 0, warpCanvas.width, warpCanvas.height);
  } else {
    const ctx = source.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not read the input image.');
    warpImage = ctx.getImageData(0, 0, source.width, source.height);
  }

  let rectified: ImageData;
  if (quadSmall) {
    const xScale = (source.width / sw) * warpScale;
    const yScale = (source.height / sh) * warpScale;
    const quad = quadSmall.map((point) => ({ x: point.x * xScale, y: point.y * yScale }));
    try {
      rectified = warpPerspective(warpImage, quad, TABLE_WIDTH, TABLE_HEIGHT);
    } catch {
      rectified = resizeToTable(source);
    }
  } else {
    rectified = resizeToTable(source);
  }

  const { meanLuminance, blurScore } = measureQuality(rectified);
  const warnings: string[] = [];
  if (usedFallback) {
    warnings.push('Table border not detected; using the full frame. Keep all four edges visible.');
  }
  if (meanLuminance < 70) warnings.push('Image is dark. Add more light or avoid shadows.');
  if (meanLuminance > 235) warnings.push('Image looks overexposed. Reduce glare.');
  if (blurScore < 55) warnings.push('Image may be blurry. Hold still and tap to focus.');

  return {
    canvas: canvasFromImageData(rectified),
    quality: { meanLuminance, blurScore, warnings, usedFallback },
  };
}
