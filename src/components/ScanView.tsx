import { useEffect, useRef, useState } from 'react';
import type {
  AnswerKey,
  AppSettings,
  ScanProgress,
  ScanResult,
  SetId,
} from '../types';
import { SET_IDS } from '../types';
import { countUnresolved } from '../lib/scoring';
import { CameraPanel } from './CameraPanel';
import { ConfirmationPanel } from './ConfirmationPanel';
import { ResultSummary } from './ResultSummary';
import { ReviewView } from './ReviewView';

export type QueueStatus = 'waiting' | 'processing' | 'done' | 'error';

export interface QueueItem {
  id: string;
  scanNumber: number;
  status: QueueStatus;
  message?: string;
}

export function ScanView({
  currentScan,
  scans,
  queue,
  busy,
  progress,
  settings,
  answerKey,
  onCapture,
  onFiles,
  onScanAnother,
  onSelectScan,
  onCorrect,
  onDelete,
  onExport,
  onAutoCaptureChange,
}: {
  currentScan: ScanResult | null;
  scans: ScanResult[];
  queue: QueueItem[];
  busy: boolean;
  progress: ScanProgress | null;
  settings: AppSettings;
  answerKey: AnswerKey;
  onCapture: (canvas: HTMLCanvasElement) => void;
  onFiles: (files: File[]) => void;
  onScanAnother: () => void;
  onSelectScan: (id: string) => void;
  onCorrect: (set: SetId, row: number, digit: number | null) => void;
  onDelete: () => void;
  onExport: () => void;
  onAutoCaptureChange: (value: boolean) => void;
}) {
  const [drag, setDrag] = useState(false);
  const [cameraStartSignal, setCameraStartSignal] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<HTMLDivElement | null>(null);

  const currentId = currentScan?.id ?? null;
  useEffect(() => {
    if (!currentId) return;
    resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [currentId]);

  const chooseFiles = () => fileRef.current?.click();

  const startCamera = () => {
    setCameraStartSignal((value) => value + 1);
    cameraRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const acceptFiles = (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length) onFiles(images);
  };

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          acceptFiles(files);
          event.target.value = '';
        }}
      />

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">Standard Progressive Matrices · Sets A–E</div>
          <h1>Scan the sheet. Read the score.</h1>
          <p className="hero-sub">
            One answer table per image. The scanner reads only the handwritten student column,
            ignores red annotations and printed totals, then asks you to confirm uncertain answers
            before it releases the Set A–E scores and total.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary btn-xl" onClick={startCamera} disabled={busy}>
              Scan answer sheet
            </button>
            <button className="btn btn-outline btn-xl" onClick={chooseFiles} disabled={busy}>
              Upload image
            </button>
          </div>
          <div className="hero-meta">
            <span className="dot" />
            Everything runs on this device. No uploads, accounts, or student records.
          </div>
        </div>
        <div className="hero-points" aria-label="How scanning works">
          <div>
            <span className="hero-number">1</span>
            <div>
              <strong>Capture or upload</strong>
              <span>Use the rear camera or choose a JPG/PNG photo.</span>
            </div>
          </div>
          <div>
            <span className="hero-number">2</span>
            <div>
              <strong>Local recognition</strong>
              <span>Table detection, perspective correction, and handwritten-digit reading.</span>
            </div>
          </div>
          <div>
            <span className="hero-number">3</span>
            <div>
              <strong>Confirm, then score</strong>
              <span>
                Review every flagged cell with its crop; set scores and the total unlock after all
                confirmations.
              </span>
            </div>
          </div>
        </div>
      </section>

      {busy && <ScanProgressCard progress={progress} />}

      <div className="scan-layout">
        <div className="scan-main">
          <div ref={cameraRef}>
            <CameraPanel
              onCapture={onCapture}
              busy={busy}
              autoCapture={settings.autoCapture}
              onAutoCaptureChange={onAutoCaptureChange}
              startSignal={cameraStartSignal}
            />
          </div>

          {currentScan && (
            <div className="result-stack" ref={resultRef}>
              {countUnresolved(currentScan) > 0 && (
                // These sibling panels share the scan id but need distinct keys.
                // Duplicate keys can leave the confirmation card in the DOM after
                // the last answer is confirmed.
                <ConfirmationPanel
                  key={`confirmation-${currentScan.id}`}
                  scan={currentScan}
                  answerKey={answerKey}
                  onCorrect={onCorrect}
                />
              )}

              <ResultSummary
                scan={currentScan}
                onScanAnother={onScanAnother}
                onExport={onExport}
              />

              <ReviewSection
                key={`review-${currentScan.id}`}
                scan={currentScan}
                answerKey={answerKey}
                onCorrect={onCorrect}
                onDelete={onDelete}
                onExport={onExport}
              />
            </div>
          )}
        </div>

        <aside className="scan-side">
          <section className="card">
            <div className="card-head">
              <h2>Upload</h2>
              <span className="muted">Single or batch</span>
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
                  acceptFiles(Array.from(event.dataTransfer.files));
                }}
              >
                <strong>Drop answer-sheet photos here</strong>
                JPG or PNG. Batch files are scanned one at a time and shown as separate results.
                <div className="dropzone-action">
                  <button className="btn btn-outline btn-sm" onClick={chooseFiles} disabled={busy}>
                    Choose images
                  </button>
                </div>
              </div>
              <p className="privacy-note">
                <span className="dot" />
                Built-in recognition. Images never leave this browser.
              </p>
            </div>
          </section>

          {queue.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>Scan queue</h2>
                <span className="muted">
                  {queue.filter((item) => item.status === 'done').length}/{queue.length} done
                </span>
              </div>
              <div className="card-pad queue">
                {queue.map((item) => (
                  <div className="queue-row" key={item.id}>
                    <span className="scan-no">#{item.scanNumber}</span>
                    <span className="muted">{item.message ?? 'Answer sheet'}</span>
                    <span className={`status ${item.status}`}>{item.status}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2>Batch results</h2>
              <span className="muted">
                {scans.length === 0 ? 'No sheets yet' : `${scans.length} separate`}
              </span>
            </div>
            <div className="card-pad">
              {scans.length === 0 ? (
                <div className="empty-small">
                  Results appear here. Starting a new scan clears the previous session.
                </div>
              ) : (
                <div className="batch-list">
                  {scans.map((scan) => {
                    const pending = countUnresolved(scan);
                    return (
                      <button
                        className={`batch-row ${currentScan?.id === scan.id ? 'active' : ''} ${
                          pending > 0 ? 'pending' : ''
                        }`}
                        key={scan.id}
                        onClick={() => onSelectScan(scan.id)}
                      >
                        <span className="batch-no">#{scan.scanNumber}</span>
                        <span>
                          <div className="batch-scores">
                            {pending > 0
                              ? `${pending} answer${pending === 1 ? '' : 's'} need confirmation`
                              : SET_IDS.map((set) => `${set} ${scan.sets[set].score}`).join(' · ')}
                          </div>
                          <div className="tiny batch-time">
                            {(scan.durationMs / 1000).toFixed(2)} s
                            {scan.quality.warnings.length ? ' · quality warning' : ''}
                          </div>
                        </span>
                        <span className={`batch-total ${pending > 0 ? 'pending' : ''}`}>
                          {pending > 0 ? (
                            <>
                              Review
                              <small>{pending} left</small>
                            </>
                          ) : (
                            <>
                              {scan.total}
                              <small>/60</small>
                            </>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ReviewSection({
  scan,
  answerKey,
  onCorrect,
  onDelete,
  onExport,
}: {
  scan: ScanResult;
  answerKey: AnswerKey;
  onCorrect: (set: SetId, row: number, digit: number | null) => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = countUnresolved(scan);

  return (
    <section className="card review-card">
      <button
        className="review-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="review-heading">
          <strong>All 60 answers</strong>
          <span className="muted">
            {pending > 0
              ? `${pending} need confirmation · final score locked`
              : 'All unresolved answers confirmed · corrections are optional'}
          </span>
        </span>
        <span className="review-cta">{open ? 'Hide grid' : 'Open full grid'}</span>
      </button>
      {open && (
        <div className="review-body">
          <ReviewView
            embedded
            scan={scan}
            answerKey={answerKey}
            onCorrect={onCorrect}
            onDelete={onDelete}
            onExport={onExport}
          />
        </div>
      )}
    </section>
  );
}

function ScanProgressCard({ progress }: { progress: ScanProgress | null }) {
  const percent = progressPercent(progress);
  const reading = progress?.stage === 'reading';
  return (
    <section className="card progress-card" role="status" aria-live="polite">
      <div className="progress-head">
        <span className="spinner" aria-hidden />
        <div>
          <strong>{progress?.label ?? 'Scanning answer sheet'}</strong>
          <span>Local recognition · the page stays responsive</span>
        </div>
        <span className="progress-value">
          {reading && progress ? `${progress.completed}/${progress.total}` : `${percent}%`}
        </span>
      </div>
      <div className="progress-track" aria-hidden>
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </section>
  );
}

function progressPercent(progress: ScanProgress | null): number {
  if (!progress) return 4;
  if (progress.stage === 'preparing') return 6;
  if (progress.stage === 'detecting') return 14;
  if (progress.stage === 'aligning') return 28;
  if (progress.stage === 'reading') {
    return 30 + Math.round((progress.completed / Math.max(1, progress.total)) * 62);
  }
  return 96;
}
