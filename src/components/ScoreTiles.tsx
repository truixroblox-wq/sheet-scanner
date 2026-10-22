import type { ScanResult } from '../types';
import { SET_IDS } from '../types';

export function ScoreTiles({ scan }: { scan: ScanResult }) {
  return (
    <div className="score-tiles" aria-label="Scores by set and total">
      {SET_IDS.map((set) => {
        const result = scan.sets[set];
        return (
          <div className="score-tile" key={set}>
            <div className="label">Set {set}</div>
            <div className="value">
              {result.score}
              <small>/{result.denominator}</small>
            </div>
          </div>
        );
      })}
      <div className="score-tile total">
        <div className="label">Total</div>
        <div className="value">
          {scan.total}
          <small>/{scan.totalPossible}</small>
        </div>
      </div>
    </div>
  );
}
