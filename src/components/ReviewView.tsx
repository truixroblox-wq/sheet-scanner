import { useState } from 'react';
import type { AnswerKey, ScanResult, SetId } from '../types';
import { SET_IDS } from '../types';
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
}: {
  scan: ScanResult | null;
  answerKey: AnswerKey;
  onCorrect: (set: SetId, row: number, digit: number | null) => void;
  onBack: () => void;
  onNext: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const [picker, setPicker] = useState<PickerState | null>(null);

  if (!scan) {
    return (
      <div className="empty">
        <strong>No sheet selected</strong>
        Scan an answer sheet first, then review and correct any uncertain answers here.
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={onBack}>
            Go to scanner
          </button>
        </div>
      </div>
    );
  }

  const pickerCell = picker ? scan.sets[picker.set].cells.find((c) => c.row === picker.row) : null;
  const pickerKey = picker ? answerKey[picker.set][picker.row - 1] : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Review scan #{scan.scanNumber}</h1>
          <p className="page-sub">
            Click any answer to correct it. Scores update immediately. Amber cells are
            low-confidence; red cells are unreadable or obstructed. Printed totals on the sheet are
            never used.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={onBack}>
            Back to scanner
          </button>
          <button className="btn" onClick={onNext}>
            Next sheet
          </button>
          <button className="btn" onClick={onExport}>
            Export scan JSON
          </button>
          <button className="btn btn-danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>

      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <ScoreTiles scan={scan} />
        <div className="meta" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <span className="chip">{(scan.durationMs / 1000).toFixed(2)} s scan time</span>
          <span className="chip">Blank policy applied at scoring</span>
          <span className="chip">Red annotations ignored</span>
        </div>
      </section>

      <div className="answer-sets">
        {SET_IDS.map((set) => {
          const result = scan.sets[set];
          const key = answerKey[set];
          return (
            <section className="card set-card" key={set}>
              <div className="set-head">
                <span className="set-name">Set {set}</span>
                <span className="muted">
                  {result.blanks > 0 ? `${result.blanks} blank · ` : ''}
                  {result.obstructed > 0 ? `${result.obstructed} obstructed · ` : ''}
                  {result.answered}/12 read
                </span>
                <span className="set-score">
                  {result.score}/{result.denominator}
                </span>
              </div>
              <div className="answer-grid">
                {result.cells.map((cell) => {
                  const expected = key[cell.row - 1];
                  const correct = cell.digit != null && cell.digit === expected;
                  const wrong = cell.digit != null && cell.digit !== expected;
                  const classes = ['answer-cell'];
                  if (correct) classes.push('correct');
                  if (wrong) classes.push('wrong');
                  if (cell.state === 'uncertain') classes.push('uncertain');
                  if (cell.state === 'obstructed') classes.push('obstructed');
                  if (cell.corrected) classes.push('corrected');
                  const display =
                    cell.state === 'obstructed' ? '?' : cell.digit == null ? '–' : String(cell.digit);
                  return (
                    <button
                      className={classes.join(' ')}
                      key={cell.row}
                      onClick={() => setPicker({ set, row: cell.row })}
                      title={
                        cell.state === 'obstructed'
                          ? 'Answer could not be read — tap to set it'
                          : `Confidence ${(cell.confidence * 100).toFixed(0)}% · tap to correct`
                      }
                    >
                      {cell.state === 'uncertain' && (
                        <span className="flag" aria-label="Low confidence">
                          !
                        </span>
                      )}
                      {cell.state === 'obstructed' && (
                        <span className="flag" aria-label="Obstructed">
                          ×
                        </span>
                      )}
                      <div className="row">{cell.row}</div>
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
            aria-label={`Correct set ${picker.set} row ${picker.row}`}
            onClick={(event) => event.stopPropagation()}
          >
            <h3>
              Set {picker.set}, row {picker.row}
            </h3>
            <p className="muted" style={{ margin: 0 }}>
              Key answer: <strong style={{ color: 'var(--good)' }}>{pickerKey}</strong>. Current
              reading: {pickerCell?.digit ?? 'blank'} ({(pickerCell?.confidence ?? 0) * 100 | 0}%
              confidence).
            </p>
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
