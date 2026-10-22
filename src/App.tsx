import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_KEY,
  DEFAULT_SETTINGS,
  KEY_STORAGE,
  SETTINGS_STORAGE,
  cloneKey,
  validateKey,
} from './lib/config';
import { downloadJson, dHash, fileToCanvas, hammingDistance } from './lib/image';
import { applyCorrections, correctCell, resetKey } from './lib/scoring';
import { scanSheet } from './lib/vision/scan';
import type { AnswerKey, AppSettings, ScanResult, SetId } from './types';
import { SET_IDS } from './types';
import { ScanView, type QueueItem } from './components/ScanView';
import { ReviewView } from './components/ReviewView';
import { KeyView } from './components/KeyView';

type Tab = 'scan' | 'review' | 'key';

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
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        confidenceThreshold: clamp(Number(parsed.confidenceThreshold) || 0.7, 0.3, 0.95),
        marginThreshold: clamp(Number(parsed.marginThreshold) || 0.35, 0.1, 0.8),
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
  const [tab, setTab] = useState<Tab>('scan');
  const [answerKey, setAnswerKey] = useState<AnswerKey>(loadKey);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [scans, setScans] = useState<ScanResult[]>([]);
  const [latestId, setLatestId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const scansRef = useRef(scans);
  const keyRef = useRef(answerKey);
  const settingsRef = useRef(settings);
  const nextNumberRef = useRef(1);
  const fileQueueRef = useRef<{ file: File; queueId: string; scanNumber: number }[]>([]);
  const processingRef = useRef(false);
  const ignoreDuplicateOnceRef = useRef(false);

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
    const timer = window.setTimeout(() => setNotice(null), 3800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Scores and confidence flags are derived from the raw readings, so changing
  // the key or settings rescored every sheet without mutating stored results.
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

  const updateQueue = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((previous) => previous.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const addScan = useCallback((scan: ScanResult) => {
    scansRef.current = [scan, ...scansRef.current];
    setScans((previous) => [scan, ...previous]);
    setLatestId(scan.id);
  }, []);

  const isDuplicate = useCallback((hash: string): boolean => {
    if (!settingsRef.current.duplicateGuard) return false;
    return scansRef.current.some((scan) => hammingDistance(scan.imageHash, hash) <= 5);
  }, []);

  const runCanvas = useCallback(
    async (canvas: HTMLCanvasElement, scanNumber: number, force = false): Promise<ScanResult | null> => {
      const hash = dHash(canvas);
      if (!force && isDuplicate(hash)) return null;
      const scan = await scanSheet({
        canvas,
        imageHash: hash,
        scanNumber,
        settings: settingsRef.current,
        key: keyRef.current,
      });
      addScan(scan);
      return scan;
    },
    [addScan, isDuplicate],
  );

  // The queue drains itself recursively; the React Compiler lint rule cannot
  // preserve this manual memoization, but the callback is intentionally stable.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    const next = fileQueueRef.current.shift();
    if (!next) return;
    processingRef.current = true;
    setBusy(true);
    updateQueue(next.queueId, { status: 'processing', message: 'Reading table…' });
    try {
      const canvas = await fileToCanvas(next.file);
      const force = ignoreDuplicateOnceRef.current;
      ignoreDuplicateOnceRef.current = false;
      const scan = await runCanvas(canvas, next.scanNumber, force);
      if (!scan) {
        updateQueue(next.queueId, { status: 'done', message: 'Duplicate — skipped' });
      } else {
        updateQueue(next.queueId, {
          status: 'done',
          message: `${scan.total}/${scan.totalPossible} · ${(scan.durationMs / 1000).toFixed(2)} s`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read this image.';
      updateQueue(next.queueId, { status: 'error', message });
      setNotice(message);
    } finally {
      processingRef.current = false;
      setBusy(false);
      void processQueue();
    }
  }, [runCanvas, updateQueue]);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const items = files.map((file) => {
        const scanNumber = nextNumberRef.current++;
        const queueId = crypto.randomUUID();
        return { file, scanNumber, queueId };
      });
      setQueue((previous) => [
        ...items.map((item) => ({
          id: item.queueId,
          scanNumber: item.scanNumber,
          status: 'waiting' as const,
          message: 'Queued',
        })),
        ...previous,
      ]);
      fileQueueRef.current.push(...items);
      void processQueue();
    },
    [processQueue],
  );

  const handleCapture = useCallback(
    async (canvas: HTMLCanvasElement) => {
      if (busy) return;
      const scanNumber = nextNumberRef.current++;
      const queueId = crypto.randomUUID();
      setQueue((previous) => [
        { id: queueId, scanNumber, status: 'processing', message: 'Reading table…' },
        ...previous,
      ]);
      setBusy(true);
      try {
        const force = ignoreDuplicateOnceRef.current;
        ignoreDuplicateOnceRef.current = false;
        const scan = await runCanvas(canvas, scanNumber, force);
        if (!scan) {
          updateQueue(queueId, { status: 'done', message: 'Duplicate — skipped' });
          setNotice('This sheet is already in the batch. Use Rescan to force a fresh scan.');
        } else {
          updateQueue(queueId, {
            status: 'done',
            message: `${scan.total}/${scan.totalPossible} · ${(scan.durationMs / 1000).toFixed(2)} s`,
          });
          const flagged = Object.values(scan.sets).reduce(
            (sum, set) => sum + set.cells.filter((c) => c.state === 'uncertain' || c.state === 'obstructed').length,
            0,
          );
          if (flagged > 0) setNotice(`${flagged} answer${flagged === 1 ? '' : 's'} flagged for review.`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not read this sheet.';
        updateQueue(queueId, { status: 'error', message });
        setNotice(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, runCanvas, updateQueue],
  );

  const handleRescan = useCallback(() => {
    ignoreDuplicateOnceRef.current = true;
    setLatestId(null);
    setTab('scan');
    setNotice('Ready to rescan. Keep the sheet steady in the guide.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleNext = useCallback(() => {
    setLatestId(null);
    setTab('scan');
    setNotice('Ready for the next sheet.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleReview = useCallback(
    (id: string) => {
      setActiveId(id);
      setTab('review');
    },
    [],
  );

  const handleCorrect = useCallback(
    (set: SetId, row: number, digit: number | null) => {
      if (!activeId) return;
      setScans((previous) =>
        previous.map((scan) =>
          scan.id === activeId
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
        ),
      );
    },
    [activeId],
  );

  const handleDelete = useCallback(() => {
    if (!activeId) return;
    setScans((previous) => previous.filter((scan) => scan.id !== activeId));
    if (latestId === activeId) setLatestId(null);
    setActiveId(null);
    setTab('scan');
    setNotice('Scan deleted.');
  }, [activeId, latestId]);

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
    const scan = scoredScans.find((item) => item.id === activeId);
    if (!scan) return;
    const payload = {
      scanNumber: scan.scanNumber,
      createdAt: new Date(scan.createdAt).toISOString(),
      sets: Object.fromEntries(
        SET_IDS.map((set) => [
          set,
          {
            score: scan.sets[set].score,
            denominator: scan.sets[set].denominator,
            answers: scan.sets[set].cells.map((cell) => ({
              row: cell.row,
              digit: cell.digit,
              state: cell.state,
              confidence: Number(cell.confidence.toFixed(3)),
            })),
          },
        ]),
      ),
      total: scan.total,
      totalPossible: scan.totalPossible,
      durationMs: Number(scan.durationMs.toFixed(1)),
      quality: scan.quality,
      note: 'No student identity is stored. Printed sheet totals were ignored.',
    };
    downloadJson(`spm-scan-${scan.scanNumber}.json`, payload);
  }, [activeId, scoredScans]);

  const latestScan = useMemo(
    () => scoredScans.find((scan) => scan.id === latestId) ?? null,
    [scoredScans, latestId],
  );
  const activeScan = useMemo(
    () => scoredScans.find((scan) => scan.id === activeId) ?? null,
    [scoredScans, activeId],
  );

  const selectTab = (next: Tab) => {
    if (next === 'review' && !activeScan && scans.length > 0) {
      setActiveId(latestId ?? scans[0].id);
    }
    setTab(next);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="shell header-inner">
          <div className="brand">
            <div className="brand-mark">SPM</div>
            <div>
              <div className="brand-title">Sheet Scanner</div>
              <div className="brand-sub">Fast local scoring · Sets A–E</div>
            </div>
          </div>
          <nav className="nav" aria-label="Primary">
            <button className={tab === 'scan' ? 'active' : ''} onClick={() => selectTab('scan')}>
              Scan
            </button>
            <button className={tab === 'review' ? 'active' : ''} onClick={() => selectTab('review')}>
              Review{scans.length > 0 ? ` (${scans.length})` : ''}
            </button>
            <button className={tab === 'key' ? 'active' : ''} onClick={() => selectTab('key')}>
              Key & settings
            </button>
          </nav>
          <div className="local-badge">
            <span className="dot" />
            100% local
          </div>
        </div>
      </header>

      <main className="main">
        <div className="shell">
          {tab === 'scan' && (
            <ScanView
              latestScan={latestScan}
              scans={scoredScans}
              queue={queue}
              busy={busy}
              settings={settings}
              onCapture={handleCapture}
              onFiles={handleFiles}
              onReview={handleReview}
              onRescan={handleRescan}
              onNext={handleNext}
              onSelectScan={handleReview}
              onAutoCaptureChange={(value) => setSettings((s) => ({ ...s, autoCapture: value }))}
            />
          )}
          {tab === 'review' && (
            <ReviewView
              scan={activeScan}
              answerKey={answerKey}
              onCorrect={handleCorrect}
              onBack={() => setTab('scan')}
              onNext={handleNext}
              onDelete={handleDelete}
              onExport={handleExportScan}
            />
          )}
          {tab === 'key' && (
            <KeyView
              answerKey={answerKey}
              settings={settings}
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
          <span>Pure-JS table detection + embedded MNIST CNN · no server requests</span>
          <span>No student identity · printed totals ignored</span>
        </div>
      </footer>

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

function rescoreThresholds(scan: ScanResult, settings: AppSettings): ScanResult['sets'] {
  const out = {} as ScanResult['sets'];
  for (const set of SET_IDS) {
    out[set] = {
      ...scan.sets[set],
      cells: scan.sets[set].cells.map((cell) => {
        if (cell.corrected || cell.state === 'blank' || cell.state === 'obstructed') return cell;
        if (cell.digit == null) return cell;
        const uncertain =
          cell.confidence < settings.confidenceThreshold || cell.margin < settings.marginThreshold;
        return uncertain ? { ...cell, state: 'uncertain' as const } : cell;
      }),
    };
  }
  return out;
}
