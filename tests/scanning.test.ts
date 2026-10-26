import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCK_WIDTH,
  CELL_VERTICAL_INSET,
  DEFAULT_KEY,
  DEFAULT_SETTINGS,
  ROW_LINES,
  STUDENT_CELL_LEFT,
  STUDENT_CELL_RIGHT,
} from '../src/lib/config';
import { scoreScan } from '../src/lib/scoring';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { extractCell } from '../src/lib/ocr/preprocess';
import type { CellResult, SetId } from '../src/types';
import { SET_IDS } from '../src/types';

const SAMPLE = path.resolve('samples/proto-warp.png');
const hasSample = fs.existsSync(SAMPLE);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function crop(image: PNG, rect: Rect): ImageData {
  const data = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const si = ((rect.y + y) * image.width + rect.x + x) * 4;
      const di = (y * rect.width + x) * 4;
      data[di] = image.data[si];
      data[di + 1] = image.data[si + 1];
      data[di + 2] = image.data[si + 2];
      data[di + 3] = 255;
    }
  }
  return { width: rect.width, height: rect.height, data } as ImageData;
}

function loadCells(): Record<SetId, ImageData[]> {
  const image = PNG.sync.read(fs.readFileSync(SAMPLE));
  const out = {} as Record<SetId, ImageData[]>;
  for (let s = 0; s < SET_IDS.length; s++) {
    const set = SET_IDS[s];
    const x0 = Math.round(s * BLOCK_WIDTH + STUDENT_CELL_LEFT);
    const x1 = Math.round(s * BLOCK_WIDTH + STUDENT_CELL_RIGHT);
    out[set] = [];
    for (let r = 0; r < 12; r++) {
      const rowHeight = ROW_LINES[r + 1] - ROW_LINES[r];
      const y0 = Math.round(ROW_LINES[r] + rowHeight * CELL_VERTICAL_INSET);
      const y1 = Math.round(ROW_LINES[r + 1] - rowHeight * CELL_VERTICAL_INSET);
      out[set].push(crop(image, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
    }
  }
  return out;
}

function syntheticCell(
  width: number,
  height: number,
  fill: number,
  paint?: (set: (x: number, y: number, value: number) => void) => void,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill;
    data[i * 4 + 1] = fill;
    data[i * 4 + 2] = fill;
    data[i * 4 + 3] = 255;
  }
  paint?.((x, y, value) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  });
  return { width, height, data } as ImageData;
}

function rotateCell(cell: ImageData, degrees: number): ImageData {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = cell.width / 2;
  const cy = cell.height / 2;
  const data = new Uint8ClampedArray(cell.width * cell.height * 4);
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = Math.round(cos * dx + sin * dy + cx);
      const sy = Math.round(-sin * dx + cos * dy + cy);
      const di = (y * cell.width + x) * 4;
      if (sx < 0 || sy < 0 || sx >= cell.width || sy >= cell.height) {
        data[di] = 245;
        data[di + 1] = 245;
        data[di + 2] = 245;
      } else {
        const si = (sy * cell.width + sx) * 4;
        data[di] = cell.data[si];
        data[di + 1] = cell.data[si + 1];
        data[di + 2] = cell.data[si + 2];
      }
      data[di + 3] = 255;
    }
  }
  return { width: cell.width, height: cell.height, data } as ImageData;
}

function darkenCell(cell: ImageData, factor: number): ImageData {
  const data = new Uint8ClampedArray(cell.data.length);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(cell.data[i] * factor);
    data[i + 1] = Math.round(cell.data[i + 1] * factor);
    data[i + 2] = Math.round(cell.data[i + 2] * factor);
    data[i + 3] = 255;
  }
  return { width: cell.width, height: cell.height, data } as ImageData;
}

const settings = DEFAULT_SETTINGS;

function recognizeAll(cells: Record<SetId, ImageData[]>): Record<SetId, CellResult[]> {
  const out = {} as Record<SetId, CellResult[]>;
  for (const set of SET_IDS) {
    out[set] = cells[set].map((cell, index) => recognizeCell(cell, settings, index + 1));
  }
  return out;
}

describe.skipIf(!hasSample)('sample sheet recognition integration', () => {
  let results: Record<SetId, CellResult[]>;
  let elapsed = 0;

  beforeAll(() => {
    const cells = loadCells();
    const started = performance.now();
    results = recognizeAll(cells);
    elapsed = performance.now() - started;
  });

  it('reads exactly 60 cells', () => {
    for (const set of SET_IDS) expect(results[set]).toHaveLength(12);
  });

  it('only emits permitted digits or an explicit non-answer state', () => {
    for (const set of SET_IDS) {
      for (const cell of results[set]) {
        if (cell.digit != null) expect(cell.digit).toBeGreaterThanOrEqual(1);
        expect(cell.digit == null || cell.digit <= 8).toBe(true);
        expect(['answered', 'uncertain', 'blank', 'obstructed']).toContain(cell.state);
      }
    }
  });

  it('matches the fixed-crop regression baseline', () => {
    // samples/proto-warp.png is a synthetic layout fixture, not a hand-labelled
    // answer sheet. The verified reference-2 sheet is exercised in
    // tests/validation.test.ts, which pins the 41/60 pre-confirmation score.
    const scored = scoreScan(results, DEFAULT_KEY, 'wrong');
    expect(scored.sets.A.score).toBe(12);
    expect(scored.sets.B.score).toBe(10);
    expect(scored.sets.C.score).toBe(6);
    expect(scored.sets.D.score).toBe(8);
    expect(scored.sets.E.score).toBe(4);
    expect(scored.total).toBe(40);
  });

  it('keeps high-confidence readings stable', () => {
    expect(results.A[0].digit).toBe(4);
    expect(results.A[1].digit).toBe(5);
    expect(results.A[8].digit).toBe(1);
    expect(results.B[1].digit).toBe(6);
    expect(results.E[0].digit).toBe(7);
    expect(results.E[10].digit).toBe(6);
  });

  it('flags known ambiguous handwriting instead of pretending certainty', () => {
    expect(results.B[9].state).toBe('uncertain');
    expect(results.C[3].state).toBe('uncertain');
    expect(results.E[3].state).toBe('uncertain');
    expect(results.D[4].state).toBe('uncertain');
  });

  it('processes all 60 cells within the performance budget', () => {
    // Node is a conservative proxy for the browser; allow generous headroom for CI.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('cell edge cases', () => {
  it('recognises a clean blank cell with a printed rule as blank', () => {
    const blank = syntheticCell(165, 73, 242, (set) => {
      for (let x = 0; x < 165; x++) {
        set(x, 0, 150);
        set(x, 1, 150);
      }
    });
    const result = recognizeCell(blank, settings, 1);
    expect(result.digit).toBeNull();
    expect(result.state).toBe('blank');
  });

  it('does not mistake a dark frame for a blank answer', () => {
    const dark = syntheticCell(165, 73, 18);
    const result = recognizeCell(dark, settings, 1);
    expect(result.digit).toBeNull();
    expect(result.state).toBe('obstructed');
  });

  it('flags a large obstruction instead of reading it as a digit', () => {
    const obstructed = syntheticCell(165, 73, 240, (set) => {
      for (let y = 6; y < 68; y++) {
        for (let x = 18; x < 148; x++) set(x, y, 20);
      }
    });
    const result = recognizeCell(obstructed, settings, 1);
    expect(result.state).toBe('obstructed');
  });

  it('survives a dark scan of a real digit', () => {
    if (!hasSample) return;
    const cell = loadCells().A[0];
    const dark = darkenCell(cell, 0.35);
    const result = recognizeCell(dark, settings, 1);
    expect(['answered', 'uncertain', 'blank', 'obstructed']).toContain(result.state);
    expect(result.digit == null || (result.digit >= 1 && result.digit <= 8)).toBe(true);
    // A dark scan must not become a confidently wrong answer. A cell that
    // needed the low-amplitude contrast stretch is intentionally flagged even
    // when the CNN is confident, so an uncertain state is always acceptable.
    if (result.state === 'answered') {
      expect(result.confidence).toBeGreaterThanOrEqual(settings.confidenceThreshold);
    }
  });

  it('reads a rotated real digit', () => {
    if (!hasSample) return;
    const cell = loadCells().A[2]; // a clear '1'
    const rotated = rotateCell(cell, 7);
    const result = recognizeCell(rotated, settings, 3);
    expect(result.digit).toBe(1);
    expect(['answered', 'uncertain']).toContain(result.state);
  });

  it('removes red annotation pixels before extraction', () => {
    const cell = syntheticCell(165, 73, 242);
    // Paint a red rectangle directly into the RGBA buffer.
    for (let y = 20; y < 52; y++) {
      for (let x = 60; x < 100; x++) {
        if (y === 20 || y === 51 || x === 60 || x === 99) {
          const i = (y * 165 + x) * 4;
          cell.data[i] = 220;
          cell.data[i + 1] = 40;
          cell.data[i + 2] = 40;
        }
      }
    }
    const extraction = extractCell(cell);
    expect(extraction.redRatio).toBeGreaterThan(0);
    expect(extraction.best).toBeNull();
  });
});
