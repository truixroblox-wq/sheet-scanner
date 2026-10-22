import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_KEY,
  DEFAULT_SETTINGS,
  KEY_STORAGE,
  SETTINGS_STORAGE,
  cloneKey,
  validateKey,
} from './lib/config';
import { downloadJson, dHash, fileToCanvas } from './lib/image';
import { findDuplicateSheet } from './lib/duplicates';
import {
  applyCorrections,
  correctCell,
  countUnresolved,
  resetKey,
} from './lib/scoring';
import { scanSheet } from './lib/vision/scan';
import type {
  AnswerKey,
  AppSettings,
  ScanProgress,
  ScanResult,
  SetId,
} from './types';
import { SET_IDS } from './types';
import { ScanView, type QueueItem } from './components/ScanView';
import { KeyView } from './components/KeyView';

type View = 'scan' | 'settings';

function loadKey(): AnswerKey {
  try {
    const raw = localStorage.getItem(KEY_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (validateKey(parsed)) return parsed;
    }
  } catch {
    // ignore corrupt storage
  }
  return cloneKey(DEFAULT_KEY);
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      // The previous build stored the unvalidated 0.70 / 0.35 gate. Upgrade that
      // exact legacy pair so existing browsers pick up the validated default.
      const legacyGate =
        Number(parsed.confidenceThreshold) === 0.7 && Number(parsed.marginThreshold) === 0.35;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        confidenceThreshold: legacyGate
          ? DEFAULT_SETTINGS.confidenceThreshold
          : clamp(
              Number(parsed.confidenceThreshold) || DEFAULT_SETTINGS.confidenceThreshold,
              0.3,
              0.99,
            ),
        marginThreshold: legacyGate
          ? DEFAULT_SETTINGS.marginThreshold
          : clamp(Number(parsed.marginThreshold) || DEFAULT_SETTINGS.marginThreshold, 0.1, 0.99),
      };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_SETTINGS };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export default function App() {
  const [view, setView] = useState<View>('scan');
  const [answerKey, setAnswerKey] = useState<AnswerKey>(loadKey);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [scans, setScans] = useState<ScanResult[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const scansRef = useRef(scans);
  const keyRef = useRef(answerKey);
  const settingsRef = useRef(settings);
  const nextNumberRef = useRef(1);
  const fileQueueRef = useRef<{ file: File; queueId: string; scanNumber: number }[]>([]);
  const processingRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(KEY_STORAGE, JSON.stringify(answerKey));
  }, [answerKey]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(settings));
  }, [settings]);

  // Keep the latest values available to async scan/queue callbacks without
  // re-creating those callbacks on every keystroke.
  useEffect(() => {
    scansRef.current = scans;
  }, [scans]);

  useEffect(() => {
    keyRef.current = answerKey;
  }, [answerKey]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Scores and confidence flags are derived from the raw readings, so changing
  // the key or settings rescores every sheet without mutating stored results.
  const scoredScans = useMemo(
    () =>
      scans.map((scan) => {
        const rescored = applyCorrections(scan, answerKey, settings.blankPolicy);
        return {
          ...rescored,
          sets: rescoreThresholds(rescored, settings),
        };
      }),
    [scans, answerKey, settings],
  );

  const currentScan = useMemo(
    () => scoredScans.find((scan) => scan.id === currentId) ?? null,
    [scoredScans, currentId],
  );

  const updateQueue = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((previous) => previous.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  /**
   * Every new individual scan and every new batch starts a clean session. This
   * hides the previous score while scanning and means a deliberate rescan of the
   * same image is not mistaken for a duplicate of the previous sheet.
   */
  const beginScanSession = useCallback(() => {
    scansRef.current = [];
    fileQueueRef.current = [];
    nextNumberRef.current = 1;
    setScans([]);
    setCurrentId(null);
    setQueue([]);
  }, []);

  const addScan = useCallback((scan: ScanResult) => {
    scansRef.current = [scan, ...scansRef.current];
    setScans((previous) => [scan, ...previous]);
    setCurrentId(scan.id);
  }, []);

  const isDuplicate = useCallback((hash: string): boolean => {
    return (
      findDuplicateSheet(scansRef.current, hash, settingsRef.current.duplicateGuard) !== undefined
    );
  }, []);

  const runCanvas = useCallback(
    async (canvas: HTMLCanvasElement, scanNumber: number): Promise<ScanResult | null> => {
      const hash = dHash(canvas);
      if (isDuplicate(hash)) return null;
      const scan = await scanSheet({
        canvas,
        imageHash: hash,
        scanNumber,
        settings: settingsRef.current,
        key: keyRef.current,
        onProgress: setProgress,
      });
      addScan(scan);
      return scan;
    },
    [addScan, isDuplicate],
  );

  // The queue drains itself recursively. Each file is a separate result; scores
  // from different sheets are never merged.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    const next = fileQueueRef.current.shift();
    if (!next) {
      setBusy(false);
      setProgress(null);
      return;
    }
    processingRef.current = true;
    setBusy(true);
    updateQueue(next.queueId, { status: 'processing', message: 'Reading image…' });
    setProgress({ stage: 'preparing', label: 'Reading the image', completed: 0, total: 60 });
    try {
      const canvas = await fileToCanvas(next.file);
      const scan = await runCanvas(canvas, next.scanNumber);
      if (!scan) {
        updateQueue(next.queueId, { status: 'done', message: 'Duplicate image — skipped' });
        setNotice('Duplicate image skipped within this batch. Start a new scan to rescan it.');
      } else {
        updateQueue(next.queueId, {
          status: 'done',
          message: scanQueueMessage(scan),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read this image.';
      updateQueue(next.queueId, { status: 'error', message });
      setNotice(message);
    } finally {
      processingRef.current = false;
      if (fileQueueRef.current.length > 0) {
        void processQueue();
      } else {
        setBusy(false);
        setProgress(null);
      }
    }
  }, [runCanvas, updateQueue]);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      if (busy || processingRef.current) {
        setNotice('Finish the current scan before starting a new batch.');
        return;
      }
      beginScanSession();
      const items = files.map((file) => {
        const scanNumber = nextNumberRef.current++;
        const queueId = crypto.randomUUID();
        return { file, scanNumber, queueId };
      });
      setQueue(
        items.map((item) => ({
          id: item.queueId,
          scanNumber: item.scanNumber,
          status: 'waiting' as const,
          message: 'Queued',
        })),
      );
      fileQueueRef.current = items;
      void processQueue();
    },
    [beginScanSession, busy, processQueue],
  );

  const handleCapture = useCallback(
    async (canvas: HTMLCanvasElement) => {
      if (busy || processingRef.current) return;
      beginScanSession();
      const scanNumber = nextNumberRef.current++;
      const queueId = crypto.randomUUID();
      setQueue([{ id: queueId, scanNumber, status: 'processing', message: 'Reading image…' }]);
      setBusy(true);
      setProgress({ stage: 'preparing', label: 'Reading the camera frame', completed: 0, total: 60 });
      try {
        const scan = await runCanvas(canvas, scanNumber);
        if (!scan) {
          updateQueue(queueId, { status: 'done', message: 'Duplicate image — skipped' });
          setNotice('This image matches a sheet already in this batch.');
        } else {
          updateQueue(queueId, {
            status: 'done',
            message: scanQueueMessage(scan),
          });
          const pending = countUnresolved(scan);
          if (pending > 0) {
            setNotice(
              `${pending} answer${pending === 1 ? '' : 's'} need confirmation. ` +
                'The final score stays locked until each one is reviewed.',
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not read this sheet.';
        updateQueue(queueId, { status: 'error', message });
        setNotice(message);
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [beginScanSession, busy, runCanvas, updateQueue],
  );

  const handleScanAnother = useCallback(() => {
    if (busy || processingRef.current) return;
    beginScanSession();
    setView('scan');
    setNotice('Ready for the next sheet.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [beginScanSession, busy]);

  const handleSelectScan = useCallback((id: string) => {
    setCurrentId(id);
    setView('scan');
  }, []);

  const handleCorrect = useCallback(
    (set: SetId, row: number, digit: number | null) => {
      if (!currentId) return;
      setScans((previous) => {
        const next = previous.map((scan) =>
          scan.id === currentId
            ? correctCell(
                scan,
                set,
                row,
                digit,
                keyRef.current,
                settingsRef.current.blankPolicy,
                settingsRef.current,
              )
            : scan,
        );
        scansRef.current = next;
        return next;
      });
    },
    [currentId],
  );

  const handleDelete = useCallback(() => {
    if (!currentId) return;
    setScans((previous) => {
      const next = previous.filter((scan) => scan.id !== currentId);
      scansRef.current = next;
      return next;
    });
    setCurrentId(null);
    setNotice('Scan result removed.');
  }, [currentId]);

  const handleKeyChange = useCallback((set: SetId, index: number, value: number) => {
    const safe = Number.isFinite(value) ? clamp(Math.round(value), 1, 8) : 1;
    setAnswerKey((previous) => {
      const next = cloneKey(previous);
      next[set][index] = safe;
      return next;
    });
  }, []);

  const handleImportKey = useCallback(async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!validateKey(parsed)) throw new Error('The file must contain Sets A–E with 12 digits from 1 to 8.');
      setAnswerKey(parsed);
      setNotice('Answer key imported.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not import that key.');
    }
  }, []);

  const handleExportKey = useCallback(() => {
    downloadJson('spm-answer-key.json', answerKey);
  }, [answerKey]);

  const handleExportScan = useCallback(() => {
    if (!currentScan) return;
    const pending = countUnresolved(currentScan);
    if (pending > 0) {
      setNotice(
        `Confirm ${pending} remaining answer${pending === 1 ? '' : 's'} before exporting the final score.`,
      );
      return;
    }
    const payload = {
      scanNumber: currentScan.scanNumber,
      createdAt: new Date(currentScan.createdAt).toISOString(),
      sets: Object.fromEntries(
        SET_IDS.map((set) => [
          set,
          {
            score: currentScan.sets[set].score,
            maximum: 12,
            blankAdjustedMaximum: currentScan.sets[set].denominator,
            answers: currentScan.sets[set].cells.map((cell) => ({
              row: cell.row,
              digit: cell.digit,
              state: cell.state,
              confidence: Number(cell.confidence.toFixed(3)),
              confirmed: Boolean(cell.confirmed || cell.corrected),
            })),
          },
        ]),
      ),
      total: currentScan.total,
      totalPossible: 60,
      blankAdjustedTotalPossible: currentScan.totalPossible,
      durationMs: Number(currentScan.durationMs.toFixed(1)),
      quality: currentScan.quality,
      note: 'No student identity is stored. Printed sheet totals were ignored. Main scores use /12 and /60.',
    };
    downloadJson(`spm-scan-${currentScan.scanNumber}.json`, payload);
  }, [currentScan]);

  return (
    <div className="app">
      <header className="header">
        <div className="shell header-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden>
              SPM
            </div>
            <div>
              <div className="brand-title">SPM Quick Score</div>
              <div className="brand-sub">Sets A–E · fast local scanning</div>
            </div>
          </div>
          <div className="header-actions">
            <span className="local-badge">
              <span className="dot" />
              On-device
            </span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setView((previous) => (previous === 'scan' ? 'settings' : 'scan'))}
            >
              {view === 'settings' ? 'Back to scanner' : 'Answer key & settings'}
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        <div className="shell">
          {view === 'scan' ? (
            <ScanView
              currentScan={currentScan}
              scans={scoredScans}
              queue={queue}
              busy={busy}
              progress={progress}
              settings={settings}
              answerKey={answerKey}
              onCapture={handleCapture}
              onFiles={handleFiles}
              onScanAnother={handleScanAnother}
              onSelectScan={handleSelectScan}
              onCorrect={handleCorrect}
              onDelete={handleDelete}
              onExport={handleExportScan}
              onAutoCaptureChange={(value) => setSettings((s) => ({ ...s, autoCapture: value }))}
            />
          ) : (
            <KeyView
              answerKey={answerKey}
              settings={settings}
              onBack={() => setView('scan')}
              onChange={handleKeyChange}
              onReset={() => {
                setAnswerKey(resetKey());
                setNotice('Key reset to the initial configuration.');
              }}
              onImport={handleImportKey}
              onExport={handleExportKey}
              onSettingsChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
            />
          )}
        </div>
      </main>

      <footer className="footer">
        <div className="shell footer-inner">
          <span>Runs entirely in this browser · no uploads, accounts, or student records</span>
          <span>Handwritten student column only · printed totals ignored</span>
        </div>
      </footer>

      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}

function rescoreThresholds(scan: ScanResult, settings: AppSettings): ScanResult['sets'] {
  const out = {} as ScanResult['sets'];
  for (const set of SET_IDS) {
    out[set] = {
      ...scan.sets[set],
      cells: scan.sets[set].cells.map((cell) => {
        if (
          cell.confirmed ||
          cell.corrected ||
          cell.state === 'blank' ||
          cell.state === 'obstructed'
        ) {
          return cell;
        }
        if (cell.digit == null) return cell;
        const uncertain =
          cell.confidence < settings.confidenceThreshold || cell.margin < settings.marginThreshold;
        return uncertain ? { ...cell, state: 'uncertain' as const } : cell;
      }),
    };
  }
  return out;
}

function scanQueueMessage(scan: ScanResult): string {
  const pending = countUnresolved(scan);
  const duration = `${(scan.durationMs / 1000).toFixed(2)} s`;
  if (pending > 0) {
    return `Needs confirmation · ${pending} answer${pending === 1 ? '' : 's'} · ${duration}`;
  }
  return `${scan.total}/60 · ${duration}`;
}
