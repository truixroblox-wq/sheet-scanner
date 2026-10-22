import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY, cloneKey, validateKey } from '../src/lib/config';
import {
  correctCell,
  keyIsDefault,
  markUncertain,
  resetKey,
  scoreScan,
  scoreSet,
} from '../src/lib/scoring';
import type { AnswerKey, CellResult, ScanResult, SetId, SetResult } from '../src/types';
import { SET_IDS } from '../src/types';
import { hammingDistance } from '../src/lib/image';

function makeCell(
  row: number,
  digit: number | null,
  state: CellResult['state'] = 'answered',
): CellResult {
  return { row, digit, confidence: 1, margin: 1, state, area: 100 };
}

function cellsFromDigits(digits: number[]): CellResult[] {
  return digits.map((digit, index) => makeCell(index + 1, digit));
}

function allCells(digits: AnswerKey): Record<SetId, CellResult[]> {
  return Object.fromEntries(
    SET_IDS.map((set) => [set, cellsFromDigits(digits[set])]),
  ) as Record<SetId, CellResult[]>;
}

function makeScan(cells: Record<SetId, CellResult[]>, key: AnswerKey): ScanResult {
  const scored = scoreScan(cells, key, 'wrong');
  return {
    id: 'scan-1',
    scanNumber: 1,
    createdAt: 0,
    sets: scored.sets,
    total: scored.total,
    totalPossible: scored.totalPossible,
    durationMs: 1000,
    imageHash: '0000000000000000',
    quality: { meanLuminance: 200, blurScore: 300, warnings: [] },
  };
}

function wrongKey(): AnswerKey {
  const key = cloneKey(DEFAULT_KEY);
  for (const set of SET_IDS) {
    key[set] = key[set].map((digit) => (digit === 8 ? 1 : digit + 1));
  }
  return key;
}

describe('answer key configuration', () => {
  it('ships the documented 5 x 12 initial key', () => {
    expect(DEFAULT_KEY.A).toEqual([4, 5, 1, 2, 6, 3, 6, 2, 1, 3, 4, 5]);
    expect(DEFAULT_KEY.B).toEqual([2, 6, 1, 2, 1, 3, 5, 6, 4, 3, 4, 5]);
    expect(DEFAULT_KEY.C).toEqual([8, 2, 3, 8, 7, 4, 5, 1, 7, 6, 1, 2]);
    expect(DEFAULT_KEY.D).toEqual([3, 4, 3, 7, 8, 6, 5, 4, 1, 2, 5, 6]);
    expect(DEFAULT_KEY.E).toEqual([7, 6, 8, 2, 1, 5, 1, 6, 3, 2, 4, 5]);
    expect(keyIsDefault(DEFAULT_KEY)).toBe(true);
    expect(keyIsDefault(resetKey())).toBe(true);
  });

  it('deep-clones keys instead of sharing arrays', () => {
    const copy = cloneKey(DEFAULT_KEY);
    copy.A[0] = 8;
    expect(DEFAULT_KEY.A[0]).toBe(4);
  });

  it('rejects malformed imported keys', () => {
    expect(validateKey(DEFAULT_KEY)).toBe(true);
    expect(validateKey(null)).toBe(false);
    expect(validateKey({ ...DEFAULT_KEY, A: DEFAULT_KEY.A.slice(0, 11) })).toBe(false);
    expect(validateKey({ ...DEFAULT_KEY, B: [...DEFAULT_KEY.B.slice(0, 11), 9] })).toBe(false);
    expect(validateKey({ ...DEFAULT_KEY, C: [...DEFAULT_KEY.C.slice(0, 11), 0] })).toBe(false);
    expect(validateKey({ A: DEFAULT_KEY.A })).toBe(false);
  });
});

describe('scoring', () => {
  it('scores a perfect sheet 60/60', () => {
    const scored = scoreScan(allCells(DEFAULT_KEY), DEFAULT_KEY, 'wrong');
    expect(scored.total).toBe(60);
    expect(scored.totalPossible).toBe(60);
    for (const set of SET_IDS) expect(scored.sets[set].score).toBe(12);
  });

  it('scores an all-wrong sheet 0/60', () => {
    const key = wrongKey();
    const scored = scoreScan(allCells(key), DEFAULT_KEY, 'wrong');
    expect(scored.total).toBe(0);
  });

  it('counts a blank as wrong by default and still uses /12', () => {
    const cells = cellsFromDigits(DEFAULT_KEY.A);
    cells[0] = makeCell(1, null, 'blank');
    const result = scoreSet('A', cells, DEFAULT_KEY, 'wrong');
    expect(result.score).toBe(11);
    expect(result.denominator).toBe(12);
    expect(result.blanks).toBe(1);
    expect(result.answered).toBe(11);
  });

  it('excludes blanks from the maximum when the policy says unanswered', () => {
    const cells = cellsFromDigits(DEFAULT_KEY.A);
    cells[0] = makeCell(1, null, 'blank');
    const result = scoreSet('A', cells, DEFAULT_KEY, 'unanswered');
    expect(result.score).toBe(11);
    expect(result.denominator).toBe(11);
    expect(result.blanks).toBe(1);
  });

  it('never silently counts an obstructed cell as an answer', () => {
    const cells = cellsFromDigits(DEFAULT_KEY.A);
    cells[0] = makeCell(1, 4, 'obstructed');
    const wrong = scoreSet('A', cells, DEFAULT_KEY, 'wrong');
    const unanswered = scoreSet('A', cells, DEFAULT_KEY, 'unanswered');
    expect(wrong.score).toBe(11);
    expect(wrong.obstructed).toBe(1);
    expect(wrong.denominator).toBe(12);
    expect(unanswered.score).toBe(11);
    expect(unanswered.denominator).toBe(11);
  });

  it('rejects malformed cell counts', () => {
    expect(() =>
      scoreSet('A', cellsFromDigits(DEFAULT_KEY.A).slice(0, 11), DEFAULT_KEY, 'wrong'),
    ).toThrow();
    expect(() =>
      scoreSet('A', cellsFromDigits(DEFAULT_KEY.A), { ...DEFAULT_KEY, A: [] }, 'wrong'),
    ).toThrow();
  });
});

describe('corrections', () => {
  it('recalculates a set and total immediately', () => {
    const key = wrongKey();
    const scan = makeScan(allCells(key), DEFAULT_KEY);
    expect(scan.total).toBe(0);

    const corrected = correctCell(scan, 'A', 1, DEFAULT_KEY.A[0], DEFAULT_KEY, 'wrong');
    expect(corrected.sets.A.score).toBe(1);
    expect(corrected.total).toBe(1);
    expect(corrected.sets.A.cells[0].corrected).toBe(true);
    expect(corrected.sets.A.cells[0].confidence).toBe(1);
  });

  it('can mark an answer blank and rescore it', () => {
    const scan = makeScan(allCells(DEFAULT_KEY), DEFAULT_KEY);
    const corrected = correctCell(scan, 'B', 4, null, DEFAULT_KEY, 'wrong');
    expect(corrected.sets.B.score).toBe(11);
    expect(corrected.sets.B.cells[3].state).toBe('blank');
    expect(corrected.sets.B.cells[3].digit).toBeNull();
    expect(corrected.sets.B.denominator).toBe(12);
  });

  it('keeps corrected answers trusted when thresholds are applied', () => {
    const scan = makeScan(allCells(DEFAULT_KEY), DEFAULT_KEY);
    const corrected = correctCell(scan, 'C', 2, DEFAULT_KEY.C[1], DEFAULT_KEY, 'wrong', {
      confidenceThreshold: 0.9,
      marginThreshold: 0.5,
    });
    expect(corrected.sets.C.cells[1].corrected).toBe(true);
    expect(corrected.sets.C.cells[1].state).toBe('answered');
  });
});

describe('confidence flags', () => {
  it('marks low-confidence and low-margin readings as uncertain', () => {
    const cells = cellsFromDigits(DEFAULT_KEY.A);
    cells[0] = { ...cells[0], confidence: 0.4, margin: 0.5 };
    cells[1] = { ...cells[1], confidence: 0.9, margin: 0.1 };
    cells[2] = { ...cells[2], confidence: 0.9, margin: 0.8 };
    const sets = {} as Record<SetId, SetResult>;
    for (const set of SET_IDS) {
      sets[set] = {
        set,
        cells,
        score: 12,
        correct: 12,
        answered: 12,
        blanks: 0,
        obstructed: 0,
        denominator: 12,
      };
    }
    const marked = markUncertain(sets, 0.7, 0.35);
    expect(marked.A.cells[0].state).toBe('uncertain');
    expect(marked.A.cells[1].state).toBe('uncertain');
    expect(marked.A.cells[2].state).toBe('answered');
  });
});

describe('duplicate hashing', () => {
  it('measures Hamming distance between perceptual hashes', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('abc', 'abcd')).toBe(Number.MAX_SAFE_INTEGER);
  });
});
