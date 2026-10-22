import type { AnswerKey, AppSettings, SetId } from '../types';

/** Initial answer key. The key is data, not recognition logic. */
export const DEFAULT_KEY: AnswerKey = {
  A: [4, 5, 1, 2, 6, 3, 6, 2, 1, 3, 4, 5],
  B: [2, 6, 1, 2, 1, 3, 5, 6, 4, 3, 4, 5],
  C: [8, 2, 3, 8, 7, 4, 5, 1, 7, 6, 1, 2],
  D: [3, 4, 3, 7, 8, 6, 5, 4, 1, 2, 5, 6],
  E: [7, 6, 8, 2, 1, 5, 1, 6, 3, 2, 4, 5],
};

export const DEFAULT_SETTINGS: AppSettings = {
  blankPolicy: 'wrong',
  confidenceThreshold: 0.7,
  marginThreshold: 0.35,
  autoCapture: true,
  duplicateGuard: true,
};

export const KEY_STORAGE = 'spm-scanner.answer-key.v1';
export const SETTINGS_STORAGE = 'spm-scanner.settings.v1';
export const SESSION_STORAGE = 'spm-scanner.session.v1';

/** Canonical rectified table size used by the scanner. */
export const TABLE_WIDTH = 1500;
export const TABLE_HEIGHT = 1463;

/** Horizontal printed line positions detected reliably on the reference sheet. */
export const ROW_LINES = [101, 196, 296, 393, 489, 593, 698, 800, 899, 1007, 1107, 1215, 1318];

/** Width of one of the five set blocks in the rectified table. */
export const BLOCK_WIDTH = TABLE_WIDTH / 5;

/**
 * Student answer sub-column inside each set block. The narrow row-number column
 * is on the left and the red-key/score column on the right; only this middle
 * column is ever read.
 */
export const STUDENT_CELL_LEFT = 40;
export const STUDENT_CELL_RIGHT = 190;

export const CELL_VERTICAL_INSET = 0.12;

export const MAX_CLASS = 8;
export const MIN_CLASS = 1;

export function cloneKey(key: AnswerKey): AnswerKey {
  return {
    A: [...key.A],
    B: [...key.B],
    C: [...key.C],
    D: [...key.D],
    E: [...key.E],
  };
}

export function validateKey(value: unknown): value is AnswerKey {
  if (!value || typeof value !== 'object') return false;
  const key = value as Record<string, unknown>;
  for (const set of ['A', 'B', 'C', 'D', 'E'] as SetId[]) {
    const arr = key[set];
    if (!Array.isArray(arr) || arr.length !== 12) return false;
    if (!arr.every((n) => Number.isInteger(n) && n >= 1 && n <= 8)) return false;
  }
  return true;
}
