import type { ScanResult } from '../types';
import { SET_IDS } from '../types';

export function ScoreTiles({ scan, pending = false }: { scan: ScanResult; pending?: boolean }) {
  return (
    <div className="score-tiles" aria-label={pending ? 'Scores locked pending confirmation' : 'Scores by set'}>
      {SET_IDS.map((set) => {
        const result = scan.sets[set];
        return (
          <div className={`score-tile ${pending ? 'locked' : ''}`} key={set}>
            <div className="label">Set {set}</div>
            <div className="value">
              {pending ? '—' : result.score}
              <small>/12</small>
            </div>
            {!pending && result.denominator !== 12 && (
              <div className="score-adjusted">Blank-excluded max {result.denominator}/12</div>
            )}
            {pending && <div className="score-adjusted">Confirm answers to unlock</div>}
          </div>
        );
      })}
    </div>
  );
}
