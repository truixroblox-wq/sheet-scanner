import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const src = path.resolve('src');
const files = sourceFiles(src);
const sourceText = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

describe('camera removal and upload-first UI', () => {
  it('has no live-camera component or browser camera API', () => {
    expect(fs.existsSync(path.join(src, 'components', 'CameraPanel.tsx'))).toBe(false);
    expect(sourceText).not.toMatch(/getUserMedia/);
    expect(sourceText).not.toMatch(/navigator\.mediaDevices/);
    expect(sourceText).not.toMatch(/srcObject/);
    expect(sourceText).not.toMatch(/CameraPanel/);
    expect(sourceText).not.toMatch(/autoCapture\s*[:=]/);
    expect(sourceText).not.toMatch(/onAutoCaptureChange|setAutoCapture/);
    expect(sourceText).not.toMatch(/<video/i);
  });

  it('keeps upload and batch upload as the primary flow', () => {
    const scanView = fs.readFileSync(path.join(src, 'components', 'ScanView.tsx'), 'utf8');
    expect(scanView).toContain('Upload answer sheets');
    expect(scanView).toContain('Batch upload');
    expect(scanView).toContain('multiple');
    expect(scanView).toContain('type="file"');
  });
});
