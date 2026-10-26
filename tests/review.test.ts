import { describe, expect, it } from 'vitest';
import type { CellResult, ScanResult, SetId } from '../src/types';
import { SET_IDS } from '../src/types';
import {
  allScansReviewed,
  nextScanNeedingReview,
  sortScansByNumber,
} from '../src/lib/review';

function scan(scanNumber: number, pending = false, total = scanNumber): ScanResult {
  const cells: CellResult[] = Array.from({ length: 12 }, (_, index) => ({
    row: index + 1,
    digit: 1,
    confidence: 1,
    margin: 1,
    area: 100,
    state: pending && index === 0 ? 'uncertain' : 'answered',
  }));
  const sets = Object.fromEntries(
    SET_IDS.map((set: SetId) => [
      set,
      { set, cells, score: 0, correct: 0, answered: 12, blanks: 0, obstructed: 0, denominator: 12 },
    ]),
  ) as ScanResult['sets'];
  return {
    id: `scan-${scanNumber}`,
    scanNumber,
    createdAt: scanNumber,
    sets,
    total,
    totalPossible: 60,
    durationMs: 100,
    imageHash: `hash-${scanNumber}`,
    quality: { meanLuminance: 200, blurScore: 100, warnings: [] },
  };
}

describe('batch review ordering', () => {
  it('sorts numeric scan numbers, not strings', () => {
    const scans = [scan(10, false, 42), scan(2, false, 31), scan(11, false, 55), scan(1, false, 20)];
    expect(sortScansByNumber(scans).map((item) => item.scanNumber)).toEqual([1, 2, 10, 11]);
    expect(sortScansByNumber(scans).find((item) => item.scanNumber === 10)?.total).toBe(42);
    expect(scans.map((item) => item.scanNumber)).toEqual([10, 2, 11, 1]);
  });

  it('advances to the next unresolved sheet in ascending order', () => {
    const scans = [scan(10, true), scan(1), scan(3, true), scan(2, true)];
    expect(nextScanNeedingReview(scans, 1)?.scanNumber).toBe(2);
    expect(nextScanNeedingReview(scans, 2)?.scanNumber).toBe(3);
    expect(nextScanNeedingReview(scans, 3)?.scanNumber).toBe(10);
  });

  it('wraps to the earliest unresolved sheet when no later sheet remains', () => {
    const scans = [scan(1, true), scan(2), scan(5)];
    expect(nextScanNeedingReview(scans, 5)?.scanNumber).toBe(1);
  });

  it('returns null only when every sheet is resolved', () => {
    expect(nextScanNeedingReview([scan(1), scan(2)], 1)).toBeNull();
  });

  it('reports batch completion only when at least one sheet exists and all are resolved', () => {
    expect(allScansReviewed([])).toBe(false);
    expect(allScansReviewed([scan(1), scan(2)])).toBe(true);
    expect(allScansReviewed([scan(1), scan(2, true)])).toBe(false);
  });
});
