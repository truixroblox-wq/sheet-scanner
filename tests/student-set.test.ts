import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SET_IDS, type SetId } from '../src/types';

const root = path.resolve('samples/student-set-1');
const labelsPath = path.join(root, 'labels.json');
const manifestPath = path.join(root, 'manifest.json');
const hasStudentSet = fs.existsSync(labelsPath) && fs.existsSync(manifestPath);

interface LabelsFile {
  verifiedSheets: number;
  verifiedCells: number;
  excluded: Record<string, string>;
  sheets: Record<
    string,
    {
      verified: boolean;
      labels: Record<SetId, Array<number | null>>;
    }
  >;
}
interface ManifestFile {
  sheets: Array<{
    id: string;
    sha256: string;
    tableDetected: boolean;
    usable: boolean;
  }>;
}

const suite = hasStudentSet ? describe : describe.skip;
suite('imported student set', () => {
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8')) as LabelsFile;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestFile;

  it('keeps 64 unique imported images with detected tables', () => {
    expect(manifest.sheets).toHaveLength(64);
    expect(new Set(manifest.sheets.map((sheet) => sheet.sha256)).size).toBe(64);
    expect(manifest.sheets.every((sheet) => sheet.tableDetected)).toBe(true);
    expect(manifest.sheets.every((sheet) => sheet.usable)).toBe(true);
  });

  it('excludes the printed answer key from handwritten labels', () => {
    expect(labels.excluded.S013).toMatch(/answer key/i);
    expect(labels.sheets.S013).toBeUndefined();
  });

  it('contains only hand-verified 1-8 digits plus one obstructed unknown', () => {
    const ids = Object.keys(labels.sheets);
    expect(ids).toHaveLength(8);
    expect(ids).toEqual(['S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007', 'S008']);
    expect(labels.verifiedSheets).toBe(8);
    expect(labels.verifiedCells).toBe(479);

    let labelled = 0;
    let unknown = 0;
    for (const sheet of Object.values(labels.sheets)) {
      expect(sheet.verified).toBe(true);
      for (const set of SET_IDS) {
        expect(sheet.labels[set]).toHaveLength(12);
        for (const digit of sheet.labels[set]) {
          if (digit == null) {
            unknown++;
            continue;
          }
          expect(Number.isInteger(digit)).toBe(true);
          expect(digit).toBeGreaterThanOrEqual(1);
          expect(digit).toBeLessThanOrEqual(8);
          labelled++;
        }
      }
    }
    expect(labelled).toBe(479);
    expect(unknown).toBe(1);
  });

  it('does not transcribe source filenames or a student-name field', () => {
    const text = fs.readFileSync(labelsPath, 'utf8');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpe?g/i);
    expect(text.toLowerCase()).not.toContain('studentname');
    expect(text.toLowerCase()).not.toContain('"name"');
  });
});
