import { useState } from 'react';
import type { AnswerKey, ScanResult, SetId } from '../types';
import { unresolvedCells } from '../lib/scoring';

export function ConfirmationPanel({
  scan,
  answerKey,
  onCorrect,
}: {
  scan: ScanResult;
  answerKey: AnswerKey;
  onCorrect: (set: SetId, row: number, digit: number | null) => void;
}) {
  const pending = unresolvedCells(scan);
  const [index, setIndex] = useState(0);

  if (pending.length === 0) return null;

  const safeIndex = Math.min(index, pending.length - 1);
  const active = pending[safeIndex];
  const keyAnswer = answerKey[active.set][active.cell.row - 1];
  const remaining = pending.length;

  const choose = (digit: number | null) => {
    onCorrect(active.set, active.cell.row, digit);
    // The list shrinks after the parent applies the confirmation. Keep the
    // current position so the next unresolved cell moves into view. On the last
    // cell this component is about to unmount; avoid a redundant state update.
    if (remaining > 1) {
      setIndex((value) => Math.min(value, remaining - 2));
    }
  };

  return (
    <section className="card confirmation-card" aria-labelledby="confirmation-title">
      <div className="confirmation-head">
        <div>
          <div className="eyebrow">Needs confirmation</div>
          <h2 id="confirmation-title">Confirm each flagged answer</h2>
          <p>
            The scanner has processed all 60 cells. Its tentative reading is not used for these
            cells, and the final score stays locked until every one is confirmed.
          </p>
        </div>
        <div className="confirmation-count" aria-live="polite">
          <strong>{remaining}</strong>
          <span>{remaining === 1 ? 'answer left' : 'answers left'}</span>
        </div>
      </div>

      <div className="confirmation-progress" aria-hidden>
        <div
          className="confirmation-progress-fill"
          style={{ width: `${((safeIndex + 1) / remaining) * 100}%` }}
        />
      </div>

      <div className="confirmation-body">
        <div className="confirmation-crop-wrap">
          {active.cell.cropUrl ? (
            <img
              className="confirmation-crop"
              src={active.cell.cropUrl}
              alt={`Cropped answer cell for Set ${active.set}, row ${active.cell.row}`}
            />
          ) : (
            <div className="confirmation-crop-missing">
              Cell crop unavailable. Check the sheet before choosing.
            </div>
          )}
          <div className="confirmation-cell-label">
            Set {active.set} · Row {active.cell.row}
            <span>Key {keyAnswer}</span>
          </div>
        </div>

        <div className="confirmation-choose">
          <p className="confirmation-question">What is written in this cell?</p>
          <div className="digit-picker confirmation-picker">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((digit) => (
              <button
                key={digit}
                type="button"
                className={digit === keyAnswer ? 'key-match' : ''}
                onClick={() => choose(digit)}
              >
                {digit}
              </button>
            ))}
          </div>
          <div className="confirmation-actions">
            <button type="button" className="btn btn-ghost" onClick={() => choose(null)}>
              Mark blank
            </button>
            {remaining > 1 && (
              <button
                type="button"
                className="btn btn-sm btn-outline"
                onClick={() => setIndex((value) => (value + 1) % remaining)}
              >
                Skip for now
              </button>
            )}
          </div>
          <p className="confirmation-hint">
            Choose 1–8 or mark the cell blank. Your confirmation becomes the final answer for this
            cell; the scanner will not guess or silently accept its prediction.
          </p>
        </div>
      </div>

      <div className="confirmation-foot">
        <span>
          Reviewing {safeIndex + 1} of {remaining} unresolved cells
        </span>
        {remaining > 1 && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setIndex((value) => (value - 1 + remaining) % remaining)}
          >
            Previous
          </button>
        )}
      </div>
    </section>
  );
}
