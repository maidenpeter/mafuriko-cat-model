# Mafuriko: Team A build plan

Nairobi Urban Flood Challenge · Kenya Re catastrophe modelling hackathon

## 1. What we are building

A web app that takes the hackathon data as a zip upload and walks the viewer
through a complete flood catastrophe model, one animated step at a time:

**Upload → Read the data → Hazard → Agents set the assumptions → Vulnerability → Loss engine → Risk map → Results → Price an offer → Audit**

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
| Hazard layer | Used as given, plus an optional drainage layer from open map data (on by default, one switch turns it off). |
| Insured values | The model uses the insured values (`tiv_kes`) exactly as written in the exposure file. Team decision, 8 October 2026. The file's values are 10× floor area × cost per m² (portfolio total KES 63.6bn; the data dictionary says 6.36bn). The app detects this and shows it on screen. |
| Insurance terms | Example terms, not from any real policy or treaty, all editable in one "Insurance terms" panel. Per building: a deductible of 2% of insured value with a minimum of KES 50,000, and a limit of 100% of insured value. Portfolio: a 25% quota share, then a catastrophe excess of loss on the retained share, attaching at the retained 1-in-10 loss and running out at the retained 1-in-250 loss. |
| Agents | Optimist, Cautious, Critic, running in parallel, plus a Chair that combines them. |
| AI provider | OpenAI (one key for all four agents) or Gemini (free keys, one per agent), chosen by one setting. The model call sits behind one function, so nothing else in the app knows which is in use. |
| Front end | Next.js, modern and simple, animated walkthrough, tests running on screen. |
| Input | A zip shaped like `data/data/`. The app must not depend on exact file names. |
| Second AI feature | Chosen: offer pricing. An offer in plain words (a broker's memo as Word or text, or a typed sentence) becomes exposure rows by the model, every value is checked against its quote by code, and the rows are priced by code. With no key, or if the call fails, fixed rules do the reading and nothing leaves the browser. |

## 3. The model

Four stages, as in the brief. Everything in this section is code.

### 3.1 Hazard

- Each building gets one hazard value per tier, read from the rasters at the
  building's coordinates. If the exposure file already carries
  `hazard_score_*` columns, the app compares them with its own raster lookup
  and reports how many match.
- The Nairobi value is a **0 to 1 susceptibility score, not a depth**. We convert
  it with one stated assumption:
  `depth (m) = score × tier slope × depth scale`. Each tier map is rescaled
  to run 0 to 1, so read on its own every tier would peak at the same depth.
  The tier slope, fitted from the maps (about 0.63 for `extreme` up to 1.0
  for `common`), puts every tier back on one scale, so depth grows as the
  event gets rarer. The depth scale is the assumed depth at the
  highest-scoring spot in the widest tier. The brief's example is 4 m. The
  agents choose this value.
- The five tiers are nested cuts of one score. `common` covers the most cells
  and so stands for the **rarest** event; `extreme` covers the fewest and
  stands for the most frequent.
- **Drainage-driven flooding (optional, on by default).** The terrain map
  cannot see water that ponds where drains are missing or blocked. A second,
  simple layer comes from open map data: distance to mapped drains, ditches
  and canals, and to informal settlement outlines. Stress is 1 on a drain or
  inside a settlement and fades to 0 at 300 m. Ponding depth = stress × a
  shallow depth per tier (0.15 m for `extreme` up to 0.6 m for `common`).
  Each building takes the deeper of the terrain and ponding depths. This
  lifts the hotspot match from 12 to 16 of 24 (Kibera, Kangemi, Lang'ata,
  Parklands) while the flooded share of the grid grows by under one
  percentage point. Reach and depths are assumptions; the hazard step shows
  how the match moves for reaches from 100 m to 500 m.

### 3.2 Vulnerability

- Base curve: the JRC / Huizinga (2017) depth-damage function for **Africa,
  residential buildings**. Damage fraction at 0, 0.5, 1, 1.5, 2, 3, 4, 5, 6 m:
  `0.00, 0.22, 0.38, 0.53, 0.64, 0.82, 0.90, 0.96, 1.00`, with straight-line
  interpolation between points.
- Adaptation per construction class, clearly labelled as our assumption:
  - **fragility** multiplies the depth before the curve is read (above 1 for
    weaker construction, below 1 for stronger);
  - **cap** is the highest damage ratio that class can reach (the brief
    suggests 80 to 95%).
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
- Insurance terms are applied by code after the damage model, and three
  figures are kept apart everywhere: **ground-up** (before any terms),
  **gross** (ground-up less the policy deductible, capped at the policy
  limit, building by building) and **net** (gross less the quota share
  recovery and the excess of loss recovery, on the portfolio total of each
  event). The loss curve shows all three, with an average annual loss for
  each and a table at every return period.
- The terms are example terms, not from any real policy or treaty.
- An offer is priced ground-up and gross. It uses the deductible and limit
  its document states, and the example terms otherwise, and says which.
  Net is a portfolio figure and is not worked out for a single offer.

### 3.5 Parameters the agents decide

| Parameter | Reference value (no AI) | Allowed range |
|---|---|---|
| Depth scale (m at score 1.0, widest tier) | 4.0 | 1.0 to 6.0 |
| Fragility: informal / semi-permanent / masonry / concrete | 1.5 / 1.2 / 1.0 / 0.7 | 0.4 to 2.5 |
| Cap: informal / semi-permanent / masonry / concrete | 0.95 / 0.90 / 0.85 / 0.80 | 0.60 to 1.00 |
| Return period: extreme / severe / moderate / occasional / common | 10 / 25 / 50 / 100 / 250 years | 2 to 1000, strictly rising |

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
  so it can be replayed exactly. The current OpenAI and Gemini models reason
  before they answer and are not run at a fixed temperature, so two live runs
  can differ; the saved run is what makes a result repeatable.
- A saved run ships with the app, so the demo still works with no network.
- If a call fails, the walkthrough continues on reference values and says so.

Environment variables (in `web/.env.local`, never committed):

```
AGENT_PROVIDER=          # openai or gemini; blank means OpenAI when it has a key
OPENAI_API_KEY=          # one key for all four agents
OPENAI_MODEL=            # optional; defaults to gpt-6-luna
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
- Gross loss is never above ground-up loss.
- Net loss is never above gross loss.
- Reinsurance recoveries reconcile: gross less quota share less excess of
  loss equals net.
- Average annual loss falls from ground-up to gross to net.

**AI**
- Every agent reply matches the schema.
- Every parameter is inside its allowed range.
- Every parameter has a reason.
- The Chair answered every challenge from the Critic.
- Re-running the engine on the saved parameters reproduces the same result.

**Offer**
- Every value read from the document is found in its words: the quoted
  sentence is in the document and the number is in the sentence. A value
  that fails is shown, and nothing is priced until it is confirmed, edited
  or cleared.
- The location is inside the hazard maps loaded. Outside them the answer is
  "Outside the hazard maps loaded: flood cannot be priced here", with no
  loss figures.
- Stated river distance against the map, value per m² against the
  portfolio's range, basements, reported flood history against the maps,
  and a non-residential building on the residential curve. A limit of the
  model is a warning, never a failure.

## 7. The walkthrough

| Step | What the viewer sees |
|---|---|
| 0. Upload | Drop a zip. A sample dataset button for rehearsals. |
| 1. Read the data | Files found, each tagged real or synthetic; data checks ticking off; the 10× notice. |
| 2. Hazard | Buildings drawn over the susceptibility map; switch between tiers; hotspots marked hit or missed. |
| 3. Agents | Three columns working in parallel, then the Chair's decision and the assumption ledger. |
| 4. Vulnerability | Damage curves per construction class under the agreed parameters. |
| 5. Loss engine | Loss building up tier by tier; click a building for its trace. The Insurance terms panel, and each event from ground-up to gross to net. |
| 6. Risk map | Interactive map of Nairobi: flood depth for each event on a slider that can play, insured buildings with a click-through loss trace, wards shaded by loss or value, rivers and drains, informal settlements, schools and health facilities in the water, the county hotspots, and a 3D view with loss columns. Works without internet on a plain background. |
| 7. Results | Total exposure, loss at key return periods, average annual loss; the loss curve with its band and its ground-up, gross and net lines; breakdown by class; largest contributors; with and without AI; the Oasis check. |
| 8. Price an offer | Give a broker's memo or type a sentence. What was sent to the model with contact details removed; each value with its source sentence and whether code verified it; the building on the maps; ground-up and gross loss per return period with where the deductible and limit came from; the effect on the portfolio; checks on the offer; the rows as a CSV. |
| 9. Audit | All checks, the ledger, the run log, and the export buttons. |

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
  src/app/                the walkthrough page; api/agents/[role] and api/offer/extract routes
  src/lib/model/          parameters, hazard, vulnerability, financial, pipeline
  src/lib/ingest/         zip, csv, raster, dataset detection
  src/lib/checks/         the on-screen checks
  src/lib/agents/         prompts, schemas, model client
  src/lib/offer/          reading an offer, checking it against its words, locating and pricing it
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

### Independent check with Oasis LMF

`oasis/build_and_run.py` writes the portfolio as an Oasis exposure file and the
hazard and damage assumptions as Oasis model files, runs them through the
open-source Oasis engine (oasislmf 2.5.8), and saves a summary to
`web/public/oasis/reference.json`. The Results step compares it with the live
engine. On reference assumptions every event loss agrees within 0.05%, and the
step-method average annual loss agrees within 0.01%. The app's own average
annual loss draws a straight line between events, so it sits above the Oasis
step value; both readings are shown.

## 9. Build order

Each phase ends with something that works, so there is always a demo.

1. **Engine.** Parameters, hazard conversion, vulnerability, financial
   engine and checks, with unit tests and a test against the starter kit.
2. **Reading the zip.** File detection, CSV parsing, raster lookup, and the
   cross-check against the pre-attached hazard columns.
3. **Walkthrough on reference values.** Every step, end to end, no AI.
   *This is the safety net.*
4. **Agents.** Three parallel calls, the Chair, the ledger, the band, the
   with-and-without comparison, saved runs.
5. **Audit and export.** Run log, audit file, written note.
6. **Polish.** Animation, map detail, wording, a rehearsed demo path.
7. **Second AI feature.** Offer pricing: the model turns an offer in plain
   words into exposure rows, code checks every value against its quote, and
   code prices the rows on the loaded maps and assumptions.
8. **Insurance terms.** Deductible and limit per building, quota share and
   excess of loss on the portfolio, ground-up, gross and net throughout.

## 10. Honest limits to state in the demo

- The hazard layer is a terrain-and-river proxy, not measured flooding. It
  flags 12 of 24 known hotspots on its own and 16 with the drainage layer.
- The drainage layer is a distance rule on mapped drains and settlements,
  not a drainage model. Unmapped or blocked drains are invisible to it.
- The score-to-depth conversion is an assumption, not a measurement.
- The damage curve is a continental average adapted by judgement. No verified
  Kenya-specific curve exists.
- The return periods attached to the tiers are assumed.
- The portfolio is synthetic and randomly placed.
- The five scenarios are nested cuts of one map, not independent events.
- The agents run on a hosted model: OpenAI's API, or free Gemini keys. OpenAI
  says API data is not used to train its models unless the account opts in,
  and that it keeps request logs for up to 30 days to monitor abuse. Google's
  terms let it use free-tier inputs to improve its products, and human
  reviewers may read them. Either way the agents only see summary figures
  built from synthetic data. A deployment with real cedant data would need a
  data agreement with the provider, or a locally hosted model; the provider
  sits behind one function.
- Offer pricing is the one place where a document's own text leaves the
  browser: the text of the offer goes to the hosted model, with contact
  details removed first (email addresses, phone numbers, and contact and
  signature blocks). Names written inside ordinary sentences are not
  removed. The screen shows exactly what was sent, and "Fixed rules only"
  sends nothing.
- A value marked verified was found written in the document. That shows it
  was written, not that it was understood, so the source sentence sits
  beside every value.
- The fixed rules read one building per document. An offer with several
  buildings needs the model, or the underwriter's own entries.
- The insurance terms are example terms, not from any real policy or treaty.
  Gross and net figures move with them.
- An offer is priced on the residential damage curve whatever it is used
  for, and water entering basements is not modelled. Both are flagged on
  screen when they apply.

## 11. Open items

- [x] Decide which insured values to use: the file's values, exactly as
      written (team decision, 8 October 2026). Asking the organisers which
      were intended is still worth doing, but no longer blocks anything.
- [ ] Check the Africa residential curve against the original JRC spreadsheet
      (currently confirmed against a secondary source only).
- [x] Confirm the Gemini model name: `gemini-3.8-flash` is listed as stable
      on Google's model page (checked 7 October 2026).
- [ ] Confirm the free-tier request limits.
- [x] Confirm the OpenAI model name: `gpt-6-luna` is on OpenAI's model page
      and listed for our key (checked 8 October 2026).
- [ ] Complete one live agent run and save it, so a run can ship with the app.
- [ ] Get the marking rubric and check this plan against it.
- [x] Choose the second AI feature: offer pricing.
- [ ] Run one offer end to end with the hosted model on localhost (the rules
      path is covered by tests against the two test offers).

## 12. Sources

- Huizinga, de Moel and Szewczyk (2017), *Global flood depth-damage
  functions*, JRC105688: https://publications.jrc.ec.europa.eu/repository/handle/JRC105688
- Copernicus GLO-30 elevation model and OpenStreetMap rivers and streams
  (inputs to the supplied hazard proxy; credit OpenStreetMap contributors).
- Nairobi County flood-hotspot mapping, March 2026 (hotspot names).
- Hackathon starter kit: problem statement, build guide and data dictionary in `data/`.
- Gemini API Additional Terms of Service (free and paid tiers): https://ai.google.dev/terms
- OpenAI API data controls (training use and retention): https://developers.openai.com/api/docs/guides/your-data
- Map layers in `web/public/geo/` (wards: Omare and Omare 2017, CC BY 4.0;
  rivers, drains, settlements and facilities: OpenStreetMap contributors, ODbL).
  Details in `web/public/geo/SOURCES.md`.
- Basemap: OpenFreeMap styles on OpenStreetMap data. Terrain: Mapzen Terrain
  Tiles on AWS Open Data.
- Oasis LMF: https://github.com/OasisLMF/OasisLMF
