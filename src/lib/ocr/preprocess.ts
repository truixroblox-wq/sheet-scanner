/**
 * Dependency-free cell preprocessing for handwritten digits.
 *
 * The sheet is printed with a grey grid and may be annotated in red. We only
 * ever read the student answer sub-column, but this module is defensive:
 * red ink is removed, the local paper background is subtracted, long printed
 * rules are deleted, and connected strokes are grouped before 28x28
 * MNIST-style normalisation.
 */

export interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  area: number;
}

export interface Component extends BBox {
  id: number;
  sumX: number;
  sumY: number;
}

export interface CellExtraction {
  width: number;
  height: number;
  ink: Uint8Array;
  inkFloat: Float32Array;
  /** Fraction of pixels that passed the ink threshold after rule removal. */
  inkRatio: number;
  /** Fraction of pixels far darker than the local background (large blobs/obstructions). */
  darkRatio: number;
  /** Fraction of pixels classified as red annotation. */
  redRatio: number;
  best: BBox | null;
  groups: BBox[];
  components: Component[];
  threshold: number;
  meanBackground: number;
}

export interface ExtractionOptions {
  /**
   * `legacy` keeps the original nearest-largest-component grouping. `merged`
   * joins vertically split strokes (pen lifts in 1, 4, 6, 7) before choosing
   * the digit box. The merged mode is opt-in so both can be measured.
   */
  grouping?: 'legacy' | 'merged';
}

function boxBlur(gray: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += gray[row + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / n;
      const add = gray[row + Math.min(w - 1, x + radius + 1)];
      const sub = gray[row + Math.max(0, x - radius)];
      sum += add - sub;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      const add = tmp[Math.min(h - 1, y + radius + 1) * w + x];
      const sub = tmp[Math.max(0, y - radius) * w + x];
      sum += add - sub;
    }
  }
  return out;
}

export function extractCell(cell: ImageData, options: ExtractionOptions = {}): CellExtraction {
  const { width: w, height: h, data } = cell;
  const gray = new Float32Array(w * h);
  const ink = new Uint8Array(w * h);
  const red = new Uint8Array(w * h);

  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    red[i] = r > 60 && r > g + 10 && r > b + 6 && max - min > 12 ? 1 : 0;
  }

  const radius = Math.max(6, Math.round(Math.min(w, h) * 0.18));
  const bg = boxBlur(gray, w, h, radius);
  const contrast = new Float32Array(w * h);
  let bgSum = 0;
  let redCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (red[i]) {
      gray[i] = bg[i];
      redCount++;
    }
    contrast[i] = bg[i] - gray[i];
    bgSum += bg[i];
  }

  const meanBackground = bgSum / (w * h);
  const threshold = Math.max(7, meanBackground * 0.05);
  const darkThreshold = meanBackground - Math.max(20, meanBackground * 0.18);
  let darkCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (!red[i] && gray[i] < darkThreshold) darkCount++;
  }
  const inkFloat = new Float32Array(w * h);
  const inkGain = Math.max(18, meanBackground * 0.22);
  for (let i = 0; i < w * h; i++) {
    const on = !red[i] && contrast[i] > threshold;
    ink[i] = on ? 1 : 0;
    inkFloat[i] = red[i] ? 0 : Math.max(0, Math.min(1, contrast[i] / inkGain));
  }

  // Remove long printed rules before grouping handwriting strokes.
  const killRow = new Uint8Array(h);
  const killCol = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) count += ink[base + x];
    if (count > w * 0.6) killRow[y] = 1;
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < h; y++) count += ink[y * w + x];
    if (count > h * 0.85) killCol[x] = 1;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (killRow[y] || killCol[x] || x < 1 || y < 1 || x >= w - 1 || y >= h - 1) {
        const i = y * w + x;
        ink[i] = 0;
        inkFloat[i] = 0;
      }
    }
  }
  let inkCount = 0;
  for (let i = 0; i < w * h; i++) if (ink[i]) inkCount++;

  // 8-connected components.
  const labels = new Int32Array(w * h).fill(-1);
  const components: Component[] = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!ink[start] || labels[start] !== -1) continue;
    const id = components.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let area = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx / w) | 0;
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (ink[ni] && labels[ni] === -1) {
            labels[ni] = id;
            stack[sp++] = ni;
          }
        }
      }
    }
    components.push({ id, area, minX, maxX, minY, maxY, sumX: sumX / area, sumY: sumY / area });
  }

  const digitComps = components.filter((c) => {
    const cw = c.maxX - c.minX + 1;
    const ch = c.maxY - c.minY + 1;
    if (c.area < 4) return false;
    if (cw > w * 0.8 && ch < h * 0.22) return false;
    if (ch > h * 0.92 && cw < w * 0.08) return false;
    if (cw > w * 0.9 && ch < h * 0.15) return false;
    if (cw > w * 0.8 && ch <= Math.max(3, h * 0.08)) return false;
    if (ch > h * 0.8 && cw <= Math.max(3, w * 0.05)) return false;
    if (ch <= 3 && cw > w * 0.15) return false;
    if (cw <= 2 && ch > h * 0.15) return false;
    if (cw < w * 0.1 && ch > h * 0.5 && (c.minX < w * 0.12 || c.maxX > w * 0.88)) return false;
    if (c.minY < h * 0.2 && cw > w * 0.65 && ch < h * 0.3) return false;
    if (c.maxY > h * 0.8 && cw > w * 0.65 && ch < h * 0.3) return false;
    return true;
  });

  // Group strokes into candidate digits. The legacy path starts at the largest
  // compact component; the merged path also joins vertically split strokes.
  const groups =
    options.grouping === 'merged'
      ? groupMergedComponents(digitComps, w, h)
      : groupLegacyComponents(digitComps, w, h);

  return {
    width: w,
    height: h,
    ink,
    inkFloat,
    inkRatio: inkCount / (w * h),
    darkRatio: darkCount / (w * h),
    redRatio: redCount / (w * h),
    best: groups[0] ?? null,
    groups,
    components,
    threshold,
    meanBackground,
  };
}

function gaps(a: BBox, b: BBox): { x: number; y: number; overlapX: number; overlapY: number } {
  return {
    x: Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX)),
    y: Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY)),
    overlapX: Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) + 1),
    overlapY: Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1),
  };
}

function mergeGroup(comps: Component[], w: number, h: number): BBox {
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  let area = 0;
  for (const c of comps) {
    minX = Math.min(minX, c.minX);
    maxX = Math.max(maxX, c.maxX);
    minY = Math.min(minY, c.minY);
    maxY = Math.max(maxY, c.maxY);
    area += c.area;
  }
  return { minX, maxX, minY, maxY, area };
}

function groupLegacyComponents(comps: Component[], w: number, h: number): BBox[] {
  const groups: BBox[] = [];
  const used = new Set<number>();
  const ordered = [...comps].sort((a, b) => b.area - a.area);
  for (const c of ordered) {
    if (used.has(c.id)) continue;
    const members = [c];
    used.add(c.id);
    const cx = c.sumX;
    const cy = c.sumY;
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of ordered) {
        if (used.has(d.id)) continue;
        if (Math.abs(d.sumX - cx) > w * 0.22 || Math.abs(d.sumY - cy) > h * 0.32) continue;
        const current = mergeGroup(members, w, h);
        const gap = gaps(current, d);
        const mergedW = Math.max(current.maxX, d.maxX) - Math.min(current.minX, d.minX) + 1;
        const mergedH = Math.max(current.maxY, d.maxY) - Math.min(current.minY, d.minY) + 1;
        if (mergedW > w * 0.6 || mergedH > h * 0.92) continue;
        if (gap.x <= Math.max(8, w * 0.18) && gap.y <= Math.max(6, h * 0.4)) {
          members.push(d);
          used.add(d.id);
          grew = true;
        }
      }
    }
    groups.push(mergeGroup(members, w, h));
  }
  groups.sort((a, b) => b.area - a.area);
  return groups;
}

/**
 * Join pen-lift fragments before picking the digit box.
 *
 * A handwritten 1, 4, 6 or 7 is often written in two or three strokes. The
 * legacy centroid test rejects a lower stem when it is far from the largest
 * fragment, which turns a 6 into its bottom loop (read as 7/0) and a 1 into a
 * hook (read as 7). This grouping uses bounding-box overlap and gap instead of
 * centroid distance, then scores the resulting boxes for plausibility rather
 * than choosing the biggest blob unconditionally.
 */
function groupMergedComponents(comps: Component[], w: number, h: number): BBox[] {
  if (!comps.length) return [];
  const parent = comps.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const maxGapX = Math.max(8, w * 0.1);
  const maxGapY = Math.max(8, h * 0.12);
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const a = comps[i];
      const b = comps[j];
      const gap = gaps(a, b);
      const mergedW = Math.max(a.maxX, b.maxX) - Math.min(a.minX, b.minX) + 1;
      const mergedH = Math.max(a.maxY, b.maxY) - Math.min(a.minY, b.minY) + 1;
      if (mergedW > w * 0.68 || mergedH > h * 0.94) continue;
      const close = gap.x <= maxGapX && gap.y <= maxGapY;
      const verticalSplit = gap.overlapX >= Math.min(3, w * 0.03) && gap.y <= h * 0.34 && gap.x <= w * 0.12;
      const horizontalSplit = gap.overlapY >= Math.min(3, h * 0.04) && gap.x <= w * 0.14 && gap.y <= h * 0.14;
      if (close || verticalSplit || horizontalSplit) union(i, j);
    }
  }

  const buckets = new Map<number, Component[]>();
  comps.forEach((component, index) => {
    const root = find(index);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(component);
    else buckets.set(root, [component]);
  });

  const groupList = [...buckets.values()].map((members) => mergeGroup(members, w, h));
  const scored = groupList.map((group) => {
    const cw = group.maxX - group.minX + 1;
    const ch = group.maxY - group.minY + 1;
    const cx = (group.minX + group.maxX) / 2;
    const cy = (group.minY + group.maxY) / 2;
    const centerDistance = Math.hypot((cx - w / 2) / (w / 2), (cy - h / 2) / (h / 2));
    const aspect = cw / ch;
    let score = group.area;
    if (ch < h * 0.28) score *= 0.35;
    if (ch > h * 0.94) score *= 0.5;
    if (cw < w * 0.06) score *= 0.35;
    if (cw > w * 0.65) score *= 0.55;
    if (aspect > 1.4 || aspect < 0.14) score *= 0.55;
    score *= 1 - Math.min(0.4, centerDistance * 0.25);
    if (
      group.minX <= 1 ||
      group.maxX >= w - 2 ||
      group.minY <= 1 ||
      group.maxY >= h - 2
    ) {
      score *= 0.72;
    }
    return { group, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.group;
  const rest = scored.slice(1).map((item) => item.group);
  rest.sort((a, b) => b.area - a.area);
  return best ? [best, ...rest] : [];
}

/** Scale the selected ink group to 20x20 and place it by centre of mass in 28x28. */
export function normalizeCell(extraction: CellExtraction, bbox: BBox, outSize = 28): Float32Array {
  const { inkFloat, width: w } = extraction;
  const { minX, maxX, minY, maxY } = bbox;
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const scale = 20 / Math.max(cw, ch);
  const dw = Math.max(1, Math.round(cw * scale));
  const dh = Math.max(1, Math.round(ch * scale));
  const small = new Float32Array(dw * dh);

  for (let y = 0; y < dh; y++) {
    const sy = minY + (y + 0.5) / scale - 0.5;
    for (let x = 0; x < dw; x++) {
      const sx = minX + (x + 0.5) / scale - 0.5;
      const x0 = Math.max(minX, Math.min(maxX, Math.floor(sx)));
      const x1 = Math.max(minX, Math.min(maxX, x0 + 1));
      const y0 = Math.max(minY, Math.min(maxY, Math.floor(sy)));
      const y1 = Math.max(minY, Math.min(maxY, y0 + 1));
      const fx = sx - x0;
      const fy = sy - y0;
      const v =
        (inkFloat[y0 * w + x0] * (1 - fx) + inkFloat[y0 * w + x1] * fx) * (1 - fy) +
        (inkFloat[y1 * w + x0] * (1 - fx) + inkFloat[y1 * w + x1] * fx) * fy;
      small[y * dw + x] = Math.max(0, Math.min(1, v));
    }
  }

  let mass = 0;
  let mx = 0;
  let my = 0;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const v = small[y * dw + x];
      mass += v;
      mx += x * v;
      my += y * v;
    }
  }
  mx = mass ? mx / mass : dw / 2;
  my = mass ? my / mass : dh / 2;
  const ox = Math.round(14 - mx);
  const oy = Math.round(14 - my);
  const out = new Float32Array(outSize * outSize);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const tx = x + ox;
      const ty = y + oy;
      if (tx >= 0 && tx < outSize && ty >= 0 && ty < outSize) {
        out[ty * outSize + tx] += small[y * dw + x];
      }
    }
  }
  return out;
}
