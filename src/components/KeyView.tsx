import { useRef } from 'react';
import type { AnswerKey, AppSettings, BlankPolicy, SetId } from '../types';
import { SET_IDS } from '../types';
import { blankPolicyLabel } from '../lib/scoring';
import {
  VALIDATED_CONFIDENCE_THRESHOLD,
  VALIDATED_MARGIN_THRESHOLD,
} from '../lib/config';

export function KeyView({
  answerKey,
  settings,
  onBack,
  onChange,
  onReset,
  onImport,
  onExport,
  onSettingsChange,
}: {
  answerKey: AnswerKey;
  settings: AppSettings;
  onBack?: () => void;
  onChange: (set: SetId, index: number, value: number) => void;
  onReset: () => void;
  onImport: (file: File) => void;
  onExport: () => void;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  const policies: BlankPolicy[] = ['wrong', 'unanswered', 'review'];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Answer key & settings</h1>
          <p className="page-sub">
            The key is configuration, never hard-coded recognition logic. Changes rescore every
            scanned sheet immediately. Only digits 1–8 are accepted for Sets A–E.
          </p>
        </div>
        <div className="page-actions">
          {onBack && (
            <button className="btn btn-ghost" onClick={onBack}>
              Back to scanner
            </button>
          )}
          <button className="btn btn-ghost" onClick={onExport}>
            Export key
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Import key
          </button>
          <button className="btn btn-danger" onClick={onReset}>
            Reset to initial key
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImport(file);
              event.target.value = '';
            }}
          />
        </div>
      </div>

      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ padding: '0 0 12px', borderBottom: 0 }}>
          <h2>Key</h2>
          <span className="muted">12 questions per set</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="key-table">
            <thead>
              <tr>
                <th />
                {Array.from({ length: 12 }, (_, i) => (
                  <th key={i}>{i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SET_IDS.map((set) => (
                <tr key={set}>
                  <td>{set}</td>
                  {answerKey[set].map((value, index) => (
                    <td key={index}>
                      <input
                        className={`key-input ${Number.isInteger(value) && value >= 1 && value <= 8 ? '' : 'invalid'}`}
                        inputMode="numeric"
                        min={1}
                        max={8}
                        type="number"
                        value={Number.isFinite(value) ? value : ''}
                        onFocus={(event) => event.target.select()}
                        onChange={(event) => {
                          const next = Number.parseInt(event.target.value, 10);
                          onChange(set, index, Number.isNaN(next) ? 0 : next);
                        }}
                        aria-label={`Set ${set} question ${index + 1}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Scanning & scoring</h2>
          <span className="muted">Stored locally in this browser</span>
        </div>
        <div className="card-pad settings">
          <div className="settings-row">
            <div className="grow">
              <strong>Blank answers</strong>
              <p>
                {blankPolicyLabel(settings.blankPolicy)}. The large Set scores always use /12 and
                the total uses /60; any blank-adjusted maximum is shown as a note on the result.
                Obstructed cells are never silently counted as wrong.
              </p>
            </div>
            <div className="segmented">
              {policies.map((policy) => (
                <button
                  key={policy}
                  className={settings.blankPolicy === policy ? 'active' : ''}
                  onClick={() => onSettingsChange({ blankPolicy: policy })}
                >
                  {policy === 'wrong' ? 'Count wrong' : policy === 'unanswered' ? 'Exclude' : 'Review'}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-validation">
            <strong>Validated confirmation gate</strong>
            <p>
              On the 60 hand-labeled reference cells, the{' '}
              {Math.round(VALIDATED_CONFIDENCE_THRESHOLD * 100)}% /{' '}
              {Math.round(VALIDATED_MARGIN_THRESHOLD * 100)}% gate auto-accepted 39 cells with zero
              misreads and left 21 to confirm, including all 7 misreads. The tiny-box safeguard can
              add one more review. A 95% confidence gate would silently accept one misread, so the
              default is deliberately not lower.
            </p>
            <button
              className="btn btn-sm btn-outline"
              onClick={() =>
                onSettingsChange({
                  confidenceThreshold: VALIDATED_CONFIDENCE_THRESHOLD,
                  marginThreshold: VALIDATED_MARGIN_THRESHOLD,
                })
              }
            >
              Use validated gate
            </button>
          </div>

          <div className="settings-row">
            <div className="grow">
              <strong>Confidence gate</strong>
              <p>
                Answers below {Math.round(settings.confidenceThreshold * 100)}% confidence need
                confirmation. They are never scored from the model's tentative digit.
              </p>
            </div>
            <input
              type="range"
              min={0.3}
              max={0.99}
              step={0.01}
              value={settings.confidenceThreshold}
              onChange={(event) =>
                onSettingsChange({ confidenceThreshold: Number(event.target.value) })
              }
            />
          </div>

          <div className="settings-row">
            <div className="grow">
              <strong>Confusion margin</strong>
              <p>
                Also flag when the gap between the top two digits is below{' '}
                {Math.round(settings.marginThreshold * 100)} percentage points.
              </p>
            </div>
            <input
              type="range"
              min={0.1}
              max={0.99}
              step={0.01}
              value={settings.marginThreshold}
              onChange={(event) => onSettingsChange({ marginThreshold: Number(event.target.value) })}
            />
          </div>

          <div className="settings-row">
            <div className="grow">
              <strong>Auto-capture</strong>
              <p>Capture automatically after the camera frame has been stable for about one second.</p>
            </div>
            <button
              className={`switch ${settings.autoCapture ? 'on' : ''}`}
              aria-label="Toggle auto-capture"
              aria-pressed={settings.autoCapture}
              onClick={() => onSettingsChange({ autoCapture: !settings.autoCapture })}
            />
          </div>

          <div className="settings-row">
            <div className="grow">
              <strong>Duplicate-sheet guard</strong>
              <p>Skip a file that perceptually matches another sheet in the same batch. A new scan starts a clean session, so intentional rescans are allowed.</p>
            </div>
            <button
              className={`switch ${settings.duplicateGuard ? 'on' : ''}`}
              aria-label="Toggle duplicate guard"
              aria-pressed={settings.duplicateGuard}
              onClick={() => onSettingsChange({ duplicateGuard: !settings.duplicateGuard })}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
