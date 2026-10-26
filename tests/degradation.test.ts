import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/lib/config';
import { cropCells, detectGrid } from '../src/lib/vision/grid';
import { recognizeCell } from '../src/lib/ocr/recognize';
import { SET_IDS, type SetId } from '../src/types';
import { degradations, type Degradation } from './helpers/degradations';

const root = path.resolve('samples/student-set-1');
const tablePath = path.join(root, 'review-tables', 'S005.jpg');
const labelsPath = path.join(root, 'labels.json');
const hasSample = fs.existsSync(tablePath) && fs.existsSync(labelsPath);

interface LabelsFile {
  sheets: Record<
    string,
    {
      verified: boolean;
      labels: Record<SetId, Array<number | null>>;
    }
  >;
}

interface LabeledCell {
  label: number;
  cell: ImageData;
}

function readJpeg(file: string): ImageData {
  const decoded = jpeg.decode(fs.readFileSync(file), {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
  });
  return {
    data: new Uint8ClampedArray(decoded.data),
    width: decoded.width,
    height: decoded.height,
  } as ImageData;
}

function accuracy(cells: LabeledCell[], transform: Degradation, thresholdFloor?: number): number {
  let correct = 0;
  for (const item of cells) {
    const result = recognizeCell(
      transform.apply(item.cell),
      DEFAULT_SETTINGS,
      1,
      thresholdFloor == null
        ? undefined
        : { extraction: { thresholdFloor, thresholdFraction: 0 } },
    );
    if (result.digit === item.label) correct++;
  }
  return correct;
}

const suite = hasSample ? describe : describe.skip;
suite('degraded labeled-cell regression', () => {
  const cells: LabeledCell[] = [];

  beforeAll(() => {
    const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8')) as LabelsFile;
    const sheet = labels.sheets.S005;
    expect(sheet?.verified).toBe(true);
    const table = readJpeg(tablePath);
    const crops = cropCells(table, detectGrid(table));
    for (const set of SET_IDS) {
      for (let row = 0; row < 12; row++) {
        const label = sheet.labels[set][row];
        if (label == null) continue;
        cells.push({ label, cell: crops[set][row] });
      }
    }
    expect(cells).toHaveLength(60);
  });

  it('keeps readable digits through representative capture degradations', () => {
    const minimums: Record<string, number> = {
      'rotated +7°': 53,
      'rotated -7°': 48,
      'sheared 8%': 55,
      'faint pencil': 53,
      'blurred 3×3': 54,
      'low contrast': 53,
    };
    const results = degradations.map((transform) => ({
      name: transform.name,
      correct: accuracy(cells, transform),
    }));
    for (const result of results) {
      expect(result.correct, `${result.name}: ${result.correct}/${cells.length}`).toBeGreaterThanOrEqual(
        minimums[result.name],
      );
    }
  });

  it('improves faint and low-contrast cells over the fixed legacy threshold', () => {
    const faint = degradations.find((item) => item.name === 'faint pencil');
    const low = degradations.find((item) => item.name === 'low contrast');
    expect(faint).toBeDefined();
    expect(low).toBeDefined();

    const faintAdaptive = accuracy(cells, faint!);
    const faintLegacy = accuracy(cells, faint!, 7);
    const lowAdaptive = accuracy(cells, low!);
    const lowLegacy = accuracy(cells, low!, 7);

    expect(faintAdaptive).toBeGreaterThanOrEqual(faintLegacy + 10);
    expect(lowAdaptive).toBeGreaterThanOrEqual(lowLegacy + 5);
  });
});
