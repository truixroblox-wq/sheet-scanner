import { recognizeCell } from '../ocr/recognize';
import type { AppSettings, ScanResult, SetId } from '../../types';
import { SET_IDS } from '../../types';
import { markUncertain, scoreScan } from '../scoring';
import type { AnswerKey } from '../../types';
import { rectifySheet } from './warp';
import { cropCells, detectGrid } from './grid';

export interface ScanInput {
  /** Any drawable image source at the original resolution. */
  canvas: HTMLCanvasElement;
  imageHash: string;
  scanNumber: number;
  settings: AppSettings;
  key: AnswerKey;
}

export async function scanSheet(input: ScanInput): Promise<ScanResult> {
  const started = performance.now();
  const rectified = await rectifySheet(input.canvas);
  const ctx = rectified.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not read the rectified sheet.');
  const sheetImage = ctx.getImageData(0, 0, rectified.canvas.width, rectified.canvas.height);
  const geometry = detectGrid(sheetImage);
  const cellImages = cropCells(sheetImage, geometry);

  const rawCells = {} as Record<SetId, ReturnType<typeof recognizeCell>[]>;
  for (const set of SET_IDS) {
    rawCells[set] = cellImages[set].map((cell, index) =>
      recognizeCell(cell, input.settings, index + 1),
    );
  }

  const scored = scoreScan(rawCells, input.key, input.settings.blankPolicy);
  const sets = markUncertain(
    scored.sets,
    input.settings.confidenceThreshold,
    input.settings.marginThreshold,
  );
  const total = SET_IDS.reduce((sum, set) => sum + sets[set].score, 0);
  const totalPossible = SET_IDS.reduce((sum, set) => sum + sets[set].denominator, 0);
  const answered = SET_IDS.reduce((sum, set) => sum + sets[set].answered, 0);
  const nonAnswers = SET_IDS.reduce((sum, set) => sum + sets[set].blanks + sets[set].obstructed, 0);
  const warnings = [...rectified.quality.warnings];
  if (answered <= 3 || nonAnswers >= 36) {
    warnings.push(
      answered <= 3
        ? 'Almost no student answers were detected. Check the image or confirm this is a student sheet, not the teacher key.'
        : 'Most answer cells were blank or obstructed. Check that this is a complete student sheet, not the teacher key.',
    );
  }

  return {
    id: crypto.randomUUID(),
    scanNumber: input.scanNumber,
    createdAt: Date.now(),
    sets,
    total,
    totalPossible,
    durationMs: performance.now() - started,
    imageHash: input.imageHash,
    quality: { ...rectified.quality, warnings },
  };
}
