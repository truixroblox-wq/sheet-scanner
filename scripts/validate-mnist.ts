import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { predictMnist, getModel } from '../src/lib/ocr/cnn';

function readIdx(file: string): { data: Uint8Array; dimensions: number[] } {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  let offset = 0;
  let magic = 0;
  for (let i = 0; i < 4; i++) magic = (magic << 8) | buf[offset++];
  const ndim = magic & 0xff;
  const dimensions: number[] = [];
  for (let i = 0; i < ndim; i++) {
    let d = 0;
    for (let j = 0; j < 4; j++) d = (d << 8) | buf[offset++];
    dimensions.push(d >>> 0);
  }
  return { data: buf.subarray(offset), dimensions };
}

const temp = process.env.TEMP || '/tmp';
const images = readIdx(path.join(temp, 't10k-images-idx3-ubyte.gz'));
const labels = readIdx(path.join(temp, 't10k-labels-idx1-ubyte.gz'));
const count = labels.dimensions[0];

function evaluate(name: string, transform: (v: number) => number, limit = count) {
  getModel();
  let correct = 0;
  const confusion = Array.from({ length: 10 }, () => new Float32Array(10));
  const started = performance.now();
  for (let n = 0; n < limit; n++) {
    const input = new Float32Array(784);
    for (let i = 0; i < 784; i++) input[i] = transform(images.data[n * 784 + i] / 255);
    const pred = predictMnist(input);
    const truth = labels.data[n];
    if (pred.digit === truth) correct++;
    confusion[truth][pred.digit]++;
  }
  const elapsed = performance.now() - started;
  const reported = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
  let reportedCorrect = 0;
  let reportedTotal = 0;
  for (const t of reported) {
    for (const p of reported) {
      if (t === p) reportedCorrect += confusion[t][p];
    }
    for (let p = 0; p < 10; p++) reportedTotal += confusion[t][p];
  }
  console.log(
    `${name}: ${(100 * correct / limit).toFixed(2)}% on ${limit} | reported-digits-only ${(100 * reportedCorrect / reportedTotal).toFixed(2)}% | ${(elapsed / limit).toFixed(2)} ms/cell`,
  );
  if (limit === count) {
    console.log('per-digit accuracy:');
    for (let d = 0; d < 10; d++) {
      const total = confusion[d].reduce((a, b) => a + b, 0);
      console.log(`  ${d}: ${(100 * confusion[d][d] / total).toFixed(2)}% (${total})`);
    }
  }
}

const limit = Number(process.argv[2] || count);
evaluate('raw 0..1', (v) => v, limit);
evaluate('MNIST mean/std', (v) => (v - 0.1307) / 0.3081, limit);
evaluate('centered *2', (v) => v * 2 - 1, limit);
