# SPM Quick Score Scanner

A fast, fully local browser app for scoring Standard Progressive Matrices answer sheets. It reads the handwritten student column for Sets A–E (12 questions each), asks the teacher to confirm every uncertain cell, then scores it against an editable key and shows:

- **Set A–E scores out of 12**
- **A total out of 60**

Everything runs in the browser. There is no backend, account, student identity, analytics, or network request for recognition. Images, cropped answer cells, and scores never leave the device.

## What the app does

1. **Upload** one complete answer table per image. Drag-and-drop, a single-file picker, and multi-file batch upload are supported. There is no live camera, camera permission, or capture panel.
2. **Read the student column locally.** The scanner detects the table, corrects perspective, aligns the printed grid, removes red ink, and recognizes handwritten digits 1–8.
3. **Cross-check decisive readings against verified references.** A small HOG nearest-neighbour corpus built from hand-verified answer sheets acts as a second opinion. If it strongly disagrees with a confident CNN reading, or if a handwritten 7 contains an enclosed region, the cell is sent to review. The reference check never replaces the CNN digit.
4. **Confirm every uncertain answer.** Low-confidence, ambiguous, unreadable, and obstructed cells are marked **Needs confirmation**. A step-by-step panel shows the cropped answer cell and asks the teacher to choose 1–8 or mark it blank. The model's tentative digit is not displayed or used for those cells. When a sheet reaches zero unresolved cells, review automatically opens the next unresolved sheet in numeric order; if none remain, a clear completion banner is shown.
5. **Release the score only after review.** Set scores, the total, batch totals, and export stay locked until every unresolved answer has been confirmed. The optional full grid shows all 60 cells and also allows corrections.

The scan queue is collapsible with **Hide queue** / **Show queue**; hiding it never stops scanning or hides Batch Results. Queue entries and batch results are ordered by numeric scan number (`#2` before `#10`), and the order is preserved when more sheets are added. Starting a new individual scan or batch clears the previous session so scores from different sheets cannot be mixed accidentally. Batch files are still shown as separate results. Crops are kept in memory only; they are not written to local storage or exported.

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
- Duplicate-image guard

The upload card is the primary action. Both **Upload answer sheets** and **Batch upload** open the multi-file picker; a batch is processed as separate sheets and never merged into one score.

The confidence gate is deliberately strict. It was selected from real labeled cells, not tuned to maximize automatic acceptance; lowering it silently accepts known misreads. The settings panel includes a one-click reset to the validated gate.

Duplicate protection is scoped to one batch. Starting a new scan clears the session, so the same sheet can always be rescanned intentionally.

## Confirmation gate and validation

All 60 cells of `samples/reference-2.png` were hand-labeled from enlarged crops. The labels are in `samples/validation/reference-2-labels.json`; the contact sheets are in `samples/validation/`.

The recognition model makes **6 misreads** on those 60 cells: B10, C1, C4, E2, E10, and E12. The validated default gate uses:

- confidence **≥ 0.96**
- top-two margin **≥ 0.90**

With the 96% / 90% gate, **35 cells auto-accept with 0 misreads** and **25 cells go to confirmation**; all 6 misreads are in that group. The embedded reference check can add a few further reviews, but it never silently replaces a digit. Confirming the actual answers produces the hand-labeled **44/60**.

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
| Overall cell accuracy | 93.3% (44 wrong) | 93.3% (44 wrong) |
| Auto-accepted cells | 432 | 405 |
| Auto-accepted correct | 421 | 401 |
| Auto-accepted wrong | 11 | 4 |
| Auto-accepted precision | 97.5% | **99.0%** |
| Flagged for review | 228 (34.5%) | 255 (38.6%) |
| Confident errors caught | — | 7 of 11 |
| Correct auto cells added to review | — | 20 |
| Clean blank resolved | 1/1 | 1/1 |

Overall cell accuracy is unchanged by design: the second opinion flags, it does not guess a replacement. The improvement is in high-confidence precision: silent misreads drop from 11 to 4, at the cost of 20 additional correct reviews. The reference matching costs about **11 ms per sheet** in the validation harness; the full 11-sheet validation run takes about **5.3 s**.

The four remaining confident misreads are unusual 1/2/4/6 handwriting styles:

- 08 D12: 6 read as 2
- 08 E12: 1 read as 2
- 11 B12: 4 read as 6
- 11 D6: 4 read as 6

The corpus contains many 4 examples, but HOG still places these open-top or triangular 4s closer to 6, and a thin 1 closer to 2. They remain documented limitations rather than being silently overridden.

On `reference-2`, the model score is **41/60** with the reference check, and confirming the flagged cells produces the hand-labeled **44/60**. In the leave-one-sheet-out reference run, reference-2 moves from 35 to 32 auto-accepted cells and from 25 to 28 flagged cells, still with zero auto-accepted misreads and the same 41/60 model score.

Reproduce the reference metrics and write the per-cell predictions:

```powershell
npx.cmd tsx scripts/validate-reference-set-3.ts
```

## Student-set-1 import and held-out validation

All 64 accessible JPEGs supplied for the new student set were imported under `samples/student-set-1/` as `S001`–`S064`. The manifest records SHA-256, dimensions, quality, table detection, red-ink ratio, usability, and duplicate fingerprints. Results:

- **64 unique images** (no duplicate byte hashes); **all 64 tables detected**; all usable.
- `S013` is the printed official answer key and is **excluded** from handwritten labels and evaluation.
- The full originals are preserved separately. The review material uses anonymized, table-only crops. No student names or source filenames are written into the label or validation reports.
- Eight sheets (`S001`–`S008`) were hand-checked cell by cell: **479 clean labels** plus **one obstructed cell** (`S001-A6`) marked unknown, not guessed. The labels are in `samples/student-set-1/labels.json`.
- Development split: `S001`–`S004` (239 cells). Held-out test split: `S005`–`S008` (240 cells).

### Production result (default legacy grouping)

| Metric | All | Development | Held-out test |
| --- | ---: | ---: | ---: |
| Verified cells | 479 | 239 | 240 |
| Correct digit | 434 (90.6%) | 212 (88.7%) | 222 (92.5%) |
| Auto-accepted | 318 (66.4%) | 165 (69.0%) | 153 (63.7%) |
| Auto-accept precision | **99.1%** | 98.8% | **99.3%** |
| High-confidence errors | 3 | 2 | 1 |
| Gate-passing errors | 14 | 9 | 5 |

Per-digit accuracy: 1 87.1%, 2 91.3%, 3 87.7%, 4 87.1%, 5 95.3%, 6 96.8%, 7 95.1%, 8 83.8%. Per-set accuracy: A 89.5%, B 90.6%, C 88.5%, D 92.7%, E 91.7%. The dominant confusions are `7 -> 1/3/2` (18 cells), `2 -> 8` (4 cells), and `6 -> 4` (3 cells). The three high-confidence errors are `S003-C2` (7 vs 2), `S003-C9` (7 vs 1), and `S006-C12` (4 vs 2). `S004-A6` (5 vs 3) was fixed by the adaptive preprocessing threshold.

The table's 14 gate-passing errors are raw CNN readings that pass the 96% / 90% thresholds **before** the reference/hole second opinion. Eleven are converted to review by that check or the contrast-stretch safeguard, leaving the three auto-accepted errors shown above. This is why the auto-accept precision is 99.1% despite the lower raw digit accuracy. The remaining 160 uncertain cells (33.4%) plus one blank are routed to confirmation; the one blank decision is a clear handwritten 1 that the extractor missed (`S001-B3`), so it is counted as a recognition error rather than an unknown label.

### Degradation regression benchmark

The preprocessing path uses an adaptive ink threshold based on each cell's robust contrast peak, plus a reversible low-amplitude contrast stretch. The stretch is applied only to the working copy; the original crop remains the one shown for review. Cells that needed the stretch are deliberately flagged as uncertain rather than silently auto-accepted.

The same 479 hand-verified cells were transformed deterministically and re-read with the production pipeline:

| Condition | Correct digits |
| --- | ---: |
| Clean | 434/479 (90.6%) |
| Rotated +7° | 434/479 (90.6%) |
| Rotated −7° | 418/479 (87.3%) |
| Sheared 8% | 429/479 (89.6%) |
| Faint pencil (32% amplitude) | 425/479 (88.7%) |
| Blurred 3×3 | 431/479 (90.0%) |
| Low contrast (42%) | 435/479 (90.8%) |
| Shadow | 434/479 (90.6%) |
| Noise | 421/479 (87.9%) |

On the focused 60-cell held-out regression, the adaptive threshold improves faint digits from **37 to 56** and low-contrast digits from **45 to 56** compared with a fixed legacy threshold. `tests/degradation.test.ts` pins rotated, sheared, faint, blurred, and low-contrast minima, and also asserts that the adaptive path beats the fixed threshold on faint and low-contrast samples.

### Tested but rejected: merged split-stroke grouping

A second grouping mode was implemented and measured. It joins vertically split pen strokes (for example a 1 written in two parts):

| Metric | Legacy (production) | Merged experiment |
| --- | ---: | ---: |
| All correct | 434/479 (90.6%) | 433/479 (90.4%) |
| Held-out test | 222/240 (92.5%) | 221/240 (92.1%) |
| Auto-accept precision | 99.1% | 99.0% |
| High-confidence errors | 3 | 3 |

Merged grouping is **not used in production**. On the updated pipeline it no longer improves raw accuracy, adds two errors on `S006`, and does not improve auto-accept precision or the high-confidence error count. The option remains available for future data, but the scanner defaults to the legacy grouping. This decision is recorded in `samples/student-set-1/validation-report-merged-experiment.json`.

### Is 99% reached?

**No.** The measured production accuracy is **90.6% overall and 92.5% on held-out sheets**, about eight percentage points short of 99%. Reaching 99% on these 479 cells would mean at most 4 errors instead of 45. The remaining errors are genuine classifier failures (`7` vs `1/2/3`, `2` vs `8`, `4` vs `2`, and related handwriting shapes), not threshold mistakes. Lowering the confidence gate would only auto-accept more errors; it cannot improve digit accuracy. A credible path to 99% requires actual classifier adaptation or retraining and a much larger, more varied hand-labeled set from many writers. It is not achievable with threshold tuning or the current 479-cell evaluation alone.

The conservative gate still matters: auto-accepted readings are **99.1% correct overall and 99.3% correct on the held-out sheets**, while uncertain cells are sent to the teacher. The score remains locked until those cells are confirmed.

Reproduce the production and experimental reports:

```powershell
npx.cmd tsx scripts/validate-student-set.ts --mode legacy --side 0 --errors --json-out samples/student-set-1/validation-report-legacy.json
npx.cmd tsx scripts/validate-student-set.ts --mode merged --side 0 --errors --json-out samples/student-set-1/validation-report-merged-experiment.json
npx.cmd tsx scripts/benchmark-student-set.ts
```

## Recognition pipeline

The app keeps the existing dependency-free TypeScript pipeline:

1. Table detection and perspective rectification (`src/lib/vision/warp.ts`)
2. Printed-grid alignment and cell cropping (`src/lib/vision/grid.ts`)
3. Red-annotation removal, background subtraction, rule removal, adaptive contrast-peak thresholding, connected components, and MNIST-style normalisation (`src/lib/ocr/preprocess.ts`). Faint/low-contrast cells are stretched only on the working copy; the original crop remains available for review, and a stretched cell is forced to **Needs confirmation** even if the CNN is confident.
4. Embedded MNIST CNN inference (`src/lib/ocr/cnn.ts`), with repeated weights reused for every cell
5. Optional verified-reference second opinion (`src/lib/ocr/features.ts`, `src/lib/ocr/reference.ts`)
6. Local crop capture for review (`src/lib/image.ts`), kept as in-memory data URLs
7. Confirmation gating and scoring against the editable key (`src/lib/scoring.ts`)

Recognition is chunked between sets and yields to the browser, so the progress card repaints and the page stays responsive. The three-angle rotation ensemble is retained for ambiguous digits. When the base reading is already decisive, the extra rotations are skipped and the base pass is reused. This preserves the documented uncertain cells in the sample while substantially reducing recognition time.

## Performance

Measured on `samples/reference-2.png` with `scripts/benchmark-scan.ts` (Node, same machine, latest run):

| Phase | Before | After |
| --- | ---: | ---: |
| Detection | 48–76 ms | 48 ms |
| Rectification | 59–70 ms | 59 ms |
| Full pipeline benchmark | 609–611 ms | 268 ms |
| Recognition only | 456–457 ms | 133 ms |

Full student-set-1 benchmark over all **64 originals** (`scripts/benchmark-student-set.ts`, Node, same production stages, warm model/reference, decode included in the total):

- **64/64 tables detected**
- **Mean 430 ms/sheet; median 418 ms; p95 526 ms; min 348 ms; max 561 ms**
- Mean phases: detection 37 ms, rectification 51 ms, grid+crop 25 ms, recognition 99 ms; the rest is JPEG decode/resize in the Node harness
- Rectified-table validation (`scripts/validate-student-set.ts`) takes **301 ms mean / 296 ms median** for grid+crop and 60 recognitions
- Browser smoke test: a two-sheet batch completed with separate results; individual scans finished around **0.6 s** each in the queue.

Typical clean sheets are below one second, excluding one-time model/reference loading and the browser's own file decode. The 1 s target is met in the median/typical case, not as a hard guarantee for every batch item under browser contention.

Additional checks:

- `scripts/test-warp.ts`: recognition improved from 365–414 ms to 154–170 ms.
- `scripts/test-grid.ts` on the canonical warped sample: recognition improved from 393–476 ms to 196–203 ms.
- The reference second opinion adds about 11 ms per sheet in the validation harness.

The recognition pipeline returns **41/60** on the reference sample: A 12, B 10, C 6, D 9, E 4. The hand-labeled student answers are **44/60**: A 12, B 11, C 8, D 9, E 4. The confirmation flow exposes the difference: the three point-losing model errors (B10, C1, C4) are all sent to review, so confirming the actual answers produces 44/60. The 41/60 figure is a recognition result, not the student's true score.

Reproduce the benchmark with:

```powershell
npx.cmd tsx scripts/benchmark-scan.ts samples/reference-2.png
```

## Tests

The suite covers scoring invariants, blank policy, malformed keys, all five sets, permitted digits, blank/obstructed handling, red-annotation rejection, confirmation gating, confirmed-cell trust, crop preservation, rotated handwriting, duplicate-image protection, intentional rescans, HOG/hole features, the reference vote, the conservative flag rule, the embedded corpus, and reference integration. New coverage verifies merged split-stroke grouping, the 64-image import manifest, the hand-verified label shape, the S013 exclusion, the absence of camera APIs/components, and the upload-first UI with a multi-file picker. `tests/review.test.ts` covers numeric batch ordering, next-unresolved selection with wrap, and the all-reviewed completion state. `tests/degradation.test.ts` covers rotated, sheared, faint, blurred, and low-contrast labeled cells and verifies the adaptive threshold improvement.

`tests/reference.test.ts` covers descriptor shape, enclosed-region counting, nearest-reference voting, the flag threshold, and corpus loading. `tests/validation.test.ts` pins the reference-2 confirmation gate, the 41/60 model score, the 44/60 confirmed score, and the rule that the reference check flags without replacing the CNN digit. `tests/student-set.test.ts`, `tests/preprocess.test.ts`, and `tests/camera-removal.test.ts` cover the new import/label/UI guarantees.

The synthetic `samples/proto-warp.png` fixture is used for grid/layout regression only. Exact recognition accuracy is pinned on the hand-labeled `reference-2`, reference-set-3, and student-set-1 subsets; the synthetic warp is not a labeled accuracy set.

Current result:

- `npm.cmd run test`: **66 tests passed** across 11 files
- `npm.cmd run typecheck`: passed
- `npm.cmd run lint`: passed
- `npm.cmd run build`: passed
- Browser smoke test: hiding/showing the queue worked with Batch Results still visible, numeric order was `#1`–`#6`, resolving `#1` auto-opened `#2`, an incomplete `#2` did not navigate away, and the final sheet showed **All scanned sheets reviewed**.

The total is asserted to equal the sum of Sets A–E and to never exceed 60 in randomized sheets. The integration test confirms the sample remains 41/60 with the documented ambiguous cells still flagged; the validation test confirms the confirmation gate exposes all known misreads.

## Deploy to Netlify

This is a static Vite + React SPA. Netlify only needs to install dependencies, run the production build, and serve `dist`. There is no backend, Netlify Function, database, API key, or environment variable.

`netlify.toml` contains the expected settings:

- Build command: `npm run build`
- Publish directory: `dist`
- Node version: 22
- SPA fallback to `index.html`

The production bundle embeds the recognition model and the reference corpus, and requires no runtime download.

## Browser support and limitations

- There is no live camera. Answer sheets are uploaded through the file picker or drag-and-drop; batch upload is supported.
- Handwriting recognition is sensitive to severe blur, glare, shadows, very small writing, and heavily obstructed cells. Low-confidence, stretched, and obstructed cells are flagged rather than presented as certain.
- The 99% target was **not reached**. Production digit accuracy is 90.6% overall and 92.5% on the held-out student-set-1 sheets. Only 8 of the 64 imported images have hand-verified labels (479 clean cells); the other 56 were imported, quality-checked, and table-detected but are not part of the accuracy estimate.
- The reference check is conservative: it catches style disagreements it has seen before, but it cannot catch every confident error. Four unusual 1/2/4/6 cells remain in the 11-sheet reference-set-3 validation, and the new set still has three high-confidence errors (`S003-C2`, `S003-C9`, `S006-C12`).
- `S013` is the printed official answer key and is excluded. `S001-A6` is excluded as obstructed/unknown rather than guessed.
- Printed totals, teacher keys, and red annotations are ignored by design.
- A teacher key or an almost-empty sheet can look like a student sheet with many missing answers. The app shows a prominent warning in that case.
- A live Netlify deployment was not exercised in this environment; the production build and local preview were verified.
