# SPM Sheet Scanner

A fast, fully local browser app for scoring Standard Progressive Matrices answer sheets. It reads the handwritten student column for Sets A–E (12 questions each), scores it against an editable key, and shows only the set scores and total out of 60.

Everything runs in the browser. There is no backend, no account, no student identity, and no network request for recognition.

## Quick start

Requires Node.js 20.19+ (or 22.12+) and npm.

```powershell
npm.cmd install
npm.cmd run dev
```

Open the printed local URL (normally `http://127.0.0.1:5173`). Use `npm.cmd` on Windows PowerShell if script execution policy blocks `npm.ps1`.

Other commands:

```powershell
npm.cmd run test       # unit + integration tests
npm.cmd run typecheck  # TypeScript
npm.cmd run lint       # ESLint
npm.cmd run build      # typecheck + production bundle
npm.cmd run preview    # preview the production build
```

## Deploy to Netlify

This is a static Vite + React SPA. Netlify needs only to install dependencies, run the
production build, and serve `dist`. There is no backend, Netlify Function, database, API key, or
environment variable. Recognition runs in the browser and no model or worker file is downloaded at
runtime.

### Netlify settings

| Setting | Value |
| --- | --- |
| Base directory | repository root (leave blank) |
| Build command | `npm run build` |
| Publish directory | `dist` |
| Node.js version | `22` (set by `netlify.toml` as `NODE_VERSION = "22"`) |
| Environment variables | none |
| Functions / serverless | none |

The committed `netlify.toml` contains these settings. It also adds a single-page-app fallback
(`/*` → `/index.html`, status 200) so an unmatched path or refresh serves the app entry; Vite's
hashed assets are still served directly. Vite 7 requires Node.js 20.19+ or 22.12+; Netlify's Node
22 release satisfies that.

### Deploy from GitHub

1. Put this folder in a GitHub repository if it is not already one:

   ```powershell
   git init
   git add .
   git commit -m "Prepare SPM Sheet Scanner for Netlify"
   git branch -M main
   git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
   git push -u origin main
   ```

2. In Netlify, choose **Add new site** → **Import an existing project** → **GitHub**, then select the
   repository.
3. Confirm the build settings. `netlify.toml` supplies the command and publish directory, so the
   defaults should show:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Base directory: leave empty
4. Do not add environment variables. Deploy the site.
5. Open the generated HTTPS URL (`https://NAME.netlify.app`). Netlify provisions TLS
   automatically, which is required for camera access. A custom domain must also use HTTPS.

### Deploy with the Netlify CLI

```powershell
npx.cmd netlify-cli login
npx.cmd netlify-cli init
npx.cmd netlify-cli deploy --prod
```

`netlify init` links the folder to a Netlify site and can read the build settings from
`netlify.toml`. The local `.netlify/` folder created by the CLI is ignored by Git.

### Test the production build locally

```powershell
npm.cmd run build
npm.cmd run preview -- --host 127.0.0.1
```

Open `http://127.0.0.1:4173`. Localhost counts as a secure context, so the camera can be tested
there. This checks the production bundle, but it does not emulate Netlify's hosting, headers, or
redirects; use a Netlify deploy preview for that final check.

### Camera and privacy on the deployed site

Camera access requires a secure context. Use the Netlify HTTPS URL or localhost; opening the site
over plain HTTP from a LAN address will show an HTTPS-required message. If permission is denied,
allow camera access in the browser and retry, or use **Upload images** instead. All image
processing remains in the browser: no photos, answer keys, or scan results are uploaded.

The CNN weights are embedded in `src/lib/ocr/mnistWeights.ts`; the app never fetches a model or
worker at runtime. `public/models/mnist-8.onnx` is retained only as the provenance source for the
one-off weight-extraction helper. No runtime code, build setting, or test uses that file.

## Using the scanner

1. Open **Scan**.
2. Start the camera and hold one complete answer table inside the guide, or upload/drop one or more photos.
3. The scanner automatically captures when the camera image is stable (if Auto is on), or press **Capture**.
4. The result card shows Set A–E `/12`, TOTAL `/60`, scan time, and the number of answers needing review.
5. Use **Review answers** to inspect every cell. Tap any cell to correct it or mark it blank; scores update immediately.
6. Use **Next sheet** / **Scan another** to continue. Batch uploads are queued and scanned one at a time; the batch list shows scan numbers and scores only.

Red teacher annotations and printed totals are never used for scoring. Only the middle student-answer column is read.

### Answer key and settings

**Key & settings** contains:

- an editable 5 × 12 key (digits 1–8);
- import/export/reset for the key;
- blank policy:
  - **Count wrong** — blank uses the full /12 maximum;
  - **Exclude** — blank is removed from that set's maximum;
  - **Review** — blank is retained and flagged for review;
- low-confidence and confusion-margin thresholds;
- auto-capture and duplicate-guard toggles.

Changes rescore every sheet in the current tab immediately. The key and settings are stored in `localStorage` under `spm-scanner.*`. The built-in key is configuration data in `src/lib/config.ts`; recognition code does not contain answer values.

### Corrections

A correction sets the chosen digit (or blank), clears the low-confidence flag for that cell, and recomputes set score, denominator, and total. Corrections are kept in memory for the current tab; no student identity is recorded.

## How the vision pipeline works

1. **Decode** — uploaded images are decoded with `createImageBitmap` (falling back to an `<img>`); camera frames are copied to a canvas.
2. **Duplicate guard** — a 64-bit difference hash of the original image is compared with existing scans using Hamming distance.
3. **Table detection** — a max-1200 px copy is converted to grayscale, thresholded against a local background, dilated, connected-components labelled, and scored for a tall table-shaped component. A convex four-corner quadrilateral is extracted.
4. **Perspective rectification** — the original-resolution image is sampled through a homography into a canonical 1500 × 1463 sheet.
5. **Grid alignment** — adaptive Otsu-based row-rule snapping and student-column detection; canonical constants are used as a fallback.
6. **Cell preprocessing** — red ink is masked, the local paper background is subtracted, an adaptive ink threshold is applied, long printed rules and borders are removed, strokes are grouped, and the best component is scaled into a centered 28 × 28 MNIST-style image.
7. **Recognition** — an embedded MNIST CNN runs with rotation test-time augmentation at −8°, 0°, and +8°. Only classes 1–8 are allowed. Confidence and top-two margin drive review flags.
8. **Scoring** — `src/lib/scoring.ts` applies the key and blank policy. Obstructed cells are never silently treated as wrong answers.

Detection works on a smaller copy for speed; the warp samples the sharp original source (capped at 3000 px). The embedded CNN weights are decoded once and reused for every cell and sheet; no model file is fetched.

## Measured performance

Measured in the local development build on a desktop Windows browser, after warm-up, using `samples/reference-2.png` (1500 × 2000):

| Measurement | Result |
| --- | --- |
| Browser end-to-end scan | **0.59 s** |
| Node detection | 66 ms |
| Node perspective warp | 72 ms |
| Node recognition (60 cells) | 410 ms |
| Node total (detect + warp + recognition) | ~0.55 s |
| Production bundle | 305.15 KB JS (111.17 KB gzip), 13.53 KB CSS |

The 1-second target was met on this desktop sample. Lower-end phones, very large photos, and cold starts will be slower. The camera auto-capture path was not validated with a physical camera in this environment because camera permission was denied; the permission-error state was tested.

## Accuracy and sample baseline

The repository includes:

- `samples/reference-2.png` — a photographed student sheet with gray student answers and red teacher annotations;
- `samples/reference-1.png` — the red teacher key sheet (not a student sheet);
- `samples/proto-warp.png` — a canonical rectified student sheet used by the integration tests.

The scanner reports **40/60** for `reference-2.png`:

| Set | A | B | C | D | E | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Score | 12 | 10 | 6 | 8 | 4 | **40/60** |

This is the **student's score against the supplied key**, not a recognition-accuracy percentage. The red teacher annotations match the key and are ignored; low-confidence cells are flagged instead of being presented as certain. Several cells in this sample are genuinely wrong answers, not recognition failures.

Important caveats:

- This is **one photographed sheet**, not a validation set. Do not generalize the 40/60 result to overall handwriting accuracy.
- Handwriting ambiguity remains possible. A confidently read cell can still be wrong; the review screen exists for that reason. Cells the model is unsure about are flagged, but confidence is not a guarantee.
- A teacher-key sheet has no student answers. Scanning `reference-1.png` produces a near-zero result with many blank/obstructed cells and a warning; it is not a supported student input.
- The scanner expects one complete table with all four edges visible. Extreme perspective, folds, motion blur, poor lighting, or heavy obstruction can reduce accuracy.
- Duplicate detection is a perceptual hash of the uploaded image. The same or near-identical image is skipped, but a different crop, rotation, or strong perspective change may not match.
- Image format support depends on the browser's decoder. JPG and PNG are recommended; HEIC is not guaranteed.
- The app stores the key/settings locally and scans only in memory for the current tab. Reloading clears the scan list.

## Tests

The test suite currently has 28 tests in three files:

- `tests/scoring.test.ts` — key validation, perfect/all-wrong sheets, blank policies, obstructed handling, corrections, confidence flags, duplicate hashing.
- `tests/scanning.test.ts` — 60-cell integration on the canonical sample, permitted digit/state invariants, known baseline, uncertainty flags, synthetic blank/dark/obstructed cells, dark and rotated real cells, red-annotation removal.
- `tests/pipeline.test.ts` — adaptive grid test plus full detect → warp → grid → recognize → score pipeline on the photographed student sheet.

Reproduce the Node benchmark:

```powershell
npx.cmd tsx scripts/test-warp.ts samples/reference-2.png
npx.cmd tsx scripts/test-grid.ts samples/proto-warp.png
```

Final checks performed:

```text
npm.cmd run typecheck  PASS
npm.cmd run lint       PASS
npm.cmd run test       PASS (28/28)
npm.cmd run build      PASS
npm.cmd run preview    PASS (production bundle served)
```

Production bundle verification (desktop Chromium, `vite preview`, 127.0.0.1):

- single upload of `samples/reference-2.png` → **40/60**, 11 flagged, 0.60 s;
- batch upload (duplicate + new image) → duplicate skipped, second sheet scored 28/60;
- key edit and reset → all visible scores rescored immediately;
- key export/import → valid JSON and "Answer key imported.";
- review correction → set and total scores updated immediately;
- scan JSON export → valid JSON with 28/60 and corrected cell state;
- camera permission denial → "Camera permission was denied. Allow camera access or upload an image instead.";
- insecure HTTP LAN address → "Camera access requires HTTPS. Open this site over HTTPS, or upload an image instead."

The production page loaded with only the document, JavaScript bundle, and CSS request; there was no model or
worker download. A physical camera and an actual Netlify deploy were not available in this environment, so
auto-capture against real paper and Netlify's redirect/header behavior remain unverified.

## Project layout

```text
src/
  App.tsx                     state, queue, camera/upload handlers, exports
  components/
    CameraPanel.tsx           live preview, stability/auto-capture
    ScanView.tsx              scan/upload/batch UI
    ReviewView.tsx            cell correction modal and answer grid
    KeyView.tsx               editable key and settings
    ResultSummary.tsx         scan result card and warnings
    ScoreTiles.tsx            set/total score tiles
  lib/
    config.ts                 default key, settings, canonical grid constants
    scoring.ts                scoring, corrections, blank policies
    image.ts                  decode, dHash, frame stability, downloads
    vision/warp.ts            thresholding, table detection, homography, warp
    vision/grid.ts            adaptive row/column alignment and cell crops
    vision/scan.ts            full scan orchestration
    ocr/preprocess.ts         red/rule removal, ink extraction, 28×28 normalization
    ocr/cnn.ts                embedded CNN inference
    ocr/recognize.ts          rotation TTA, confidence, blank/obstructed states
    ocr/mnistWeights.ts       embedded weights (generated)
tests/                        scoring, scanning and pipeline tests
samples/                      reference images
scripts/                      reproducible benchmarks and weight provenance
netlify.toml                  Netlify build, publish, Node and SPA fallback settings
```

The CNN weights were extracted from the ONNX model zoo `mnist-8.onnx` (MIT) into `src/lib/ocr/mnistWeights.ts`. The one-off extraction helper is kept for provenance; it is not needed to build or run the app.

## Privacy and external services

All detection, recognition, scoring, and storage happen locally in the browser. There is no server request, paid API, analytics, or student-identifying data. Camera access is requested only when **Start camera** is pressed and requires localhost or HTTPS.
#   s h e e t - s c a n n e r  
 