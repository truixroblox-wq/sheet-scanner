import type { ScanResult } from '../types';
import { SET_IDS } from '../types';
import { countUnresolved } from '../lib/scoring';
import { ScoreTiles } from './ScoreTiles';

export function ResultSummary({
  scan,
  onScanAnother,
  onExport,
}: {
  scan: ScanResult;
  onScanAnother: () => void;
  onExport: () => void;
}) {
  const pending = countUnresolved(scan);
  const uncertain = Object.values(scan.sets).reduce(
    (sum, set) => sum + set.cells.filter((cell) => cell.state === 'uncertain').length,
    0,
  );
  const obstructed = Object.values(scan.sets).reduce(
    (sum, set) => sum + set.cells.filter((cell) => cell.state === 'obstructed').length,
    0,
  );
  const blanks = Object.values(scan.sets).reduce((sum, set) => sum + set.blanks, 0);
  const sumOfSets = SET_IDS.reduce((sum, set) => sum + scan.sets[set].score, 0);
  const adjusted = scan.totalPossible !== 60;
  const totalMatches = sumOfSets === scan.total;

  if (pending > 0) {
    return (
      <section
        className="card result-card result-pending"
        aria-label={`Final score locked for sheet ${scan.scanNumber}; ${pending} answers need confirmation`}
      >
        <div className="result-top">
          <div>
            <div className="eyebrow">Final score</div>
            <div className="total-score locked" aria-label="Final score locked">
              <span>—</span>
              <small>/ 60</small>
            </div>
            <p className="result-caption">
              All 60 cells have been processed. The final score and set scores stay hidden until{' '}
              {pending} unresolved {pending === 1 ? 'answer is' : 'answers are'} confirmed.
            </p>
          </div>
          <div className="result-actions">
            <button className="btn btn-primary" onClick={onScanAnother}>
              Scan another sheet
            </button>
            <button
              className="btn btn-outline"
              onClick={onExport}
              disabled
              title="Confirm every unresolved answer before exporting the final score."
            >
              Export locked
            </button>
          </div>
        </div>

        <div className="result-meta">
          <span className="chip good">{(scan.durationMs / 1000).toFixed(2)} s</span>
          <span className="chip">Sheet #{scan.scanNumber}</span>
          <span className="chip warn">
            {pending} need confirmation
            {uncertain > 0 ? ` · ${uncertain} low confidence` : ''}
          </span>
          {obstructed > 0 && <span className="chip bad">{obstructed} unreadable</span>}
          {blanks > 0 && <span className="chip">{blanks} blank</span>}
        </div>

        <div className="score-section">
          <div className="locked-score-panel">
            <div className="locked-score-icon" aria-hidden>
              !
            </div>
            <div>
              <strong>Score locked until every answer is reviewed</strong>
              <p>
                Use the confirmation panel above to inspect each cropped answer cell and choose
                1–8 or blank. The scanner's tentative prediction is never used for an unresolved
                cell.
              </p>
            </div>
          </div>
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

  return (
    <section className="card result-card" aria-label={`Result for sheet ${scan.scanNumber}`}>
      <div className="result-top">
        <div>
          <div className="eyebrow">Total score</div>
          <div className="total-score" aria-label={`Total score ${scan.total} out of 60`}>
            <span>{scan.total}</span>
            <small>/ 60</small>
          </div>
          <p className="result-caption">
            Sum of Sets A–E. {totalMatches ? 'The total matches' : 'The total is recalculated from'}{' '}
            the five set scores and cannot exceed 60.
          </p>
        </div>
        <div className="result-actions">
          <button className="btn btn-primary" onClick={onScanAnother}>
            Scan another sheet
          </button>
          <button className="btn btn-outline" onClick={onExport}>
            Export result
          </button>
        </div>
      </div>

      <div className="result-meta">
        <span className="chip good">{(scan.durationMs / 1000).toFixed(2)} s</span>
        <span className="chip">Sheet #{scan.scanNumber}</span>
        {blanks > 0 && <span className="chip">{blanks} blank</span>}
        <span className="chip good">All unresolved answers confirmed</span>
      </div>

      <div className="score-section">
        <ScoreTiles scan={scan} />
        {adjusted && (
          <p className="score-note">
            Blank-excluded maximum for this sheet: {scan.totalPossible}/60. The main scores remain
            out of 12 per set and 60 in total.
          </p>
        )}
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
