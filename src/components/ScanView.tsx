import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ScanResult } from '../types';
import { CameraPanel } from './CameraPanel';
import { ResultSummary } from './ResultSummary';

export type QueueStatus = 'waiting' | 'processing' | 'done' | 'error';

export interface QueueItem {
  id: string;
  scanNumber: number;
  status: QueueStatus;
  message?: string;
}

export function ScanView({
  latestScan,
  scans,
  queue,
  busy,
  settings,
  onCapture,
  onFiles,
  onReview,
  onRescan,
  onNext,
  onSelectScan,
  onAutoCaptureChange,
}: {
  latestScan: ScanResult | null;
  scans: ScanResult[];
  queue: QueueItem[];
  busy: boolean;
  settings: AppSettings;
  onCapture: (canvas: HTMLCanvasElement) => void;
  onFiles: (files: File[]) => void;
  onReview: (id: string) => void;
  onRescan: () => void;
  onNext: () => void;
  onSelectScan: (id: string) => void;
  onAutoCaptureChange: (value: boolean) => void;
}) {
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // Keep the result visible after an upload or capture without hiding the
  // camera controls while the sheet is being lined up.
  const latestScanId = latestScan?.id ?? null;
  useEffect(() => {
    if (!latestScanId) return;
    resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [latestScanId]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Scan answer sheets</h1>
          <p className="page-sub">
            One complete Standard Progressive Matrices table per frame. Answers are read only from
            the middle student column; printed totals and red annotations are ignored. Everything
            runs on this device.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary btn-lg" onClick={onRescan}>
            Scan another
          </button>
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>
            Upload images
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length) onFiles(files);
              event.target.value = '';
            }}
          />
        </div>
      </div>

      <div className="scan-layout">
        <div className="scan-side" style={{ gap: 16 }}>
          <CameraPanel
            onCapture={onCapture}
            busy={busy}
            autoCapture={settings.autoCapture}
            onAutoCaptureChange={onAutoCaptureChange}
          />
          {latestScan && (
            <div ref={resultRef}>
              <ResultSummary
                scan={latestScan}
                onReview={() => onReview(latestScan.id)}
                onRescan={onRescan}
                onNext={onNext}
              />
            </div>
          )}
        </div>

        <aside className="scan-side">
          <section className="card">
            <div className="card-head">
              <h2>Upload</h2>
              <span className="muted">single or batch</span>
            </div>
            <div className="card-pad">
              <div
                className={`dropzone ${drag ? 'drag' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDrag(false);
                  const files = Array.from(event.dataTransfer.files).filter((file) =>
                    file.type.startsWith('image/'),
                  );
                  if (files.length) onFiles(files);
                }}
              >
                <strong>Drop answer-sheet photos here</strong>
                JPG or PNG photo. Batch files are queued and scanned one by one.
                <div style={{ marginTop: 12 }}>
                  <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>
                    Choose files
                  </button>
                </div>
              </div>
              <div className="muted" style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <span className="dot" style={{ color: 'var(--good)' }} />
                Built-in vision engine · everything stays on this device
              </div>
            </div>
          </section>

          {queue.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>Queue</h2>
                <span className="muted">scan numbers only</span>
              </div>
              <div className="card-pad queue">
                {queue.map((item) => (
                  <div className="queue-row" key={item.id}>
                    <span className="scan-no">Scan #{item.scanNumber}</span>
                    <span className="muted">{item.message ?? 'Answer sheet'}</span>
                    <span className={`status ${item.status}`}>{item.status}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2>Batch</h2>
              <span className="muted">{scans.length} scanned</span>
            </div>
            <div className="card-pad">
              {scans.length === 0 ? (
                <div className="muted">
                  No sheets yet. Scan continuously or upload a batch; each result is stored only in
                  this tab.
                </div>
              ) : (
                <div className="batch-list">
                  {scans.map((scan) => (
                    <button
                      className={`batch-row ${latestScan?.id === scan.id ? 'active' : ''}`}
                      key={scan.id}
                      onClick={() => onSelectScan(scan.id)}
                    >
                      <span className="batch-no">#{scan.scanNumber}</span>
                      <span>
                        <div className="batch-scores">
                          A {scan.sets.A.score} · B {scan.sets.B.score} · C {scan.sets.C.score} · D{' '}
                          {scan.sets.D.score} · E {scan.sets.E.score}
                        </div>
                        <div className="tiny" style={{ marginTop: 3 }}>
                          {(scan.durationMs / 1000).toFixed(2)} s
                          {scan.quality.warnings.length ? ' · quality warning' : ''}
                        </div>
                      </span>
                      <span className="batch-total">
                        {scan.total}
                        <small>/{scan.totalPossible}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
