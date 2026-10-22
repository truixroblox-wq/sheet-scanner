import { useRef } from 'react';
import type { AnswerKey, AppSettings, BlankPolicy, SetId } from '../types';
import { SET_IDS } from '../types';
import { blankPolicyLabel } from '../lib/scoring';

export function KeyView({
  answerKey,
  settings,
  onChange,
  onReset,
  onImport,
  onExport,
  onSettingsChange,
}: {
  answerKey: AnswerKey;
  settings: AppSettings;
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
              <p>{blankPolicyLabel(settings.blankPolicy)}. Obstructed cells are never silently counted as wrong.</p>
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

          <div className="settings-row">
            <div className="grow">
              <strong>Low-confidence threshold</strong>
              <p>
                Answers below {Math.round(settings.confidenceThreshold * 100)}% confidence are
                flagged for review. This does not change the score.
              </p>
            </div>
            <input
              type="range"
              min={0.3}
              max={0.95}
              step={0.05}
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
                Flag when the top two digits are within {Math.round(settings.marginThreshold * 100)}%
                of each other.
              </p>
            </div>
            <input
              type="range"
              min={0.1}
              max={0.8}
              step={0.05}
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
              <p>Skip a capture that perceptually matches a sheet already in this session.</p>
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
