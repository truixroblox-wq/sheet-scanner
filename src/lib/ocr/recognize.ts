import { predictMnist } from './cnn';
import {
  extractCell,
  normalizeCell,
  type ExtractionOptions,
  type NormalizeInfo,
} from './preprocess';
import {
  matchReference,
  shouldFlagReference,
  type ReferenceCorpus,
} from './features';
import type { CellResult } from '../../types';

export interface RecognitionSettings {
  confidenceThreshold: number;
  marginThreshold: number;
}

export interface RecognitionOptions {
  /** Optional verified-reference corpus used as a second opinion. */
  referenceCorpus?: ReferenceCorpus | null;
  /** Stroke grouping mode. Defaults to the legacy path. */
  segmentation?: 'legacy' | 'merged';
  /** Optional tuning for the measured preprocessing stages. */
  extraction?: ExtractionOptions;
}

const ROTATION_ANGLES = [-8, 8] as const;
const ROTATION_SIZE = 28;
const SKIP_TTA_CONFIDENCE = 0.97;
const SKIP_TTA_MARGIN = 0.9;

const rotationMaps = new Map<number, Int16Array>();

function rotationMap(degrees: number): Int16Array {
  const cached = rotationMaps.get(degrees);
  if (cached) return cached;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const center = ROTATION_SIZE / 2;
  const map = new Int16Array(ROTATION_SIZE * ROTATION_SIZE);
  for (let y = 0; y < ROTATION_SIZE; y++) {
    for (let x = 0; x < ROTATION_SIZE; x++) {
      const dx = x - center;
      const dy = y - center;
      const sx = Math.round(cos * dx + sin * dy + center);
      const sy = Math.round(-sin * dx + cos * dy + center);
      map[y * ROTATION_SIZE + x] =
        sx >= 0 && sx < ROTATION_SIZE && sy >= 0 && sy < ROTATION_SIZE
          ? sy * ROTATION_SIZE + sx
          : -1;
    }
  }
  rotationMaps.set(degrees, map);
  return map;
}

function rotate(input: Float32Array, degrees: number): Float32Array {
  const map = rotationMap(degrees);
  const out = new Float32Array(map.length);
  for (let i = 0; i < map.length; i++) {
    const source = map[i];
    if (source >= 0) out[i] = input[source];
  }
  return out;
}

interface PermittedScore {
  digit: number;
  confidence: number;
  margin: number;
}

/** Collapse the 10-class output to the digits 1..8 allowed on the sheet. */
function permittedScore(probabilities: ArrayLike<number>): PermittedScore | null {
  let total = 0;
  for (let d = 1; d <= 8; d++) total += probabilities[d];
  if (total <= 0) return null;

  let digit = 1;
  let best = 0;
  let second = 0;
  for (let d = 1; d <= 8; d++) {
    const p = probabilities[d];
    if (p > best) {
      second = best;
      best = p;
      digit = d;
    } else if (p > second) {
      second = p;
    }
  }
  return {
    digit,
    confidence: best / total,
    margin: (best - second) / total,
  };
}

/**
 * Recognise one student answer cell. Returns a null digit for a genuinely blank
 * cell and an obstructed/uncertain state when the evidence is poor.
 */
export function recognizeCell(
  cell: ImageData,
  settings: RecognitionSettings,
  row: number,
  options?: RecognitionOptions,
): CellResult {
  const extraction = extractCell(cell, {
    grouping: options?.segmentation,
    ...options?.extraction,
  });
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

  const normalizeInfo: NormalizeInfo = { contrastStretched: false, peak: 0 };
  const norm = normalizeCell(extraction, best, 28, normalizeInfo);
  const base = predictMnist(norm);
  const baseScore = permittedScore(base.probabilities);
  if (!baseScore) {
    return { row, digit: null, confidence: 0, margin: 0, area: best.area, state: 'obstructed' };
  }

  let score = baseScore;
  // The three-angle ensemble is valuable for ambiguous handwriting. For a
  // decisive base reading it cannot change the digit or confidence state, so
  // skip the two extra convolutions and reuse the base pass.
  if (
    baseScore.confidence < SKIP_TTA_CONFIDENCE ||
    baseScore.margin < SKIP_TTA_MARGIN
  ) {
    const combined = new Float32Array(10);
    for (let d = 0; d < 10; d++) combined[d] = base.probabilities[d];
    for (const angle of ROTATION_ANGLES) {
      const pred = predictMnist(rotate(norm, angle));
      for (let d = 0; d < 10; d++) combined[d] += pred.probabilities[d];
    }
    for (let d = 0; d < 10; d++) combined[d] /= 3;
    const ensembleScore = permittedScore(combined);
    if (!ensembleScore) {
      return { row, digit: null, confidence: 0, margin: 0, area: best.area, state: 'obstructed' };
    }
    score = ensembleScore;
  }

  const { digit, confidence, margin } = score;

  const bboxW = best.maxX - best.minX + 1;
  const bboxH = best.maxY - best.minY + 1;
  const tiny = bboxW < 8 || bboxH < 12;
  const huge = best.area > cell.width * cell.height * 0.32;
  const hugeBox = bboxW > cell.width * 0.65 && bboxH > cell.height * 0.7;
  // A stretched cell is readable but its original ink was too faint for the
  // confidence gate to be trusted unreviewed. Keep the predicted digit and
  // crop, then let the teacher confirm it rather than auto-accepting it.
  const uncertain =
    tiny ||
    normalizeInfo.contrastStretched ||
    confidence < settings.confidenceThreshold ||
    margin < settings.marginThreshold;

  let state: CellResult['state'] =
    tooDark || tooMuchDark || huge || hugeBox
      ? 'obstructed'
      : uncertain
        ? 'uncertain'
        : 'answered';

  // Only a decisive reading needs a second opinion. Low-confidence cells are
  // already reviewable; the reference check is there to catch confident CNN
  // style errors without guessing a replacement digit.
  if (state === 'answered' && options?.referenceCorpus) {
    const match = matchReference(norm, options.referenceCorpus);
    if (shouldFlagReference(digit, match)) state = 'uncertain';
  }

  return {
    row,
    digit,
    confidence,
    margin,
    area: best.area,
    state,
  };
}
