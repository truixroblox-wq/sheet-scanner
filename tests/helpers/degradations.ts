/**
 * Deterministic cell-level degradations used by the regression tests. These
 * simulate residual rotation/skew and poor capture conditions without changing
 * the labeled source images.
 */

export interface Degradation {
  name: string;
  apply: (cell: ImageData) => ImageData;
}

function clone(cell: ImageData): ImageData {
  return {
    data: new Uint8ClampedArray(cell.data),
    width: cell.width,
    height: cell.height,
  } as ImageData;
}

function cornerBackground(cell: ImageData): [number, number, number] {
  const { width, height, data } = cell;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const [x, y] of [
    [1, 1],
    [width - 2, 1],
    [1, height - 2],
    [width - 2, height - 2],
  ]) {
    const i = (y * width + x) * 4;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  return [r / n, g / n, b / n];
}

function mapChannels(
  cell: ImageData,
  fn: (value: number, x: number, y: number) => number,
): ImageData {
  const out = clone(cell);
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const i = (y * cell.width + x) * 4;
      out.data[i] = fn(cell.data[i], x, y);
      out.data[i + 1] = fn(cell.data[i + 1], x, y);
      out.data[i + 2] = fn(cell.data[i + 2], x, y);
      out.data[i + 3] = 255;
    }
  }
  return out;
}

export function rotate(cell: ImageData, degrees: number): ImageData {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = (cell.width - 1) / 2;
  const cy = (cell.height - 1) / 2;
  const [br, bg, bb] = cornerBackground(cell);
  const out = {
    data: new Uint8ClampedArray(cell.width * cell.height * 4),
    width: cell.width,
    height: cell.height,
  } as ImageData;

  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      const di = (y * cell.width + x) * 4;
      if (sx < 0 || sy < 0 || sx > cell.width - 1 || sy > cell.height - 1) {
        out.data[di] = br;
        out.data[di + 1] = bg;
        out.data[di + 2] = bb;
      } else {
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(cell.width - 1, x0 + 1);
        const y1 = Math.min(cell.height - 1, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        const i00 = (y0 * cell.width + x0) * 4;
        const i10 = (y0 * cell.width + x1) * 4;
        const i01 = (y1 * cell.width + x0) * 4;
        const i11 = (y1 * cell.width + x1) * 4;
        for (let c = 0; c < 3; c++) {
          out.data[di + c] =
            (cell.data[i00 + c] * (1 - fx) + cell.data[i10 + c] * fx) * (1 - fy) +
            (cell.data[i01 + c] * (1 - fx) + cell.data[i11 + c] * fx) * fy;
        }
      }
      out.data[di + 3] = 255;
    }
  }
  return out;
}

export function shear(cell: ImageData, amount: number): ImageData {
  const [br, bg, bb] = cornerBackground(cell);
  const out = {
    data: new Uint8ClampedArray(cell.width * cell.height * 4),
    width: cell.width,
    height: cell.height,
  } as ImageData;
  for (let y = 0; y < cell.height; y++) {
    const shift = amount * (y - cell.height / 2);
    for (let x = 0; x < cell.width; x++) {
      const sx = x - shift;
      const di = (y * cell.width + x) * 4;
      if (sx < 0 || sx > cell.width - 1) {
        out.data[di] = br;
        out.data[di + 1] = bg;
        out.data[di + 2] = bb;
      } else {
        const x0 = Math.floor(sx);
        const x1 = Math.min(cell.width - 1, x0 + 1);
        const fx = sx - x0;
        for (let c = 0; c < 3; c++) {
          const si0 = (y * cell.width + x0) * 4 + c;
          const si1 = (y * cell.width + x1) * 4 + c;
          out.data[di + c] = cell.data[si0] * (1 - fx) + cell.data[si1] * fx;
        }
      }
      out.data[di + 3] = 255;
    }
  }
  return out;
}

export function blur(cell: ImageData): ImageData {
  const out = clone(cell);
  const radius = 1;
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const di = (y * cell.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let count = 0;
        for (
          let yy = Math.max(0, y - radius);
          yy <= Math.min(cell.height - 1, y + radius);
          yy++
        ) {
          for (
            let xx = Math.max(0, x - radius);
            xx <= Math.min(cell.width - 1, x + radius);
            xx++
          ) {
            sum += cell.data[(yy * cell.width + xx) * 4 + c];
            count++;
          }
        }
        out.data[di + c] = sum / count;
      }
      out.data[di + 3] = 255;
    }
  }
  return out;
}

export function faint(cell: ImageData): ImageData {
  const [background] = cornerBackground(cell);
  const base = background * 0.92;
  return mapChannels(cell, (value) => base + (value - base) * 0.32);
}

export function lowContrast(cell: ImageData): ImageData {
  const center = 205;
  return mapChannels(cell, (value) => center + (value - center) * 0.42);
}

export const degradations: Degradation[] = [
  { name: 'rotated +7°', apply: (cell) => rotate(cell, 7) },
  { name: 'rotated -7°', apply: (cell) => rotate(cell, -7) },
  { name: 'sheared 8%', apply: (cell) => shear(cell, 0.08) },
  { name: 'faint pencil', apply: faint },
  { name: 'blurred 3×3', apply: blur },
  { name: 'low contrast', apply: lowContrast },
];
