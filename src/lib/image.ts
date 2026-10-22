/** Browser image utilities: file decoding, perceptual hashing, frame stability. */

export async function fileToCanvas(file: File | Blob): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    bitmap = null;
  }
  if (bitmap) {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a drawing surface.');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a drawing surface.');
    ctx.drawImage(image, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load image.'));
    image.src = src;
  });
}

export function videoFrameToCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a drawing surface.');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const HASH_W = 9;
const HASH_H = 8;

/** 64-bit difference hash, returned as 16 hex characters. */
export function dHash(canvas: HTMLCanvasElement): string {
  const small = document.createElement('canvas');
  small.width = HASH_W;
  small.height = HASH_H;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  ctx.drawImage(canvas, 0, 0, HASH_W, HASH_H);
  const data = ctx.getImageData(0, 0, HASH_W, HASH_H).data;
  let bits = '';
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) {
      const i = (y * HASH_W + x) * 4;
      const j = (y * HASH_W + x + 1) * 4;
      const a = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const b = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
      bits += a > b ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** Downscale a video frame and return mean absolute difference and edge energy. */
export function frameSignature(canvas: HTMLCanvasElement): { pixels: Uint8ClampedArray; edge: number } {
  const w = 96;
  const h = 72;
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { pixels: new Uint8ClampedArray(w * h), edge: 0 };
  ctx.drawImage(canvas, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h).data;
  const pixels = new Uint8ClampedArray(w * h);
  let edge = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const gray = 0.299 * image[i] + 0.587 * image[i + 1] + 0.114 * image[i + 2];
      pixels[y * w + x] = gray;
      if (x > 0 && y > 0) {
        const left = pixels[y * w + x - 1];
        const up = pixels[(y - 1) * w + x];
        edge += Math.abs(gray - left) + Math.abs(gray - up);
      }
    }
  }
  return { pixels, edge: edge / (w * h) };
}

export function meanDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / length;
}

/**
 * Serialize a cropped cell for the confirmation UI. The crop stays in memory as
 * a local data URL; it is never uploaded or persisted to storage.
 */
export function imageDataToDataUrl(image: ImageData): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const copy = ctx.createImageData(image.width, image.height);
  copy.data.set(image.data);
  ctx.putImageData(copy, 0, 0);
  return canvas.toDataURL('image/png');
}

export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
