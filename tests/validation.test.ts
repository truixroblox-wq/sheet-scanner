import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEY,
  DEFAULT_SETTINGS,
  TABLE_HEIGHT,
  TABLE_WIDTH,
  VALIDATED_CONFIDENCE_THRESHOLD,
  VALIDATED_MARGIN_THRESHOLD,
} from '../src/lib/config';
import { correctCell, countUnresolved, scoreScan } from '../src/lib/scoring';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { hogFeatures } from '../src/lib/ocr/features';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { detectTableQuad, grayscale, warpPerspective } from '../src/lib/vision/warp';
import type { CellResult, ScanResult, SetId } from '../src/types';
import { SET_IDS } from '../src/types';

class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

(globalThis as unknown as { ImageData: typeof FakeImageData }).ImageData = FakeImageData;

const SAMPLE = path.resolve('samples/reference-2.png');
const LABELS = path.resolve('samples/validation/reference-2-labels.json');
const hasSample = fs.existsSync(SAMPLE) && fs.existsSync(LABELS);

function readImage(file: string): ImageData {
  const png = PNG.sync.read(fs.readFileSync(file));
  const data = new Uint8ClampedArray(png.width * png.height * 4);
  for (let i = 0; i < png.width * png.height; i++) {
    data[i * 4] = png.data[i * 4];
    data[i * 4 + 1] = png.data[i * 4 + 1];
    data[i * 4 + 2] = png.data[i * 4 + 2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: png.width, height: png.height } as ImageData;
}

function resize(image: ImageData, maxSide: number): ImageData {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.round((y / height) * image.height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.round((x / width) * image.width));
      const si = (sy * image.width + sx) * 4;
      const di = (y * width + x) * 4;
      data[di] = image.data[si];
      data[di + 1] = image.data[si + 1];
      data[di + 2] = image.data[si + 2];
      data[di + 3] = 255;
    }
  }
  return { data, width, height } as ImageData;
}

function loadReferenceCells(): Record<SetId, ImageData[]> {
  const source = readImage(SAMPLE);
  const detectionCopy = resize(source, 1200);
  const quad = detectTableQuad(
    grayscale(detectionCopy),
    detectionCopy.width,
    detectionCopy.height,
  );
  if (!quad) throw new Error('Could not detect the reference table');
  const quadFull = quad.map((point) => ({
    x: point.x * (source.width / detectionCopy.width),
    y: point.y * (source.height / detectionCopy.height),
  }));
  const warped = warpPerspective(source, quadFull, TABLE_WIDTH, TABLE_HEIGHT);
  return cropCells(warped, detectGrid(warped));
}

function gateFlags(cell: CellResult, confidence: number, margin: number): boolean {
  if (cell.state === 'obstructed' || cell.state === 'uncertain') return true;
  if (cell.digit == null) return false; // A clean blank is a resolved non-answer.
  return cell.confidence < confidence || cell.margin < margin;
}

describe.skipIf(!hasSample)('validated confirmation gate', () => {
  const labels = (
    JSON.parse(fs.readFileSync(LABELS, 'utf8')) as {
      labels: Record<SetId, number[]>;
    }
  ).labels;

  // A permissive recognition pass exposes raw confidence/margin. The actual
  // gate is applied below exactly as the app and markUncertain do.
  const referenceCells = loadReferenceCells();
  const results = {} as Record<SetId, CellResult[]>;
  for (const set of SET_IDS) {
    results[set] = referenceCells[set].map((cell, index) =>
      recognizeCell(cell, { confidenceThreshold: 0, marginThreshold: 0 }, index + 1),
    );
  }

  it('has a 60-cell hand-labeled ground truth for the real reference sheet', () => {
    for (const set of SET_IDS) {
      expect(labels[set]).toHaveLength(12);
      expect(results[set]).toHaveLength(12);
    }
  });

  it('auto-accepts zero misreads with the validated 96% / 90% gate', () => {
    let accepted = 0;
    let flagged = 0;
    let acceptedErrors = 0;
    let flaggedErrors = 0;

    for (const set of SET_IDS) {
      results[set].forEach((cell, index) => {
        const isError = cell.digit !== labels[set][index];
        if (gateFlags(cell, VALIDATED_CONFIDENCE_THRESHOLD, VALIDATED_MARGIN_THRESHOLD)) {
          flagged++;
          if (isError) flaggedErrors++;
        } else {
          accepted++;
          if (isError) acceptedErrors++;
        }
      });
    }

    expect(accepted).toBe(38);
    expect(flagged).toBe(22);
    expect(acceptedErrors).toBe(0);
    expect(flaggedErrors).toBe(7);
  });

  it('flags all seven known model misreads', () => {
    const errors: string[] = [];
    for (const set of SET_IDS) {
      results[set].forEach((cell, index) => {
        if (cell.digit !== labels[set][index]) {
          errors.push(`${set}${index + 1}`);
          expect(
            gateFlags(cell, VALIDATED_CONFIDENCE_THRESHOLD, VALIDATED_MARGIN_THRESHOLD),
          ).toBe(true);
        }
      });
    }
    expect(errors).toEqual(['B10', 'C1', 'C4', 'D5', 'E2', 'E10', 'E12']);
  });

  it('shows why the gate must stay above 95% confidence', () => {
    const c1 = results.C[0];
    expect(c1.confidence).toBeGreaterThanOrEqual(0.95);
    expect(c1.confidence).toBeLessThan(0.96);
    expect(c1.margin).toBeGreaterThanOrEqual(0.9);
    expect(gateFlags(c1, 0.95, 0.9)).toBe(false);
    expect(gateFlags(c1, 0.96, 0.9)).toBe(true);
  });

  it('matches the documented model score on the labeled reference sheet', () => {
    const scored = scoreScan(results, DEFAULT_KEY, 'wrong');
    expect(scored.sets.A.score).toBe(12);
    expect(scored.sets.B.score).toBe(10);
    expect(scored.sets.C.score).toBe(6);
    expect(scored.sets.D.score).toBe(8);
    expect(scored.sets.E.score).toBe(4);
    expect(scored.total).toBe(40);
    expect(DEFAULT_SETTINGS.confidenceThreshold).toBe(VALIDATED_CONFIDENCE_THRESHOLD);
    expect(DEFAULT_SETTINGS.marginThreshold).toBe(VALIDATED_MARGIN_THRESHOLD);
  });

  it('reaches the labeled 44/60 only after every flagged cell is confirmed', () => {
    const scored = scoreScan(results, DEFAULT_KEY, 'wrong');
    let scan: ScanResult = {
      id: 'validation-scan',
      scanNumber: 1,
      createdAt: 0,
      sets: scored.sets,
      total: scored.total,
      totalPossible: scored.totalPossible,
      durationMs: 0,
      imageHash: '0000000000000000',
      quality: { meanLuminance: 200, blurScore: 300, warnings: [] },
    };
    expect(scan.total).toBe(40);

    for (const set of SET_IDS) {
      results[set].forEach((cell, index) => {
        if (gateFlags(cell, VALIDATED_CONFIDENCE_THRESHOLD, VALIDATED_MARGIN_THRESHOLD)) {
          scan = correctCell(scan, set, index + 1, labels[set][index], DEFAULT_KEY, 'wrong');
        }
      });
    }

    expect(countUnresolved(scan)).toBe(0);
    expect(scan.sets.A.score).toBe(12);
    expect(scan.sets.B.score).toBe(11);
    expect(scan.sets.C.score).toBe(8);
    expect(scan.sets.D.score).toBe(9);
    expect(scan.sets.E.score).toBe(4);
    expect(scan.total).toBe(44);
  });

  it('uses a verified reference corpus only to flag, never to replace a CNN digit', () => {
    let picked: { cell: ImageData; baseline: CellResult } | undefined;
    for (const set of SET_IDS) {
      for (const cell of referenceCells[set]) {
        const baseline = recognizeCell(cell, DEFAULT_SETTINGS, 1);
        if (baseline.state === 'answered' && baseline.digit !== null && baseline.digit !== 7) {
          picked = { cell, baseline };
          break;
        }
      }
      if (picked) break;
    }
    if (!picked) throw new Error('No confidently answered reference cell found');

    const synthetic = new Float32Array(28 * 28);
    for (let y = 6; y <= 21; y++) {
      for (let x = 6; x <= 21; x++) {
        if (x === 6 || x === 21 || y === 6 || y === 21) synthetic[y * 28 + x] = 1;
      }
    }
    const feature = hogFeatures(synthetic);
    const differentDigit = picked.baseline.digit === 4 ? 7 : 4;
    const disagreeingCorpus = {
      features: [feature],
      labels: Uint8Array.from([differentDigit]),
    };
    const flagged = recognizeCell(picked.cell, DEFAULT_SETTINGS, 1, {
      referenceCorpus: disagreeingCorpus,
    });
    expect(flagged.digit).toBe(picked.baseline.digit);
    expect(flagged.state).toBe('uncertain');

    const agreeingCorpus = {
      features: [feature],
      labels: Uint8Array.from([picked.baseline.digit!]),
    };
    const unchanged = recognizeCell(picked.cell, DEFAULT_SETTINGS, 1, {
      referenceCorpus: agreeingCorpus,
    });
    expect(unchanged.digit).toBe(picked.baseline.digit);
    expect(unchanged.state).toBe(picked.baseline.state);
  });
});
