import { describe, expect, it } from 'vitest';
import {
  HOG_DIMENSIONS,
  countHoles,
  hogFeatures,
  matchReference,
  shouldFlagReference,
  type ReferenceCorpus,
  type ReferenceMatch,
} from '../src/lib/ocr/features';
import { getReferenceCorpus } from '../src/lib/ocr/reference';

function ring(): Float32Array {
  const vector = new Float32Array(28 * 28);
  for (let y = 6; y <= 21; y++) {
    for (let x = 6; x <= 21; x++) {
      if (x === 6 || x === 21 || y === 6 || y === 21) vector[y * 28 + x] = 1;
    }
  }
  return vector;
}

function line(): Float32Array {
  const vector = new Float32Array(28 * 28);
  for (let x = 4; x <= 23; x++) vector[14 * 28 + x] = 1;
  return vector;
}

describe('reference features', () => {
  it('produces compact 8-bit HOG descriptors', () => {
    const feature = hogFeatures(ring());
    expect(feature).toHaveLength(HOG_DIMENSIONS);
    expect(feature.some((value) => value > 0)).toBe(true);
    expect(Math.max(...feature)).toBeLessThanOrEqual(255);
    expect(hogFeatures(ring())).toEqual(feature);
  });

  it('counts enclosed regions without counting the outer background', () => {
    expect(countHoles(ring())).toBe(1);
    expect(countHoles(line())).toBe(0);
    expect(countHoles(new Float32Array(28 * 28))).toBe(0);
  });

  it('votes for the closest verified reference', () => {
    const corpus: ReferenceCorpus = {
      features: [hogFeatures(ring()), hogFeatures(line())],
      labels: Uint8Array.from([4, 7]),
    };
    const match = matchReference(ring(), corpus);
    expect(match?.digit).toBe(4);
    expect(match?.confidence).toBeGreaterThan(0.9);
    expect(match?.holes).toBe(1);
    expect(match?.distance).toBe(0);
  });

  it('only flags an answered reading on strong reference evidence', () => {
    const match = (digit: number, confidence: number, holes = 0): ReferenceMatch => ({
      digit,
      confidence,
      margin: confidence,
      distance: 0,
      holes,
    });
    expect(shouldFlagReference(4, match(4, 1))).toBe(false);
    expect(shouldFlagReference(4, match(7, 0.49))).toBe(false);
    expect(shouldFlagReference(4, match(7, 0.5))).toBe(true);
    expect(shouldFlagReference(7, match(7, 1, 1))).toBe(true);
    expect(shouldFlagReference(null, match(4, 1))).toBe(false);
  });

  it('loads the generated verified corpus', () => {
    const corpus = getReferenceCorpus();
    expect(corpus).not.toBeNull();
    expect(corpus?.features).toHaveLength(719);
    expect(corpus?.labels).toHaveLength(719);
    expect(corpus?.features.every((feature) => feature.length === HOG_DIMENSIONS)).toBe(true);
    expect(Array.from(corpus?.labels ?? []).every((label) => label >= 1 && label <= 8)).toBe(true);
  });
});
