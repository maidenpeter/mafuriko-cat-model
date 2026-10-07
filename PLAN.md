# Mafuriko — Team A build plan

Nairobi Urban Flood Challenge · Kenya Re catastrophe modelling hackathon

## 1. What we are building

A web app that takes the hackathon data as a zip upload and walks the viewer
through a complete flood catastrophe model, one animated step at a time:

**Upload → Read the data → Hazard → Agents set the assumptions → Vulnerability → Loss engine → Results → Audit**

Each step shows its output, the checks that ran on it, and where every number
came from. The viewer should be able to understand the result in under two
minutes and then drill into any figure.

### The one rule

> **Agents choose and defend the assumptions. Code does every calculation. Tests check both. The screen shows all of it.**

This is the lesson from last year. An AI that takes the input and returns the
output is a black box. Here, no loss figure ever comes out of a model: the
agents return a small set of named parameters with a reason for each, and
plain code turns those parameters into losses. That is what makes the tests
meaningful and the result repeatable.

### What the judges score

From the problem statement: genuine AI integration and modelling rigour weigh
more than visual polish, and honesty about limitations is scored. The AI must
*materially change the output*, not describe it. Our evidence for that is a
side-by-side of the loss curve **without AI** (reference assumptions) and
**with AI** (the agents' agreed assumptions).

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Hazard layer | Used as given. No drainage improvement for now. |
| Insured values | Used as they are in the file. The file's values are 10× floor area × cost per m² (portfolio total KES 63.6bn; the data dictionary says 6.36bn). The app detects this and shows it on screen. |
| Agents | Optimist, Cautious, Critic, running in parallel, plus a Chair that combines them. |
| AI provider | Gemini, free keys, one key per agent. The model call sits behind one function so the provider can be swapped. |
| Front end | Next.js, modern and simple, animated walkthrough, tests running on screen. |
| Input | A zip shaped like `data/data/`. The app must not depend on exact file names. |
| Second AI feature | Decided later (free-text portfolio entry, text-to-speech or speech-to-speech are candidates). |

## 3. The model

Four stages, as in the brief. Everything in this section is code.

### 3.1 Hazard

- Each building gets one hazard value per tier, read from the rasters at the
  building's coordinates. If the exposure file already carries
  `hazard_score_*` columns, the app compares them with its own raster lookup
  and reports how many match.
- The Nairobi value is a **0–1 susceptibility score, not a depth**. We convert
  it with one stated assumption:
  `depth (m) = score × depth scale`, where the depth scale is the assumed
  depth at a score of 1.0. The brief's example is 4 m. The agents choose this
  value.
- The five tiers are nested cuts of one score. `common` covers the most cells
  and so stands for the **rarest** event; `extreme` covers the fewest and
  stands for the most frequent.

### 3.2 Vulnerability

- Base curve: the JRC / Huizinga (2017) depth-damage function for **Africa,
  residential buildings**. Damage fraction at 0, 0.5, 1, 1.5, 2, 3, 4, 5, 6 m:
  `0.00, 0.22, 0.38, 0.53, 0.64, 0.82, 0.90, 0.96, 1.00`, with straight-line
  interpolation between points.
- Adaptation per construction class, clearly labelled as our assumption:
  - **fragility** multiplies the depth before the curve is read (above 1 for
    weaker construction, below 1 for stronger);
  - **cap** is the highest damage ratio that class can reach (the brief
    suggests 80–95%).
- `damage ratio = min( JRC curve( depth × fragility ), cap )`

### 3.3 Exposure

- The synthetic portfolio as supplied: location, housing class, insured value.
- A "synthetic data" label stays visible on every screen.
- Because 84 concrete buildings hold 85% of the value and 179 informal
  structures hold 0.3%, every breakdown shows **building counts next to
  money**.

### 3.4 Financial engine

- `building loss = damage ratio × insured value`, for each tier.
- Portfolio loss per tier is the sum over buildings.
- Each tier is assigned a return period, giving the loss curve (EP curve).
  Losses at standard return periods (10, 25, 50, 100, 250 years) are read off
  by interpolating loss against the logarithm of the return period.
- Average annual loss is the area under the curve of loss against annual
  probability. Stated assumption: events more frequent than the shortest
  return period cause no loss, and the loss stays flat beyond the longest.
- Out of scope, as the brief says: treaty structures, layers, net-of-reinsurance.

### 3.5 Parameters the agents decide

| Parameter | Reference value (no AI) | Allowed range |
|---|---|---|
| Depth scale (m at score 1.0) | 4.0 | 1.0 – 6.0 |
| Fragility: informal / semi-permanent / masonry / concrete | 1.5 / 1.2 / 1.0 / 0.7 | 0.4 – 2.5 |
| Cap: informal / semi-permanent / masonry / concrete | 0.95 / 0.90 / 0.85 / 0.80 | 0.60 – 1.00 |
| Return period: extreme / severe / moderate / occasional / common | 10 / 25 / 50 / 100 / 250 years | 2 – 1000, strictly rising |

Code enforces the ranges. A value outside its range is clamped and flagged on
screen. The reference column is what the app uses if the AI is unavailable,
and it is the "without AI" side of the comparison.

## 4. The agents

Agents never see individual rows and never produce a loss figure. Code builds
a compact **data profile** (counts, value by class, buildings affected per
tier, score ranges, hotspot hit rate, check results) and that is what the
agents read.

| Agent | Runs | Job | Returns |
|---|---|---|---|
| **Optimist** | Round 1, parallel | Argue for the least severe assumptions that are still defensible | A full parameter set, with a reason and a basis for each value |
| **Cautious** | Round 1, parallel | Argue for the most severe assumptions that are still defensible | Same shape |
| **Critic** | Round 1, parallel | Challenge the data and the reference assumptions: the 10× values, the concentration in concrete buildings, the hotspots the proxy misses, the unused top of the score range | A list of challenges, each with severity and the parameter it affects |
| **Chair** | Round 2 | Read both proposals, the losses each one produces, and the Critic's challenges; settle on a final parameter set | Final parameters, a reason for each choice, and an answer to every challenge |

Between the rounds, code runs the engine on the Optimist's and the Cautious
agent's parameters. That gives three loss curves in the end: optimistic,
cautious and agreed. The gap between the first two is shown as an
uncertainty band around the agreed curve.

Safeguards:

- Structured JSON output checked against a schema; ranges enforced by code.
- Every run saved (inputs, prompts, raw replies, final parameters, results)
  so it can be replayed exactly. Gemini 3 models do not accept a temperature
  setting, so two live runs can differ; the saved run is what makes a result
  repeatable.
- A saved run ships with the app, so the demo still works with no network.
- If a call fails, the walkthrough continues on reference values and says so.

Environment variables (in `web/.env.local`, never committed):

```
GEMINI_API_KEY_OPTIMIST=
GEMINI_API_KEY_CAUTIOUS=
GEMINI_API_KEY_CRITIC=
GEMINI_API_KEY_CHAIR=
GEMINI_API_KEY=          # fallback used by any agent without its own key
GEMINI_MODEL=            # optional; defaults to gemini-3.8-flash
```

## 5. Explainability

This is the part we lost on last year, so it is a feature in its own right.

- **Assumption ledger.** One row per parameter: value, who proposed it, the
  reason, the basis, and a tag.
- **Tags on everything:** Real data · Derived proxy · Synthetic · Assumption ·
  AI-proposed.
- **Building trace.** Click any building to see
  score → depth → damage ratio → loss, with the formula and the values used.
- **Run log.** Every step with its timing, inputs and outputs.
- **With and without AI.** Reference curve next to the agreed curve, with the
  difference in shillings and percent.
- **Export.** A downloadable audit file and a short written note (data
  sources, assumptions, AI feature), which is also a required deliverable.

## 6. Checks that run on screen

Each check shows pass, warning or fail, with the numbers behind it.

**Reading the data**
- Every expected file was found and recognised.
- Rows read equals rows in the file.
- Required columns present; no missing coordinates or values.
- Coordinates fall inside the hazard maps.
- Insured value equals floor area × cost per m² (this raises the 10× warning).
- Every row carries the synthetic flag.
- Every housing class is one the model knows.

**Hazard**
- Scores lie between 0 and 1.
- Tiers are nested: a building's score never rises from `common` to `extreme`.
- Raster lookup matches the pre-attached hazard columns.
- Hotspot hit rate, reported in plain terms (the starter kit says 12 of 24).

**Vulnerability**
- Zero depth gives zero damage.
- Damage never falls as depth rises.
- Damage never exceeds the class cap.
- At the same depth, weaker construction is damaged at least as much as stronger.

**Financial**
- Building losses add up to the portfolio loss.
- Class losses add up to the portfolio loss.
- No building loses more than its insured value.
- Loss rises as the event gets rarer.
- Average annual loss is below the largest scenario loss.

**AI**
- Every agent reply matches the schema.
- Every parameter is inside its allowed range.
- Every parameter has a reason.
- The Chair answered every challenge from the Critic.
- Re-running the engine on the saved parameters reproduces the same result.

## 7. The walkthrough

| Step | What the viewer sees |
|---|---|
| 0. Upload | Drop a zip. A sample dataset button for rehearsals. |
| 1. Read the data | Files found, each tagged real or synthetic; data checks ticking off; the 10× notice. |
| 2. Hazard | Buildings drawn over the susceptibility map; switch between tiers; hotspots marked hit or missed. |
| 3. Agents | Three columns working in parallel, then the Chair's decision and the assumption ledger. |
| 4. Vulnerability | Damage curves per construction class under the agreed parameters. |
| 5. Loss engine | Loss building up tier by tier; click a building for its trace. |
| 6. Results | Total exposure, loss at key return periods, average annual loss; the loss curve with its band; breakdown by class; largest contributors; with and without AI. |
| 7. Audit | All checks, the ledger, the run log, and the export buttons. |

## 8. Technical design

- **Next.js (App Router) + TypeScript + Tailwind**, in `web/`.
- **The model runs in the browser.** Zip reading (JSZip), CSV parsing
  (PapaParse) and raster lookup (geotiff.js) all happen client-side, so there
  is no upload limit and the walkthrough can animate real progress.
- **Agent calls go through server routes**, so the keys stay on the server.
- **Motion** for animation, hand-written SVG charts (no chart library),
  **Zod** for schemas, **Vitest** for unit tests.

```
PLAN.md
data/                     hackathon starter kit
web/
  src/app/                the walkthrough page; api/agents/[role] routes
  src/lib/model/          parameters, hazard, vulnerability, financial, pipeline
  src/lib/ingest/         zip, csv, raster, dataset detection
  src/lib/checks/         the on-screen checks
  src/lib/agents/         prompts, schemas, model client
  src/components/         steps, charts, shared UI
  tests/                  unit tests, plus a test against the starter kit
```

### Input contract

The app looks inside the zip for:

- an exposure CSV (columns `loc_id, lat, lon, housing_class, tiv_kes`, and
  optionally `hazard_score_*`);
- hazard rasters, recognised by name: tier words (`common`, `occasional`,
  `moderate`, `severe`, `extreme`) or return periods (`rp100y`);
- optionally a hotspots CSV (`name, lat, lon`).

If the zip holds more than one dataset, the viewer picks one. Rasters named by
return period are treated as depths in metres with their own return periods,
so a Nzoia-style dataset runs through the same engine. This is insurance
against being handed something unexpected on the day.

## 9. Build order

Each phase ends with something that works, so there is always a demo.

1. **Engine.** Parameters, hazard conversion, vulnerability, financial
   engine and checks, with unit tests and a test against the starter kit.
2. **Reading the zip.** File detection, CSV parsing, raster lookup, and the
   cross-check against the pre-attached hazard columns.
3. **Walkthrough on reference values.** All eight steps, end to end, no AI.
   *This is the safety net.*
4. **Agents.** Three parallel calls, the Chair, the ledger, the band, the
   with-and-without comparison, saved runs.
5. **Audit and export.** Run log, audit file, written note.
6. **Polish.** Animation, map detail, wording, a rehearsed demo path.
7. **Second AI feature.** Chosen once the above is solid.

## 10. Honest limits to state in the demo

- The hazard layer is a terrain-and-river proxy, not measured flooding. It
  flags 12 of 24 known hotspots and cannot see drainage-driven flooding.
- The score-to-depth conversion is an assumption, not a measurement.
- The damage curve is a continental average adapted by judgement. No verified
  Kenya-specific curve exists.
- The return periods attached to the tiers are assumed.
- The portfolio is synthetic and randomly placed.
- The five scenarios are nested cuts of one map, not independent events.

## 11. Open items

- [ ] Ask the organisers which insured values are intended (file or dictionary).
- [ ] Check the Africa residential curve against the original JRC spreadsheet
      (currently confirmed against a secondary source only).
- [ ] Confirm the Gemini model name and the free-tier request limits.
- [ ] Get the marking rubric and check this plan against it.
- [ ] Choose the second AI feature.

## 12. Sources

- Huizinga, de Moel and Szewczyk (2017), *Global flood depth-damage
  functions*, JRC105688 — https://publications.jrc.ec.europa.eu/repository/handle/JRC105688
- Copernicus GLO-30 elevation model and OpenStreetMap rivers and streams
  (inputs to the supplied hazard proxy; credit OpenStreetMap contributors).
- Nairobi County flood-hotspot mapping, March 2026 (hotspot names).
- Hackathon starter kit: problem statement, build guide and data dictionary in `data/`.
