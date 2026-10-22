import { decodeWeights } from './mnistWeights';

/**
 * Minimal, dependency-free inference for the ONNX Model Zoo mnist-8 CNN.
 *
 * Input is a 28x28 Float32Array of grayscale values in [0,1], white ink on a
 * black background (MNIST convention). The model outputs 10 logits; we apply
 * softmax here. Weights are loaded once and reused for every cell.
 */
export interface MnistModel {
  conv1W: Float32Array;
  conv1B: Float32Array;
  conv2W: Float32Array;
  conv2B: Float32Array;
  fcW: Float32Array;
  fcB: Float32Array;
}

let cached: MnistModel | null = null;

export function getModel(): MnistModel {
  if (!cached) cached = decodeWeights();
  return cached;
}

export interface DigitPrediction {
  /** Most likely digit (0-9). */
  digit: number;
  /** Softmax probability of the winning class, 0..1. */
  confidence: number;
  /** Difference between the top two class probabilities. */
  margin: number;
  /** Full probability vector. */
  probabilities: Float32Array;
}

export function softmax(logits: ArrayLike<number>): Float32Array {
  const out = new Float32Array(logits.length);
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const v = Math.exp(logits[i] - max);
    out[i] = v;
    sum += v;
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/** Conv 5x5, SAME_UPPER padding, stride 1. Input/output are CHW planes. */
function convSame(
  input: Float32Array,
  inH: number,
  inW: number,
  inC: number,
  weights: Float32Array,
  bias: Float32Array,
  outC: number,
): Float32Array {
  const out = new Float32Array(outC * inH * inW);
  const pad = 2;

  // Pad once. The inner convolution loop then has no bounds checks, which is
  // measurably faster than testing five edges for every kernel tap.
  const paddedH = inH + pad * 2;
  const paddedW = inW + pad * 2;
  const padded = new Float32Array(inC * paddedH * paddedW);
  for (let ic = 0; ic < inC; ic++) {
    const inBase = ic * inH * inW;
    const padBase = ic * paddedH * paddedW;
    for (let y = 0; y < inH; y++) {
      let source = inBase + y * inW;
      let target = padBase + (y + pad) * paddedW + pad;
      for (let x = 0; x < inW; x++) padded[target++] = input[source++];
    }
  }

  for (let oc = 0; oc < outC; oc++) {
    const wBase = oc * inC * 25;
    const b = bias[oc];
    const outBase = oc * inH * inW;
    for (let y = 0; y < inH; y++) {
      const outRow = outBase + y * inW;
      for (let x = 0; x < inW; x++) {
        let sum = b;
        for (let ic = 0; ic < inC; ic++) {
          const inBase = ic * paddedH * paddedW + y * paddedW + x;
          const wChan = wBase + ic * 25;
          for (let ky = 0; ky < 5; ky++) {
            const inRow = inBase + ky * paddedW;
            const wRow = wChan + ky * 5;
            sum +=
              padded[inRow] * weights[wRow] +
              padded[inRow + 1] * weights[wRow + 1] +
              padded[inRow + 2] * weights[wRow + 2] +
              padded[inRow + 3] * weights[wRow + 3] +
              padded[inRow + 4] * weights[wRow + 4];
          }
        }
        out[outRow + x] = sum > 0 ? sum : 0;
      }
    }
  }
  return out;
}

function maxPool(
  input: Float32Array,
  inH: number,
  inW: number,
  channels: number,
  size: number,
  stride: number,
): { data: Float32Array; h: number; w: number } {
  const h = Math.floor((inH - size) / stride) + 1;
  const w = Math.floor((inW - size) / stride) + 1;
  const out = new Float32Array(channels * h * w);
  for (let c = 0; c < channels; c++) {
    const inBase = c * inH * inW;
    const outBase = c * h * w;
    for (let y = 0; y < h; y++) {
      const row = inBase + y * stride * inW;
      for (let x = 0; x < w; x++) {
        const i = row + x * stride;
        let max: number;
        if (size === 2) {
          max = Math.max(input[i], input[i + 1], input[i + inW], input[i + inW + 1]);
        } else if (size === 3) {
          max = Math.max(
            input[i], input[i + 1], input[i + 2],
            input[i + inW], input[i + inW + 1], input[i + inW + 2],
            input[i + inW * 2], input[i + inW * 2 + 1], input[i + inW * 2 + 2],
          );
        } else {
          max = -Infinity;
          for (let ky = 0; ky < size; ky++) {
            const rowBase = i + ky * inW;
            for (let kx = 0; kx < size; kx++) {
              const v = input[rowBase + kx];
              if (v > max) max = v;
            }
          }
        }
        out[outBase + y * w + x] = max;
      }
    }
  }
  return { data: out, h, w };
}

/** Run the CNN on one 28x28 MNIST-normalized image. */
export function predictMnist(input: Float32Array, model: MnistModel = getModel()): DigitPrediction {
  if (input.length !== 784) throw new Error(`Expected 784 pixels, got ${input.length}`);
  const c1 = convSame(input, 28, 28, 1, model.conv1W, model.conv1B, 8);
  const p1 = maxPool(c1, 28, 28, 8, 2, 2);
  const c2 = convSame(p1.data, p1.h, p1.w, 8, model.conv2W, model.conv2B, 16);
  const p2 = maxPool(c2, p1.h, p1.w, 16, 3, 3);
  const logits = new Float32Array(10);
  for (let o = 0; o < 10; o++) {
    let sum = model.fcB[o];
    const wBase = o * 256;
    for (let i = 0; i < 256; i++) sum += p2.data[i] * model.fcW[wBase + i];
    logits[o] = sum;
  }
  const probabilities = softmax(logits);
  let digit = 0;
  let confidence = probabilities[0];
  for (let i = 1; i < 10; i++) {
    if (probabilities[i] > confidence) {
      confidence = probabilities[i];
      digit = i;
    }
  }
  let second = 0;
  for (let i = 0; i < 10; i++) {
    if (i !== digit && probabilities[i] > second) second = probabilities[i];
  }
  return { digit, confidence, margin: confidence - second, probabilities };
}
