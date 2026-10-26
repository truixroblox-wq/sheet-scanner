import type { ScanResult } from '../types';
import { countUnresolved } from './scoring';

/**
 * Batch results are always presented and reviewed by the numeric scan index.
 * The stored array is newest-first (so a fresh scan is easy to add), so every
 * consumer that presents a list must sort a copy instead of relying on storage
 * order. String sorting would put #10 before #2.
 */
export function sortScansByNumber(scans: ScanResult[]): ScanResult[] {
  return [...scans].sort(
    (a, b) => a.scanNumber - b.scanNumber || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

/**
 * The next sheet that still needs confirmation, in ascending scan order.
 *
 * Sheets at or before the current index are skipped first. If every later
 * sheet is already resolved, review wraps to the earliest unresolved sheet so
 * a sheet reopened out of order cannot strand an earlier one. The current sheet
 * is only returned when it is the sole unresolved sheet (which should not
 * happen when this is called after it was resolved).
 */
export function nextScanNeedingReview(
  scans: ScanResult[],
  currentScanNumber: number,
): ScanResult | null {
  const ordered = sortScansByNumber(scans);
  const later = ordered.find(
    (scan) => scan.scanNumber > currentScanNumber && countUnresolved(scan) > 0,
  );
  if (later) return later;
  return ordered.find((scan) => countUnresolved(scan) > 0) ?? null;
}

/** True once every sheet in the current batch has zero unresolved answers. */
export function allScansReviewed(scans: ScanResult[]): boolean {
  return scans.length > 0 && scans.every((scan) => countUnresolved(scan) === 0);
}
