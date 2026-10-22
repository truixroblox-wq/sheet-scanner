import type { ScanResult } from '../types';
import { ScoreTiles } from './ScoreTiles';

export function ResultSummary({
  scan,
  onReview,
  onRescan,
  onNext,
}: {
  scan: ScanResult;
  onReview: () => void;
  onRescan: () => void;
  onNext: () => void;
}) {
  const uncertain = Object.values(scan.sets).reduce(
    (sum, set) => sum + set.cells.filter((c) => c.state === 'uncertain').length,
    0,
  );
  const obstructed = Object.values(scan.sets).reduce(
    (sum, set) => sum + set.cells.filter((c) => c.state === 'obstructed').length,
    0,
  );
  const blanks = Object.values(scan.sets).reduce((sum, set) => sum + set.blanks, 0);

  return (
    <section className="card" aria-label={`Scan ${scan.scanNumber} result`}>
      <div className="result-hero">
        <div>
          <div className="tiny">Scan #{scan.scanNumber}</div>
          <h2>
            {scan.total} <span style={{ color: 'var(--muted)', fontSize: '0.55em' }}>/ {scan.totalPossible}</span>
          </h2>
          <div className="meta">
            <span className="chip good">{(scan.durationMs / 1000).toFixed(2)} s</span>
            {uncertain > 0 && <span className="chip warn">{uncertain} need review</span>}
            {obstructed > 0 && <span className="chip bad">{obstructed} obstructed</span>}
            {blanks > 0 && <span className="chip">{blanks} blank</span>}
            {uncertain === 0 && obstructed === 0 && blanks === 0 && (
              <span className="chip good">All answers read</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={onReview}>
            Review answers
          </button>
          <button className="btn" onClick={onRescan}>
            Rescan
          </button>
          <button className="btn btn-ghost" onClick={onNext}>
            Next sheet
          </button>
        </div>
      </div>
      <div className="card-pad" style={{ paddingTop: 0 }}>
        <ScoreTiles scan={scan} />
        {scan.quality.warnings.length > 0 && (
          <div className="quality-list">
            {scan.quality.warnings.map((warning) => (
              <div className="quality-item" key={warning}>
                <span aria-hidden>!</span>
                <span>{warning}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
