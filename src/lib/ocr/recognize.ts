import { predictMnist } from './cnn';
import { extractCell, normalizeCell } from './preprocess';
import type { CellResult } from '../../types';

export interface RecognitionSettings {
  confidenceThreshold: number;
  marginThreshold: number;
}

const ROTATION_VARIANTS = [-8, 0, 8];

function rotate(input: Float32Array, degrees: number, size = 28): Float32Array {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const center = size / 2;
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const sx = Math.round(cos * dx + sin * dy + center);
      const sy = Math.round(-sin * dx + cos * dy + center);
      if (sx >= 0 && sx < size && sy >= 0 && sy < size) {
        out[y * size + x] = input[sy * size + sx];
      }
    }
  }
  return out;
}

/**
 * Recognise one student answer cell. Returns a null digit for a genuinely blank
 * cell and an obstructed/uncertain state when the evidence is poor.
 */
export function recognizeCell(
  cell: ImageData,
  settings: RecognitionSettings,
  row: number,
): CellResult {
  const extraction = extractCell(cell);
  const best = extraction.best;
  const tooDark = extraction.meanBackground < 45;
  const tooMuchDark = extraction.darkRatio > 0.25;

  if (!best) {
    const cleanBlank = extraction.inkRatio < 0.025;
    return {
      row,
      digit: null,
      confidence: 0,
      margin: 0,
      area: 0,
      state:
        tooDark || tooMuchDark || extraction.inkRatio > 0.12
          ? 'obstructed'
          : cleanBlank
            ? 'blank'
            : 'uncertain',
    };
  }

  // Very small residue is almost always grid noise, not a digit.
  if (best.area < 18) {
    return {
      row,
      digit: null,
      confidence: 0,
      margin: 0,
      area: best.area,
      state: extraction.inkRatio > 0.12 ? 'obstructed' : 'blank',
    };
  }

  const norm = normalizeCell(extraction, best);
  const probs = new Float32Array(10);
  for (const angle of ROTATION_VARIANTS) {
    const pred = predictMnist(rotate(norm, angle));
    for (let d = 0; d < 10; d++) probs[d] += pred.probabilities[d];
  }
  for (let d = 0; d < 10; d++) probs[d] /= ROTATION_VARIANTS.length;

  // The answer sheet only allows 1..8.
  let sum = 0;
  for (let d = 0; d < 10; d++) {
    if (d < 1 || d > 8) probs[d] = 0;
    sum += probs[d];
  }
  if (sum <= 0) {
    return { row, digit: null, confidence: 0, margin: 0, area: best.area, state: 'obstructed' };
  }
  for (let d = 0; d < 10; d++) probs[d] /= sum;

  let digit = 1;
  let confidence = 0;
  for (let d = 1; d <= 8; d++) {
    if (probs[d] > confidence) {
      confidence = probs[d];
      digit = d;
    }
  }
  let second = 0;
  for (let d = 1; d <= 8; d++) {
    if (d !== digit && probs[d] > second) second = probs[d];
  }
  const margin = confidence - second;

  const bboxW = best.maxX - best.minX + 1;
  const bboxH = best.maxY - best.minY + 1;
  const tiny = bboxW < 8 || bboxH < 12;
  const huge = best.area > cell.width * cell.height * 0.32;
  const hugeBox = bboxW > cell.width * 0.65 && bboxH > cell.height * 0.7;
  const uncertain =
    tiny || confidence < settings.confidenceThreshold || margin < settings.marginThreshold;

  return {
    row,
    digit,
    confidence,
    margin,
    area: best.area,
    state:
      tooDark || tooMuchDark || huge || hugeBox
        ? 'obstructed'
        : uncertain
          ? 'uncertain'
          : 'answered',
  };
}
