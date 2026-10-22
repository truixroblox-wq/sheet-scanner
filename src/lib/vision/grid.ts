import {
  BLOCK_WIDTH,
  CELL_VERTICAL_INSET,
  ROW_LINES,
  STUDENT_CELL_LEFT,
  STUDENT_CELL_RIGHT,
  TABLE_WIDTH,
} from '../config';
import type { SetId } from '../../types';
import { SET_IDS } from '../../types';

/**
 * Lightweight grid alignment for the rectified sheet.
 *
 * The canonical constants describe the reference warp, but real photos are
 * shifted or slightly scaled by the table detector. This module snaps the 13
 * row rules and the five student-answer columns to the printed grid, so the
 * scanner reads the correct boxes without needing a perfect warp.
 */

export interface StudentColumn {
  left: number;
  right: number;
}

export interface GridGeometry {
  rowLines: number[];
  studentColumns: StudentColumn[];
  usedFallback: boolean;
}

function toGray(image: ImageData): Float32Array {
  const { width, height, data } = image;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return gray;
}

function otsu(gray: Float32Array): number {
  const hist = new Array<number>(256).fill(0);
  let total = 0;
  for (let i = 0; i < gray.length; i++) {
    const value = Math.max(0, Math.min(255, Math.round(gray[i])));
    hist[value]++;
    total++;
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    weightBackground += hist[i];
    if (!weightBackground) continue;
    const weightForeground = total - weightBackground;
    if (!weightForeground) break;
    sumBackground += i * hist[i];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

function smooth(values: Float64Array): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const a = values[Math.max(0, i - 1)];
    const b = values[i];
    const c = values[Math.min(values.length - 1, i + 1)];
    out[i] = (a + b * 2 + c) / 4;
  }
  return out;
}

function rowProfile(
  gray: Float32Array,
  w: number,
  h: number,
  threshold: number,
): Float64Array {
  const profile = new Float64Array(h);
  const x0 = Math.round(w * 0.04);
  const x1 = Math.round(w * 0.96);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const base = y * w;
    for (let x = x0; x < x1; x++) if (gray[base + x] < threshold) count++;
    profile[y] = count;
  }
  return smooth(profile);
}

function columnProfile(
  gray: Float32Array,
  w: number,
  y0: number,
  y1: number,
  threshold: number,
): Float64Array {
  const profile = new Float64Array(w);
  for (let y = y0; y < y1; y++) {
    const base = y * w;
    for (let x = 1; x < w - 1; x++) {
      if (
        gray[base + x - 1] < threshold ||
        gray[base + x] < threshold ||
        gray[base + x + 1] < threshold
      ) {
        profile[x]++;
      }
    }
  }
  return smooth(profile);
}

function bestPeak(
  profile: Float64Array,
  expected: number,
  radius: number,
  minValue: number,
): number | null {
  const from = Math.max(1, Math.round(expected - radius));
  const to = Math.min(profile.length - 2, Math.round(expected + radius));
  let best = -1;
  let bestValue = minValue;
  for (let i = from; i <= to; i++) {
    if (profile[i] < bestValue) continue;
    if (profile[i] < profile[i - 1] || profile[i] <= profile[i + 1]) continue;
    best = i;
    bestValue = profile[i];
  }
  if (best < 0) return null;
  // Centre the rule on its local plateau/thickness.
  let weighted = 0;
  let weight = 0;
  for (let i = Math.max(0, best - 3); i <= Math.min(profile.length - 1, best + 3); i++) {
    if (profile[i] < bestValue * 0.55) continue;
    weighted += i * profile[i];
    weight += profile[i];
  }
  return weight > 0 ? Math.round(weighted / weight) : best;
}

interface Peak {
  x: number;
  value: number;
}

function findPeaks(
  profile: Float64Array,
  from: number,
  to: number,
  minValue: number,
): Peak[] {
  const peaks: Peak[] = [];
  for (let x = Math.max(1, from); x <= Math.min(profile.length - 2, to); x++) {
    if (profile[x] < minValue) continue;
    if (profile[x] < profile[x - 1] || profile[x] <= profile[x + 1]) continue;
    const previous = peaks[peaks.length - 1];
    if (previous && x - previous.x <= 6) {
      if (profile[x] > previous.value) {
        previous.x = x;
        previous.value = profile[x];
      }
      continue;
    }
    peaks.push({ x, value: profile[x] });
  }
  return peaks;
}

function snapRows(
  gray: Float32Array,
  w: number,
  h: number,
  threshold: number,
): { lines: number[]; usedFallback: boolean } {
  const profile = rowProfile(gray, w, h, threshold);
  const minValue = w * 0.2;
  const lines = ROW_LINES.map((expected) => {
    const peak = bestPeak(profile, expected, 55, minValue);
    return peak ?? expected;
  });

  let usedFallback = false;
  for (let i = 1; i < lines.length; i++) {
    const spacing = lines[i] - lines[i - 1];
    if (spacing < 65 || spacing > 145) {
      lines[i] = ROW_LINES[i];
      usedFallback = true;
    }
  }
  return { lines, usedFallback };
}

function snapColumns(
  gray: Float32Array,
  w: number,
  y0: number,
  y1: number,
  threshold: number,
): { columns: StudentColumn[]; usedFallback: boolean } {
  const height = Math.max(1, y1 - y0);
  const profile = columnProfile(gray, w, y0, y1, threshold);
  const expectedBlocks = [
    0,
    BLOCK_WIDTH,
    BLOCK_WIDTH * 2,
    BLOCK_WIDTH * 3,
    BLOCK_WIDTH * 4,
    TABLE_WIDTH - 1,
  ];
  const boundaryMin = height * 0.55;
  const blocks = expectedBlocks.map((expected, index) => {
    if (index === 0 || index === expectedBlocks.length - 1) return expected;
    return bestPeak(profile, expected, 70, boundaryMin) ?? expected;
  });
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i] - blocks[i - 1] < 220) blocks[i] = expectedBlocks[i];
  }

  const columns: StudentColumn[] = [];
  let usedFallback = false;
  for (let k = 0; k < SET_IDS.length; k++) {
    const b0 = blocks[k];
    const b1 = blocks[k + 1];
    const bw = b1 - b0;
    const fallback = {
      left: Math.round(k * BLOCK_WIDTH + STUDENT_CELL_LEFT),
      right: Math.round(k * BLOCK_WIDTH + STUDENT_CELL_RIGHT),
    };
    if (bw < 180) {
      columns.push(fallback);
      usedFallback = true;
      continue;
    }

    const peaks = findPeaks(
      profile,
      Math.ceil(b0 + bw * 0.1),
      Math.floor(b1 - bw * 0.1),
      height * 0.35,
    );
    const target = bw * 0.47;
    let best: { a: Peak; b: Peak; score: number } | null = null;
    for (let i = 0; i < peaks.length; i++) {
      for (let j = i + 1; j < peaks.length; j++) {
        const width = peaks[j].x - peaks[i].x;
        if (width < bw * 0.3 || width > bw * 0.62) continue;
        const score =
          peaks[i].value + peaks[j].value - Math.abs(width - target) * 1.5;
        if (!best || score > best.score) best = { a: peaks[i], b: peaks[j], score };
      }
    }

    if (!best) {
      columns.push(fallback);
      usedFallback = true;
    } else {
      const inset = 2;
      const left = best.a.x + inset;
      const right = best.b.x - inset;
      if (right - left < 80) {
        columns.push(fallback);
        usedFallback = true;
      } else {
        columns.push({ left, right });
      }
    }
  }
  return { columns, usedFallback };
}

export function detectGrid(image: ImageData): GridGeometry {
  const gray = toGray(image);
  const threshold = Math.max(45, otsu(gray));
  const rows = snapRows(gray, image.width, image.height, threshold);
  const y0 = rows.lines[0] + 4;
  const y1 = rows.lines[rows.lines.length - 1] - 4;
  const cols = snapColumns(gray, image.width, y0, y1, threshold);
  return {
    rowLines: rows.lines,
    studentColumns: cols.columns,
    usedFallback: rows.usedFallback || cols.usedFallback,
  };
}

/** Crop the 60 student-answer cells using an aligned grid. */
export function cropCells(
  image: ImageData,
  geometry: GridGeometry,
): Record<SetId, ImageData[]> {
  const out = {} as Record<SetId, ImageData[]>;
  for (let s = 0; s < SET_IDS.length; s++) {
    const set = SET_IDS[s];
    const { left, right } = geometry.studentColumns[s];
    const width = right - left;
    const cells: ImageData[] = [];
    for (let r = 0; r < 12; r++) {
      const top = geometry.rowLines[r];
      const bottom = geometry.rowLines[r + 1];
      const rowHeight = bottom - top;
      const y0 = Math.round(top + rowHeight * CELL_VERTICAL_INSET);
      const y1 = Math.round(bottom - rowHeight * CELL_VERTICAL_INSET);
      const height = Math.max(1, y1 - y0);
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const si = ((y0 + y) * image.width + left + x) * 4;
          const di = (y * width + x) * 4;
          data[di] = image.data[si];
          data[di + 1] = image.data[si + 1];
          data[di + 2] = image.data[si + 2];
          data[di + 3] = 255;
        }
      }
      cells.push({ width, height, data } as ImageData);
    }
    out[set] = cells;
  }
  return out;
}
