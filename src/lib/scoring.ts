import { DEFAULT_KEY, cloneKey } from './config';
import type {
  AnswerKey,
  AppSettings,
  BlankPolicy,
  CellResult,
  ScanResult,
  SetId,
  SetResult,
} from '../types';
import { SET_IDS } from '../types';

/** Score one set against the key. */
export function scoreSet(set: SetId, cells: CellResult[], key: AnswerKey, blankPolicy: BlankPolicy): SetResult {
  const answers = key[set];
  if (answers.length !== 12) throw new Error(`Answer key for set ${set} must have 12 entries`);
  if (cells.length !== 12) throw new Error(`Set ${set} must have 12 cells`);

  let correct = 0;
  let answered = 0;
  let blanks = 0;
  let obstructed = 0;

  cells.forEach((cell, index) => {
    const expected = answers[index];
    if (cell.state === 'obstructed') {
      obstructed++;
      return;
    }
    if (cell.digit == null) {
      blanks++;
      return;
    }
    answered++;
    if (cell.digit === expected) correct++;
  });

  // Blanks are either wrong (denominator 12), excluded (denominator answered),
  // or left as wrong pending review (same score as wrong, but flagged).
  const denominator = blankPolicy === 'unanswered' ? 12 - blanks - obstructed : 12;
  const score = correct;
  return {
    set,
    cells,
    score,
    correct,
    answered,
    blanks,
    obstructed,
    denominator,
  };
}

export interface ScanScore {
  sets: Record<SetId, SetResult>;
  total: number;
  totalPossible: number;
}

/** Score a full answer sheet. */
export function scoreScan(cells: Record<SetId, CellResult[]>, key: AnswerKey, blankPolicy: BlankPolicy): ScanScore {
  const sets = {} as Record<SetId, SetResult>;
  let total = 0;
  let possible = 0;
  for (const set of SET_IDS) {
    const result = scoreSet(set, cells[set], key, blankPolicy);
    sets[set] = result;
    total += result.score;
    possible += result.denominator;
  }
  return { sets, total, totalPossible: possible };
}

/** Recompute a scan result after one or more cell corrections. */
export function applyCorrections(scan: ScanResult, key: AnswerKey, blankPolicy: BlankPolicy): ScanResult {
  const scored = scoreScan(
    {
      A: scan.sets.A.cells,
      B: scan.sets.B.cells,
      C: scan.sets.C.cells,
      D: scan.sets.D.cells,
      E: scan.sets.E.cells,
    },
    key,
    blankPolicy,
  );
  return { ...scan, ...scored, total: scored.total, totalPossible: scored.totalPossible };
}

export function correctCell(
  scan: ScanResult,
  set: SetId,
  row: number,
  digit: number | null,
  key: AnswerKey,
  blankPolicy: BlankPolicy,
  settings?: Partial<AppSettings>,
): ScanResult {
  const cells = scan.sets[set].cells.map((cell) =>
    cell.row === row
      ? {
          ...cell,
          digit,
          corrected: true,
          state: digit == null ? ('blank' as const) : ('answered' as const),
          confidence: digit == null ? 0 : 1,
          margin: digit == null ? 0 : 1,
        }
      : cell,
  );
  const updated: ScanResult = {
    ...scan,
    sets: { ...scan.sets, [set]: { ...scan.sets[set], cells } },
  };
  const rescored = applyCorrections(updated, key, blankPolicy);
  // Low-confidence flags remain useful for untouched cells; corrected cells are trusted.
  if (settings?.confidenceThreshold == null && settings?.marginThreshold == null) return rescored;
  return {
    ...rescored,
    sets: markUncertain(rescored.sets, settings.confidenceThreshold ?? 0.7, settings.marginThreshold ?? 0.35),
  };
}

export function markUncertain(
  sets: Record<SetId, SetResult>,
  confidenceThreshold: number,
  marginThreshold: number,
): Record<SetId, SetResult> {
  const out = {} as Record<SetId, SetResult>;
  for (const set of SET_IDS) {
    const result = sets[set];
    out[set] = {
      ...result,
      cells: result.cells.map((cell) => {
        if (cell.corrected || cell.state === 'blank' || cell.state === 'obstructed') return cell;
        if (cell.digit == null) return cell;
        const uncertain = cell.confidence < confidenceThreshold || cell.margin < marginThreshold;
        return uncertain ? { ...cell, state: 'uncertain' as const } : cell;
      }),
    };
  }
  return out;
}

export function blankPolicyLabel(policy: BlankPolicy): string {
  switch (policy) {
    case 'wrong':
      return 'Blank counts as wrong';
    case 'unanswered':
      return 'Blank excluded from maximum';
    case 'review':
      return 'Blank flagged for review';
  }
}

export function keyIsDefault(key: AnswerKey): boolean {
  return SET_IDS.every((set) => key[set].every((v, i) => v === DEFAULT_KEY[set][i]));
}

export function resetKey(): AnswerKey {
  return cloneKey(DEFAULT_KEY);
}
