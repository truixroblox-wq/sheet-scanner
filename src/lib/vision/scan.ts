import { recognizeCell } from '../ocr/recognize';
import { getReferenceCorpus } from '../ocr/reference';
import type {
  AnswerKey,
  AppSettings,
  CellResult,
  ScanProgress,
  ScanResult,
  SetId,
} from '../../types';
import { SET_IDS } from '../../types';
import { markUncertain, scoreScan } from '../scoring';
import { imageDataToDataUrl } from '../image';
import { rectifySheet } from './warp';
import { cropCells, detectGrid } from './grid';

export interface ScanInput {
  /** Any drawable image source at the original resolution. */
  canvas: HTMLCanvasElement;
  imageHash: string;
  scanNumber: number;
  settings: AppSettings;
  key: AnswerKey;
  onProgress?: (progress: ScanProgress) => void;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export async function scanSheet(input: ScanInput): Promise<ScanResult> {
  const started = performance.now();
  const report = (progress: ScanProgress) => input.onProgress?.(progress);

  report({ stage: 'detecting', label: 'Finding and straightening the table', completed: 0, total: 60 });
  await yieldToMain();
  const rectified = await rectifySheet(input.canvas);

  report({ stage: 'aligning', label: 'Aligning the answer grid', completed: 0, total: 60 });
  await yieldToMain();
  const geometry = detectGrid(rectified.image);
  const cellImages = cropCells(rectified.image, geometry);

  report({ stage: 'reading', label: 'Reading handwritten answers', completed: 0, total: 60 });
  await yieldToMain();
  const referenceCorpus = getReferenceCorpus();
  const rawCells = {} as Record<SetId, CellResult[]>;
  let completed = 0;
  for (const set of SET_IDS) {
    const cells: CellResult[] = [];
    for (let index = 0; index < cellImages[set].length; index++) {
      const cellImage = cellImages[set][index];
      cells.push({
        ...recognizeCell(cellImage, input.settings, index + 1, { referenceCorpus }),
        cropUrl: imageDataToDataUrl(cellImage),
      });
      completed++;
    }
    rawCells[set] = cells;
    report({
      stage: 'reading',
      label: `Reading handwritten answers · set ${set}`,
      completed,
      total: 60,
    });
    // Hand control back to the browser between sets so the progress bar paints
    // and the Scan/Capture buttons remain responsive during recognition.
    await yieldToMain();
  }

  report({ stage: 'scoring', label: 'Scoring 60 answers', completed: 60, total: 60 });
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
