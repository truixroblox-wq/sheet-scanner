import { useState } from 'react';
import type { AnswerKey, ScanResult, SetId } from '../types';
import { SET_IDS } from '../types';
import { cellNeedsConfirmation, countUnresolved } from '../lib/scoring';
import { ScoreTiles } from './ScoreTiles';

interface PickerState {
  set: SetId;
  row: number;
}

export function ReviewView({
  scan,
  answerKey,
  onCorrect,
  onBack,
  onNext,
  onDelete,
  onExport,
  embedded = false,
}: {
  scan: ScanResult | null;
  answerKey: AnswerKey;
  onCorrect: (set: SetId, row: number, digit: number | null) => void;
  onBack?: () => void;
  onNext?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  embedded?: boolean;
}) {
  const [picker, setPicker] = useState<PickerState | null>(null);

  if (!scan) {
    if (embedded) return null;
    return (
      <div className="empty">
        <strong>No sheet selected</strong>
        Scan an answer sheet first, then review and correct any uncertain answers here.
        {onBack && (
          <div className="empty-action">
            <button className="btn btn-primary" onClick={onBack}>
              Go to scanner
            </button>
          </div>
        )}
      </div>
    );
  }

  const pending = countUnresolved(scan);
  const pickerCell = picker ? scan.sets[picker.set].cells.find((c) => c.row === picker.row) : null;
  const pickerKey = picker ? answerKey[picker.set][picker.row - 1] : null;
  const pickerNeedsConfirmation = pickerCell ? cellNeedsConfirmation(pickerCell) : false;

  return (
    <div>
      {!embedded && (
        <>
          <div className="page-head">
            <div>
              <h1 className="page-title">Review sheet #{scan.scanNumber}</h1>
              <p className="page-sub">
                Click any answer to confirm or correct it. Amber cells need confirmation and red
                cells were unreadable. Set scores and the total stay hidden until every unresolved
                answer is confirmed. Printed totals on the sheet are never used.
              </p>
            </div>
            <div className="page-actions">
              {onBack && (
                <button className="btn btn-ghost" onClick={onBack}>
                  Back to scanner
                </button>
              )}
              {onNext && (
                <button className="btn" onClick={onNext}>
                  Next sheet
                </button>
              )}
              {onExport && (
                <button className="btn" onClick={onExport}>
                  Export scan JSON
                </button>
              )}
              {onDelete && (
                <button className="btn btn-danger" onClick={onDelete}>
                  Delete
                </button>
              )}
            </div>
          </div>

          <section className="card card-pad review-score-card">
            <ScoreTiles scan={scan} pending={pending > 0} />
            <div className="meta review-meta">
              <span className="chip">{(scan.durationMs / 1000).toFixed(2)} s scan time</span>
              <span className="chip">Blank policy applied at scoring</span>
              <span className="chip">Red annotations ignored</span>
            </div>
          </section>
        </>
      )}

      {embedded && (
        <div className="review-toolbar">
          <span className="muted">
            Tap any answer to confirm it. Amber = needs confirmation, red = unreadable. Scores stay
            locked until every unresolved cell is reviewed.
          </span>
          <div className="review-tools">
            {onExport && (
              <button
                className="btn btn-sm btn-outline"
                onClick={onExport}
                disabled={pending > 0}
                title={
                  pending > 0
                    ? 'Confirm every unresolved answer before exporting the final score.'
                    : undefined
                }
              >
                Export
              </button>
            )}
            {onDelete && (
              <button className="btn btn-sm btn-danger" onClick={onDelete}>
                Delete result
              </button>
            )}
          </div>
        </div>
      )}

      <div className="answer-sets">
        {SET_IDS.map((set) => {
          const result = scan.sets[set];
          const key = answerKey[set];
          const setPending = result.cells.filter(cellNeedsConfirmation).length;
          return (
            <section className="card set-card" key={set}>
              <div className="set-head">
                <span className="set-name">Set {set}</span>
                <span className="muted">
                  {setPending > 0 ? `${setPending} need confirmation · ` : ''}
                  {result.blanks > 0 ? `${result.blanks} blank · ` : ''}
                  {result.obstructed > 0 ? `${result.obstructed} unreadable · ` : ''}
                  {result.answered}/12 read
                </span>
                <span className={`set-score ${setPending > 0 ? 'pending' : ''}`}>
                  {setPending > 0 ? 'Score locked' : `${result.score}/12`}
                  {setPending === 0 && result.denominator !== 12 && (
                    <small className="set-adjusted">max {result.denominator}</small>
                  )}
                </span>
              </div>
              <div className="answer-grid">
                {result.cells.map((cell) => {
                  const expected = key[cell.row - 1];
                  const needsConfirmation = cellNeedsConfirmation(cell);
                  const confirmed = Boolean(cell.confirmed || cell.corrected);
                  const correct =
                    !needsConfirmation && cell.digit != null && cell.digit === expected;
                  const wrong =
                    !needsConfirmation && cell.digit != null && cell.digit !== expected;
                  const classes = ['answer-cell'];
                  if (correct) classes.push('correct');
                  if (wrong) classes.push('wrong');
                  if (needsConfirmation) classes.push('pending');
                  if (cell.state === 'uncertain') classes.push('uncertain');
                  if (cell.state === 'obstructed') classes.push('obstructed');
                  if (confirmed) classes.push('confirmed');
                  const display = needsConfirmation
                    ? '?'
                    : cell.digit == null
                      ? '–'
                      : String(cell.digit);
                  return (
                    <button
                      className={classes.join(' ')}
                      key={cell.row}
                      onClick={() => setPicker({ set, row: cell.row })}
                      title={
                        needsConfirmation
                          ? 'Needs confirmation — tap to choose 1–8 or mark blank'
                          : `Reading ${cell.digit ?? 'blank'} · tap to correct`
                      }
                    >
                      {needsConfirmation && (
                        <span className="flag" aria-label="Needs confirmation">
                          !
                        </span>
                      )}
                      <div className="row">{cell.row}</div>
                      {needsConfirmation && cell.cropUrl && (
                        <img
                          className="answer-crop"
                          src={cell.cropUrl}
                          alt=""
                          aria-hidden="true"
                        />
                      )}
                      <div className="digit">{display}</div>
                      <div className="key">key {expected}</div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {picker && (
        <div className="modal-backdrop" onClick={() => setPicker(null)} role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Confirm or correct set ${picker.set} row ${picker.row}`}
            onClick={(event) => event.stopPropagation()}
          >
            <h3>
              Set {picker.set}, row {picker.row}
            </h3>
            {pickerNeedsConfirmation ? (
              <p className="muted modal-copy">
                This answer needs confirmation. The scanner's tentative prediction is not used.
                Choose the digit visible in the crop, or mark the cell blank. Key answer:{' '}
                <strong className="good-text">{pickerKey}</strong>.
              </p>
            ) : (
              <p className="muted modal-copy">
                Key answer: <strong className="good-text">{pickerKey}</strong>. Current reading:{' '}
                {pickerCell?.digit ?? 'blank'} (
                {Math.round((pickerCell?.confidence ?? 0) * 100)}% confidence).
              </p>
            )}
            {pickerCell?.cropUrl && (
              <div className="modal-crop-wrap">
                <img
                  className="modal-crop"
                  src={pickerCell.cropUrl}
                  alt={`Cropped answer cell for Set ${picker.set}, row ${picker.row}`}
                />
              </div>
            )}
            <div className="digit-picker">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((digit) => (
                <button
                  key={digit}
                  className={digit === pickerKey ? 'key-match' : ''}
                  onClick={() => {
                    onCorrect(picker.set, picker.row, digit);
                    setPicker(null);
                  }}
                >
                  {digit}
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  onCorrect(picker.set, picker.row, null);
                  setPicker(null);
                }}
              >
                Mark blank
              </button>
              <button className="btn" onClick={() => setPicker(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
