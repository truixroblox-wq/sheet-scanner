import { describe, expect, it } from 'vitest';
import { findDuplicateSheet } from '../src/lib/duplicates';

const sheet = (imageHash: string) => ({ imageHash });

describe('duplicate-image protection', () => {
  it('detects a near-identical image in the same batch', () => {
    const sheets = [sheet('0000000000000000'), sheet('ffffffffffffffff')];
    expect(findDuplicateSheet(sheets, '0000000000000001', true)).toBe(sheets[0]);
  });

  it('does not block a rescan when the session is cleared', () => {
    const previousSession = [sheet('0000000000000000')];
    expect(findDuplicateSheet(previousSession, '0000000000000000', true)).toBe(previousSession[0]);

    // "Scan another sheet" clears the session before the next scan.
    const nextSession: ReturnType<typeof sheet>[] = [];
    expect(findDuplicateSheet(nextSession, '0000000000000000', true)).toBeUndefined();
  });

  it('respects the duplicate-guard setting', () => {
    expect(findDuplicateSheet([sheet('0000000000000000')], '0000000000000000', false)).toBeUndefined();
  });

  it('allows different sheets in the same batch', () => {
    const sheets = [sheet('0000000000000000')];
    expect(findDuplicateSheet(sheets, 'ffffffffffffffff', true)).toBeUndefined();
  });
});
