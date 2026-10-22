import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEY,
  DEFAULT_SETTINGS,
  VALIDATED_CONFIDENCE_THRESHOLD,
  VALIDATED_MARGIN_THRESHOLD,
  cloneKey,
  validateKey,
} from '../src/lib/config';
import {
  cellNeedsConfirmation,
  correctCell,
  countUnresolved,
  isScanFinalized,
  keyIsDefault,
  markUncertain,
  resetKey,
  scoreScan,
  scoreSet,
  unresolvedCells,
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

  it('always keeps the total equal to the five set scores and at most 60', () => {
    let seed = 1234567;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let sheet = 0; sheet < 20; sheet++) {
      const cells = {} as Record<SetId, CellResult[]>;
      for (const set of SET_IDS) {
        cells[set] = Array.from({ length: 12 }, (_, index) => {
          const roll = next();
          if (roll < 0.08) return makeCell(index + 1, null, 'blank');
          if (roll < 0.12) return makeCell(index + 1, null, 'obstructed');
          return makeCell(index + 1, 1 + Math.floor(next() * 8));
        });
      }
      const scored = scoreScan(cells, DEFAULT_KEY, 'wrong');
      const sumOfSets = SET_IDS.reduce((sum, set) => sum + scored.sets[set].score, 0);
      expect(scored.total).toBe(sumOfSets);
      expect(scored.total).toBeGreaterThanOrEqual(0);
      expect(scored.total).toBeLessThanOrEqual(60);
      expect(scored.totalPossible).toBe(60);
    }
  });

  it('keeps every set maximum at 12 when blanks count as wrong', () => {
    const cells = cellsFromDigits(DEFAULT_KEY.A);
    cells[0] = makeCell(1, null, 'blank');
    cells[1] = makeCell(2, null, 'obstructed');
    const result = scoreSet('A', cells, DEFAULT_KEY, 'wrong');
    expect(result.denominator).toBe(12);
  });
});

describe('confirmation gate', () => {
  it('uses the validated gate by default', () => {
    expect(DEFAULT_SETTINGS.confidenceThreshold).toBe(VALIDATED_CONFIDENCE_THRESHOLD);
    expect(DEFAULT_SETTINGS.marginThreshold).toBe(VALIDATED_MARGIN_THRESHOLD);
    expect(DEFAULT_SETTINGS.confidenceThreshold).toBe(0.96);
    expect(DEFAULT_SETTINGS.marginThreshold).toBe(0.9);
  });

  it('keeps an uncertain model prediction unresolved until the teacher confirms it', () => {
    const cells = allCells(DEFAULT_KEY);
    cells.A[0] = makeCell(1, 4, 'uncertain');
    const scan = makeScan(cells, DEFAULT_KEY);

    expect(cellNeedsConfirmation(scan.sets.A.cells[0])).toBe(true);
    expect(countUnresolved(scan)).toBe(1);
    expect(isScanFinalized(scan)).toBe(false);
    expect(unresolvedCells(scan)[0]).toMatchObject({ set: 'A', cell: { row: 1 } });

    const confirmed = correctCell(scan, 'A', 1, 4, DEFAULT_KEY, 'wrong');
    expect(confirmed.sets.A.cells[0].confirmed).toBe(true);
    expect(confirmed.sets.A.cells[0].corrected).toBe(true);
    expect(cellNeedsConfirmation(confirmed.sets.A.cells[0])).toBe(false);
    expect(countUnresolved(confirmed)).toBe(0);
    expect(isScanFinalized(confirmed)).toBe(true);
  });

  it('requires confirmation for obstructed cells and accepts an explicit blank decision', () => {
    const cells = allCells(DEFAULT_KEY);
    cells.B[2] = makeCell(3, null, 'obstructed');
    const scan = makeScan(cells, DEFAULT_KEY);
    expect(countUnresolved(scan)).toBe(1);

    const blanked = correctCell(scan, 'B', 3, null, DEFAULT_KEY, 'wrong');
    expect(blanked.sets.B.cells[2].state).toBe('blank');
    expect(blanked.sets.B.cells[2].confirmed).toBe(true);
    expect(countUnresolved(blanked)).toBe(0);
  });

  it('does not treat a clean blank as an unresolved answer', () => {
    const cells = allCells(DEFAULT_KEY);
    cells.C[0] = makeCell(1, null, 'blank');
    const scan = makeScan(cells, DEFAULT_KEY);
    expect(cellNeedsConfirmation(scan.sets.C.cells[0])).toBe(false);
    expect(countUnresolved(scan)).toBe(0);
  });

  it('preserves the local crop when a cell is confirmed', () => {
    const cells = allCells(DEFAULT_KEY);
    cells.A[0] = {
      ...makeCell(1, 4, 'uncertain'),
      cropUrl: 'data:image/png;base64,AAAA',
    };
    const scan = makeScan(cells, DEFAULT_KEY);
    const confirmed = correctCell(scan, 'A', 1, 4, DEFAULT_KEY, 'wrong');
    expect(confirmed.sets.A.cells[0].cropUrl).toBe('data:image/png;base64,AAAA');
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

  it('never re-flags a teacher-confirmed answer when thresholds change', () => {
    const cells = cellsFromDigits(DEFAULT_KEY.A);
    cells[0] = {
      ...cells[0],
      confidence: 0.1,
      margin: 0.1,
      confirmed: true,
      corrected: true,
    };
    const sets = markUncertain(
      {
        A: {
          set: 'A',
          cells,
          score: 12,
          correct: 12,
          answered: 12,
          blanks: 0,
          obstructed: 0,
          denominator: 12,
        },
        ...Object.fromEntries(
          SET_IDS.filter((set) => set !== 'A').map((set) => [
            set,
            {
              set,
              cells: cellsFromDigits(DEFAULT_KEY[set]),
              score: 12,
              correct: 12,
              answered: 12,
              blanks: 0,
              obstructed: 0,
              denominator: 12,
            },
          ]),
        ),
      } as Record<SetId, SetResult>,
      VALIDATED_CONFIDENCE_THRESHOLD,
      VALIDATED_MARGIN_THRESHOLD,
    );
    expect(sets.A.cells[0].state).toBe('answered');
    const scan = makeScan(
      Object.fromEntries(SET_IDS.map((set) => [set, sets[set].cells])) as Record<
        SetId,
        CellResult[]
      >,
      DEFAULT_KEY,
    );
    expect(countUnresolved(scan)).toBe(0);
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
