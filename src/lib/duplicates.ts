import { hammingDistance } from './image';

export interface HashedSheet {
  imageHash: string;
}

/**
 * Duplicate protection is scoped to the sheets in one batch/session. Starting a
 * new individual scan clears that session, so intentionally rescanning the same
 * sheet through "Scan another sheet" is never blocked.
 */
export function findDuplicateSheet<T extends HashedSheet>(
  sheets: readonly T[],
  hash: string,
  guardEnabled: boolean,
): T | undefined {
  if (!guardEnabled) return undefined;
  return sheets.find((sheet) => hammingDistance(sheet.imageHash, hash) <= 5);
}
