// One-off extraction of the ONNX MNIST CNN weights into a compact JS module.
// Run with: node scripts/extract-mnist-weights.cjs <model.onnx> <onnx.proto>
const protobuf = require('protobufjs');
const fs = require('fs');
const path = require('path');

(async () => {
  const modelPath = process.argv[2];
  const protoPath = process.argv[3];
  const root = await protobuf.load(protoPath);
  const ModelProto = root.lookupType('onnx.ModelProto');
  const model = ModelProto.decode(fs.readFileSync(modelPath));

  const byName = new Map();
  for (const t of model.graph.initializer) {
    byName.set(t.name, t);
  }

  function floats(t) {
    if (t.floatData && t.floatData.length) return Float32Array.from(t.floatData);
    if (t.rawData && t.rawData.length) {
      const buf = Buffer.from(t.rawData);
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    }
    throw new Error('unsupported tensor ' + t.name);
  }

  function b64(arr) {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
  }

  const tensors = {
    conv1_w: floats(byName.get('Parameter5')),
    conv1_b: floats(byName.get('Parameter6')),
    conv2_w: floats(byName.get('Parameter87')),
    conv2_b: floats(byName.get('Parameter88')),
    fc_w: floats(byName.get('Parameter193')),
    fc_b: floats(byName.get('Parameter194')),
  };

  // The graph's MatMul weight is [16,4,4,10], reshaped to [256,10].
  // Reorder to [10,256] for a cache-friendly dot product.
  const fcSrc = tensors.fc_w;
  const fc = new Float32Array(10 * 256);
  for (let i = 0; i < 256; i++) {
    for (let o = 0; o < 10; o++) {
      fc[o * 256 + i] = fcSrc[i * 10 + o];
    }
  }
  tensors.fc_w = fc;

  const out = `// AUTO-GENERATED from ONNX model zoo mnist-8.onnx (MIT). Do not edit.
// Architecture: Conv5x5(1->8, SAME) ReLU MaxPool2 Conv5x5(8->16, SAME) ReLU MaxPool3 FC(256->10)
export const WEIGHTS = {
  conv1W: ${JSON.stringify(b64(tensors.conv1_w))},
  conv1B: ${JSON.stringify(b64(tensors.conv1_b))},
  conv2W: ${JSON.stringify(b64(tensors.conv2_w))},
  conv2B: ${JSON.stringify(b64(tensors.conv2_b))},
  fcW: ${JSON.stringify(b64(tensors.fc_w))},
  fcB: ${JSON.stringify(b64(tensors.fc_b))},
} as const;

export function decodeWeights() {
  const dec = (s: string) => {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  };
  return {
    conv1W: dec(WEIGHTS.conv1W),
    conv1B: dec(WEIGHTS.conv1B),
    conv2W: dec(WEIGHTS.conv2W),
    conv2B: dec(WEIGHTS.conv2B),
    fcW: dec(WEIGHTS.fcW),
    fcB: dec(WEIGHTS.fcB),
  };
}
`;

  const target = path.resolve('src/lib/ocr/mnistWeights.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out);
  console.log('wrote', target, 'bytes', out.length);
  for (const [k, v] of Object.entries(tensors)) console.log(k, v.length);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
