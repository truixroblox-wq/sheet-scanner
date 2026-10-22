import {
  HOG_DIMENSIONS,
  type ReferenceCorpus,
} from './features';
import {
  REFERENCE_CELL_COUNT,
  REFERENCE_HOG_BASE64,
  REFERENCE_LABELS,
} from './reference-corpus';

let cached: ReferenceCorpus | null | undefined;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The verified reference corpus is embedded as a compact byte string and
 * decoded once, lazily, so startup and non-scanning screens stay light.
 */
export function getReferenceCorpus(): ReferenceCorpus | null {
  if (cached !== undefined) return cached;
  if (!REFERENCE_CELL_COUNT || !REFERENCE_HOG_BASE64 || !REFERENCE_LABELS) {
    cached = null;
    return cached;
  }
  if (REFERENCE_LABELS.length !== REFERENCE_CELL_COUNT) {
    cached = null;
    return cached;
  }

  const flat = decodeBase64(REFERENCE_HOG_BASE64);
  if (flat.length !== REFERENCE_CELL_COUNT * HOG_DIMENSIONS) {
    cached = null;
    return cached;
  }

  const features: Uint8Array[] = [];
  for (let i = 0; i < REFERENCE_CELL_COUNT; i++) {
    features.push(flat.subarray(i * HOG_DIMENSIONS, (i + 1) * HOG_DIMENSIONS));
  }
  const labels = new Uint8Array(REFERENCE_CELL_COUNT);
  for (let i = 0; i < REFERENCE_CELL_COUNT; i++) {
    const label = REFERENCE_LABELS.charCodeAt(i) - 48;
    if (label < 1 || label > 8) {
      cached = null;
      return cached;
    }
    labels[i] = label;
  }

  cached = { features, labels };
  return cached;
}

export function referenceCorpusSize(): number {
  return getReferenceCorpus()?.features.length ?? 0;
}
