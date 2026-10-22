# SPM Quick Score Scanner

A fast, fully local browser app for scoring Standard Progressive Matrices answer sheets. It reads the handwritten student column for Sets A–E (12 questions each), asks the teacher to confirm every uncertain cell, then scores it against an editable key and shows:

- **Set A–E scores out of 12**
- **A total out of 60**

Everything runs in the browser. There is no backend, account, student identity, analytics, or network request for recognition. Images, cropped answer cells, and scores never leave the device.

## What the app does

1. **Capture or upload** one complete answer table per image. The camera uses the rear camera where available; drag-and-drop and batch upload are also supported.
2. **Read the student column locally.** The scanner detects the table, corrects perspective, aligns the printed grid, removes red ink, and recognizes handwritten digits 1–8.
3. **Cross-check decisive readings against verified references.** A small HOG nearest-neighbour corpus built from hand-verified answer sheets acts as a second opinion. If it strongly disagrees with a confident CNN reading, or if a handwritten 7 contains an enclosed region, the cell is sent to review. The reference check never replaces the CNN digit.
4. **Confirm every uncertain answer.** Low-confidence, ambiguous, unreadable, and obstructed cells are marked **Needs confirmation**. A step-by-step panel shows the cropped answer cell and asks the teacher to choose 1–8 or mark it blank. The model's tentative digit is not displayed or used for those cells.
5. **Release the score only after review.** Set scores, the total, batch totals, and export stay locked until every unresolved answer has been confirmed. The optional full grid shows all 60 cells and also allows corrections.

Starting a new individual scan or batch clears the previous session so scores from different sheets cannot be mixed accidentally. Batch files are still shown as separate results. Crops are kept in memory only; they are not written to local storage or exported.

## Quick start

Requires Node.js 20.19+ (or 22.12+) and npm.

```powershell
npm.cmd install
npm.cmd run dev
```

Open the printed local URL (normally `http://127.0.0.1:5173`). Use `npm.cmd` on Windows PowerShell if script execution policy blocks `npm.ps1`.

Other commands:

```powershell
npm.cmd run test                    # unit + integration tests
npm.cmd run typecheck               # TypeScript
npm.cmd run lint                    # ESLint
npm.cmd run build                   # typecheck + production bundle
npm.cmd run preview                 # preview the production build
npm.cmd run generate:reference-corpus  # rebuild the verified HOG corpus
```

`generate:reference-corpus` reads the hand-verified labels under `samples/validation/` and rewrites the generated `src/lib/ocr/reference-corpus.ts`. Do not edit that file by hand.

## Scoring and blank policy

The answer key is data, not recognition logic. It is editable in **Answer key & settings**, persists in local storage, and can be exported or imported as JSON. Changes rescore every scanned sheet immediately.

The main result always uses the standard maxima: `/12` per set and `/60` in total. If the blank policy is changed to **Exclude**, the scanner also shows a blank-adjusted maximum as a note; the large scores remain out of 12 and 60. Obstructed cells are never silently counted as wrong.

The settings panel also exposes:

- Confidence gate: **96% validated default**
- Confusion-margin gate: **90% validated default**
- Auto-capture
- Duplicate-image guard

The confidence gate is deliberately strict. It was selected from real labeled cells, not tuned to maximize automatic acceptance; lowering it silently accepts known misreads. The settings panel includes a one-click reset to the validated gate.

Duplicate protection is scoped to one batch. Starting a new scan clears the session, so the same sheet can always be rescanned intentionally.

## Confirmation gate and validation

All 60 cells of `samples/reference-2.png` were hand-labeled from enlarged crops. The labels are in `samples/validation/reference-2-labels.json`; the contact sheets are in `samples/validation/`.

The recognition model makes **7 misreads** on those 60 cells: B10, C1, C4, D5, E2, E10, and E12. The validated default gate uses:

- confidence **≥ 0.96**
- top-two margin **≥ 0.90**

With the 96% / 90% gate, **39 cells auto-accept with 0 misreads** and **21 cells go to confirmation**; all 7 misreads are in that group. The tiny-box safeguard can add one more review: the full Node crop pipeline flags B5 as well, producing **38 auto-accepted / 22 to confirm**. On the browser preview, B5's border box is just over the tiny cutoff, so the app shows 39 / 21. The difference is one extra review, never a silent error.

A 95% confidence gate was rejected: it would silently accept C1, an actual 8 misread as 7 at 95.3% confidence. The 96% gate is the lowest round confidence setting that produced zero auto-accepted errors on the labeled set.

Reproduce the sweep:

```powershell
npx.cmd tsx scripts/validate-thresholds.ts samples/reference-2.png samples/validation/reference-2-labels.json
```

This is a small validation set from one real sheet, not a statistical guarantee across all handwriting. It supports the conservative default; it does not prove that every possible sheet will have zero silent errors.

## Verified reference sheets and second opinion

Eleven additional answer sheets were uploaded, recovered byte-for-byte, and saved under `samples/reference-set-3/`. Every one of the 660 cells was manually checked against enlarged contact sheets. The ground truth is in `samples/validation/reference-set-3/labels.json`; one cell (sheet 03, C8) is a genuine blank.

The original `samples/reference-2.png` and the official answer key are unchanged. The new sheets are additive references, not replacements.

### Embedded corpus

`src/lib/ocr/reference-corpus.ts` contains **719 verified cells**:

- 660 cells from the 11 new sheets, minus the one verified blank
- 60 hand-labeled cells from `reference-2`
- 324 HOG dimensions per cell, quantized to uint8
- 227 KiB of raw feature bytes, 311,803 bytes of generated TypeScript
- SHA-256 `9a3b339aca15bc2449999d9bff824962be1a6f1cab139666d7b9f79bec285c66`

`src/lib/ocr/reference.ts` decodes the corpus lazily. The corpus provenance and per-sheet counts are in `samples/validation/reference-set-3/reference-corpus-manifest.json`.

### Rule

For an already confident CNN reading, the scanner computes a HOG descriptor for the same normalized 28×28 cell and performs a three-neighbour weighted vote over the verified corpus. It flags the cell when either condition holds:

- the reference vote disagrees with the CNN digit at reference confidence **≥ 0.50**, or
- the CNN reads **7** and the normalized cell contains at least one enclosed background region (a common 4-written-like-7 shape).

The reference check only changes the cell state to `uncertain`. It does not overwrite the digit, so the teacher still sees the crop and makes the final decision.

### Leave-one-sheet-out results

The 11 new sheets were evaluated as a leave-one-sheet-out validation set: when scoring a sheet, that sheet's cells are excluded from the reference corpus. The original reference-2 cells remain available.

| Metric | CNN only | CNN + reference check |
| --- | ---: | ---: |
| Cells | 660 | 660 |
| Overall cell accuracy | 92.0% (53 wrong) | 92.0% (53 wrong) |
| Auto-accepted cells | 452 | 419 |
| Auto-accepted correct | 437 | 415 |
| Auto-accepted wrong | 15 | 4 |
| Auto-accepted precision | 96.7% | **99.0%** |
| Flagged for review | 208 (31.5%) | 241 (36.5%) |
| Confident errors caught | — | 11 of 15 |
| Correct auto cells added to review | — | 22 |
| Clean blank resolved | 1/1 | 1/1 |

Overall cell accuracy is unchanged by design: the second opinion flags, it does not guess a replacement. The improvement is in high-confidence precision: silent misreads drop from 15 to 4, at the cost of 22 additional reviews. The reference matching costs about **11 ms per sheet** in the validation harness; the full 11-sheet validation run takes about **5.0 s**.

The four remaining confident misreads are unusual 4/6/7 handwriting styles:

- 08 D12: 6 read as 2
- 11 B12: 4 read as 6
- 11 C9: 4 read as 7
- 11 D6: 4 read as 6

The corpus contains many 4 examples, but HOG still places these open-top or triangular 4s closer to 6/7. They remain documented limitations rather than being silently overridden.

On `reference-2`, the model score remains **40/60** with the reference check, and confirming the 21 flagged cells produces the hand-labeled **44/60**. With the full embedded corpus (which includes the reference-2 cells themselves), the browser preview still shows 21 unresolved cells. In the stricter leave-one-sheet-out run, reference-2 moves from 38 to 37 auto-accepted cells and from 22 to 23 flagged cells, still with zero auto-accepted misreads and the same 40/60 model score.

Reproduce the reference metrics and write the per-cell predictions:

```powershell
npx.cmd tsx scripts/validate-reference-set-3.ts
```

## Recognition pipeline

The app keeps the existing dependency-free TypeScript pipeline:

1. Table detection and perspective rectification (`src/lib/vision/warp.ts`)
2. Printed-grid alignment and cell cropping (`src/lib/vision/grid.ts`)
3. Red-annotation removal, background subtraction, rule removal, connected components, and MNIST-style normalisation (`src/lib/ocr/preprocess.ts`)
4. Embedded MNIST CNN inference (`src/lib/ocr/cnn.ts`), with repeated weights reused for every cell
5. Optional verified-reference second opinion (`src/lib/ocr/features.ts`, `src/lib/ocr/reference.ts`)
6. Local crop capture for review (`src/lib/image.ts`), kept as in-memory data URLs
7. Confirmation gating and scoring against the editable key (`src/lib/scoring.ts`)

Recognition is chunked between sets and yields to the browser, so the progress card repaints and the page stays responsive. The three-angle rotation ensemble is retained for ambiguous digits. When the base reading is already decisive, the extra rotations are skipped and the base pass is reused. This preserves the documented uncertain cells in the sample while substantially reducing recognition time.

## Performance

Measured on `samples/reference-2.png` with `scripts/benchmark-scan.ts` (Node, same machine, three runs):

| Phase | Before | After |
| --- | ---: | ---: |
| Detection | 48–76 ms | 49–57 ms |
| Rectification | 59–70 ms | 58–59 ms |
| Full pipeline benchmark | 609–611 ms | 286–321 ms |
| Recognition only | 456–457 ms | 146–169 ms |

Additional checks:

- `scripts/test-warp.ts`: recognition improved from 365–414 ms to 154–170 ms.
- `scripts/test-grid.ts` on the canonical warped sample: recognition improved from 393–476 ms to 196–203 ms.
- The reference second opinion adds about 11 ms per sheet in the validation harness.
- Browser production preview: the reference-2 scan with the reference check completed in **0.62 s** and showed 21 cells to confirm.

The untouched recognition pipeline returns **40/60** on the reference sample: A 12, B 10, C 6, D 8, E 4. The hand-labeled student answers are **44/60**: A 12, B 11, C 8, D 9, E 4. The confirmation flow exposes the difference: the four point-losing model errors (B10, C1, C4, D5) are all sent to review, so confirming the actual answers produces 44/60. The 40/60 figure is a recognition result, not the student's true score.

Reproduce the benchmark with:

```powershell
npx.cmd tsx scripts/benchmark-scan.ts samples/reference-2.png
```

## Tests

The suite covers scoring invariants, blank policy, malformed keys, all five sets, permitted digits, blank/obstructed handling, red-annotation rejection, confirmation gating, confirmed-cell trust, crop preservation, rotated handwriting, duplicate-image protection, intentional rescans, HOG/hole features, the reference vote, the conservative flag rule, the embedded corpus, and reference integration.

`tests/reference.test.ts` covers descriptor shape, enclosed-region counting, nearest-reference voting, the flag threshold, and corpus loading. `tests/validation.test.ts` pins the reference-2 confirmation gate, the 40/60 model score, the 44/60 confirmed score, and the rule that the reference check flags without replacing the CNN digit.

The synthetic `samples/proto-warp.png` fixture is used for grid/layout regression only. Exact recognition accuracy is pinned on the hand-labeled `reference-2` and reference-set-3 sheets; the synthetic warp is not a labeled accuracy set.

Current result:

- `npm.cmd run test`: **52 tests passed** across 6 files
- `npm.cmd run typecheck`: passed
- `npm.cmd run lint`: passed
- `npm.cmd run build`: passed

The total is asserted to equal the sum of Sets A–E and to never exceed 60 in randomized sheets. The integration test confirms the untouched sample remains 40/60 with the documented ambiguous cells still flagged; the validation test confirms the confirmation gate exposes all known misreads.

## Deploy to Netlify

This is a static Vite + React SPA. Netlify only needs to install dependencies, run the production build, and serve `dist`. There is no backend, Netlify Function, database, API key, or environment variable.

`netlify.toml` contains the expected settings:

- Build command: `npm run build`
- Publish directory: `dist`
- Node version: 22
- SPA fallback to `index.html`

The production bundle embeds the recognition model and the reference corpus, and requires no runtime download.

## Browser support and limitations

- Camera access requires HTTPS or localhost. Over plain HTTP the app explains the limitation and recommends image upload.
- Handwriting recognition is sensitive to severe blur, glare, shadows, very small writing, and heavily obstructed cells. Low-confidence and obstructed cells are flagged rather than presented as certain.
- The reference check is conservative: it catches style disagreements it has seen before, but it cannot catch every confident error. Four unusual 4/6/7 cells remain in the 11-sheet validation set.
- Printed totals, teacher keys, and red annotations are ignored by design.
- A teacher key or an almost-empty sheet can look like a student sheet with many missing answers. The app shows a prominent warning in that case.
- Physical camera behavior and a live Netlify deployment were not exercised in this environment; the production build was verified locally.
