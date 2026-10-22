export type SetId = 'A' | 'B' | 'C' | 'D' | 'E';

export const SET_IDS: SetId[] = ['A', 'B', 'C', 'D', 'E'];

export type AnswerKey = Record<SetId, number[]>;

export type BlankPolicy = 'wrong' | 'unanswered' | 'review';

export type CellState = 'answered' | 'blank' | 'uncertain' | 'obstructed';

export interface CellResult {
  row: number;
  digit: number | null;
  /** Softmax confidence of the winning digit, 0..1. */
  confidence: number;
  /** Difference between the top two digit probabilities. */
  margin: number;
  state: CellState;
  /** Ink area of the selected component group. */
  area: number;
  /** True when the user explicitly corrected this cell. */
  corrected?: boolean;
}

export interface SetResult {
  set: SetId;
  cells: CellResult[];
  score: number;
  correct: number;
  answered: number;
  blanks: number;
  obstructed: number;
  /** Maximum for this set after the blank policy is applied (normally 12). */
  denominator: number;
}

export interface ScanQuality {
  meanLuminance: number;
  blurScore: number;
  warnings: string[];
}

export interface ScanResult {
  id: string;
  scanNumber: number;
  createdAt: number;
  sets: Record<SetId, SetResult>;
  total: number;
  totalPossible: number;
  durationMs: number;
  imageHash: string;
  quality: ScanQuality;
}

export interface AppSettings {
  blankPolicy: BlankPolicy;
  confidenceThreshold: number;
  marginThreshold: number;
  autoCapture: boolean;
  duplicateGuard: boolean;
}
