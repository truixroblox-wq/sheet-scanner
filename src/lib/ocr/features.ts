/**
 * Lightweight, reference-derived features for handwriting verification.
 *
 * These features are intentionally small enough to run in the browser:
 * 8-bit HOG descriptors over the same 28x28 normalised cell the CNN reads.
 * The verified reference sheets are stored as a compact corpus, and a tiny
 * nearest-neighbour vote acts as a second opinion on decisive CNN readings.
 */

const SIZE = 28;
const CELL = 7;
const CELLS = SIZE / CELL;
const BINS = 9;

export const HOG_DIMENSIONS = (CELLS - 1) * (CELLS - 1) * 4 * BINS;

export interface ReferenceCorpus {
  /** Quantised HOG descriptors, one per verified reference cell. */
  features: Uint8Array[];
  /** Ground-truth digit for each descriptor, 1..8. */
  labels: Uint8Array;
}

export interface ReferenceMatch {
  digit: number;
  confidence: number;
  margin: number;
  /** Squared distance to the nearest reference descriptor. */
  distance: number;
  /** Enclosed background regions in the normalised cell. */
  holes: number;
}

/** A conservative disagreement gate for the reference second opinion. */
export const REFERENCE_FLAG_CONFIDENCE = 0.5;

/** Histogram of oriented gradients, quantised to one byte per bin. */
export function hogFeatures(vector: Float32Array): Uint8Array {
  const hist = new Float32Array(CELLS * CELLS * BINS);
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const gx = vector[y * SIZE + x + 1] - vector[y * SIZE + x - 1];
      const gy = vector[(y + 1) * SIZE + x] - vector[(y - 1) * SIZE + x];
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < 1e-4) continue;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      if (angle >= Math.PI) angle -= Math.PI;
      const bin = Math.min(BINS - 1, Math.floor((angle / Math.PI) * BINS));
      const cellX = Math.min(CELLS - 1, Math.floor(x / CELL));
      const cellY = Math.min(CELLS - 1, Math.floor(y / CELL));
      hist[(cellY * CELLS + cellX) * BINS + bin] += magnitude;
    }
  }

  const out = new Uint8Array(HOG_DIMENSIONS);
  let write = 0;
  for (let by = 0; by < CELLS - 1; by++) {
    for (let bx = 0; bx < CELLS - 1; bx++) {
      const block: number[] = [];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const base = ((by + dy) * CELLS + (bx + dx)) * BINS;
          for (let bin = 0; bin < BINS; bin++) block.push(hist[base + bin]);
        }
      }
      let sum = 0;
      for (const value of block) sum += value * value;
      const norm = Math.sqrt(sum) + 1e-6;
      for (const value of block) {
        out[write++] = Math.max(0, Math.min(255, Math.round((value / norm) * 255)));
      }
    }
  }
  return out;
}

/** Count enclosed background regions in a 28x28 normalised ink image. */
export function countHoles(vector: Float32Array, threshold = 0.2): number {
  const ink = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < ink.length; i++) ink[i] = vector[i] > threshold ? 1 : 0;

  const visited = new Uint8Array(SIZE * SIZE);
  let holes = 0;
  const stack: number[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (ink[start] || visited[start]) continue;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    let area = 0;
    let touchesBorder = false;
    while (stack.length) {
      const index = stack.pop()!;
      const x = index % SIZE;
      const y = (index / SIZE) | 0;
      area++;
      if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) touchesBorder = true;
      const neighbours = [index - 1, index + 1, index - SIZE, index + SIZE];
      for (const next of neighbours) {
        if (next < 0 || next >= ink.length) continue;
        const nx = next % SIZE;
        if (Math.abs(nx - x) > 1) continue;
        if (ink[next] || visited[next]) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }
    if (!touchesBorder && area >= 2) holes++;
  }
  return holes;
}

/**
 * Three-neighbour weighted vote over the verified reference cells.
 * The corpus is small (hundreds of descriptors), so a linear scan is simpler
 * and faster than maintaining an index in the browser.
 */
export function matchReference(
  vector: Float32Array,
  corpus: ReferenceCorpus,
  k = 3,
): ReferenceMatch | null {
  if (!corpus.features.length || corpus.labels.length !== corpus.features.length) return null;
  const query = hogFeatures(vector);
  const nearest: Array<{ label: number; distance: number }> = [];

  for (let i = 0; i < corpus.features.length; i++) {
    const feature = corpus.features[i];
    let distance = 0;
    for (let j = 0; j < HOG_DIMENSIONS; j++) {
      const diff = query[j] - feature[j];
      distance += diff * diff;
    }
    if (nearest.length < k || distance < nearest[nearest.length - 1].distance) {
      let index = nearest.length;
      while (index > 0 && nearest[index - 1].distance > distance) index--;
      nearest.splice(index, 0, { label: corpus.labels[i], distance });
      if (nearest.length > k) nearest.pop();
    }
  }
  if (!nearest.length) return null;

  const weights = new Float64Array(9);
  let total = 0;
  for (const neighbour of nearest) {
    const weight = 1 / (neighbour.distance + 1e-3);
    weights[neighbour.label] += weight;
    total += weight;
  }
  let digit = 1;
  let best = 0;
  let second = 0;
  for (let label = 1; label <= 8; label++) {
    if (weights[label] > best) {
      second = best;
      best = weights[label];
      digit = label;
    } else if (weights[label] > second) {
      second = weights[label];
    }
  }

  return {
    digit,
    confidence: best / total,
    margin: (best - second) / total,
    distance: nearest[0].distance,
    holes: countHoles(vector),
  };
}

/**
 * Flag a decisive CNN reading when the verified references disagree, or when a
 * handwritten 7 contains an enclosed region (the common 4-written-like-7 case).
 * We never replace the CNN digit here: unresolved cells stay reviewable.
 */
export function shouldFlagReference(
  digit: number | null,
  match: ReferenceMatch | null,
): boolean {
  if (digit == null || !match) return false;
  if (digit === 7 && match.holes >= 1) return true;
  return match.digit !== digit && match.confidence >= REFERENCE_FLAG_CONFIDENCE;
}
