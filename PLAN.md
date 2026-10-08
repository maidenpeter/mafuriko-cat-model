# Mafuriko: Team A build plan

Nairobi Urban Flood Challenge · Kenya Re catastrophe modelling hackathon

## 1. What we are building

A web app for an underwriter. It loads the hackathon data by itself, takes a
broker's offer for one building, and walks through a complete flood
catastrophe model with that building at the centre of every step:

**Dashboard → Read the offer → Read the data → Hazard map → Agents → Vulnerability → Loss engine → Results → Audit**

Once an offer has been read and priced the app is in **Offer mode**, and every
step answers one question: should we take this business, and on what terms?
The model data is not set aside. The synthetic portfolio is the offer's
context on every step (the other insured buildings around it on the map, the
range of its construction class, what it adds to the book), and each step
keeps the full portfolio view as a second view. An **Offer / Portfolio**
switch in the header returns to the portfolio alone.

Each step shows its output, the checks that ran on it, and where every number
came from. The viewer should be able to understand the result in under two
minutes and then drill into any figure.

### The one rule

> **Language models read the document and choose the assumptions. Code checks, locates, prices and reconciles. Tests check both. The screen shows all of it.**

This is the lesson from last year. An AI that takes the input and returns the
output is a black box. Here, no loss figure ever comes out of a model: the
agents return a small set of named parameters with a reason for each, the
offer reader returns values with the sentence each one rests on, and plain
code turns those into losses. That is what makes the tests
meaningful and the result repeatable.

### What the judges score

From the problem statement: genuine AI integration and modelling rigour weigh
more than visual polish, and honesty about limitations is scored. The AI must
*materially change the output*, not describe it. Our evidence for that is a
side-by-side of the loss curve **without AI** (reference assumptions) and
**with AI** (the agents' agreed assumptions), and the same offer priced under
the reference, optimistic, cautious and agreed assumptions.

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Hazard layer | Used as given, plus an optional drainage layer from open map data (on by default, one switch turns it off). |
| Insured values | The model uses the insured values (`tiv_kes`) exactly as written in the exposure file. Team decision, 8 October 2026. The file's values are 10× floor area × cost per m² (portfolio total KES 63.6bn; the data dictionary says 6.36bn). The app detects this and shows it on screen. |
| Insurance terms | Example terms, not from any real policy or treaty, all editable in one "Insurance terms" panel. Per building: a deductible of 2% of insured value with a minimum of KES 50,000, and a limit of 100% of insured value. Portfolio: a 25% quota share, then a catastrophe excess of loss on the retained share, attaching at the retained 1-in-10 loss and running out at the retained 1-in-250 loss. |
| Agents | Optimist, Cautious, Critic, running in parallel, plus a Chair that combines them. |
| AI provider | OpenAI (one key for all four agents) or Gemini (free keys, one per agent), chosen by one setting. The model call sits behind one function, so nothing else in the app knows which is in use. |
| Front end | Next.js, modern and simple, animated walkthrough, tests running on screen. |
| Model data | Read in place from the model data folder: `data/data` beside `web`, or `MODEL_DATA_DIR` in `web/.env.local`. The app opens on the Dashboard with the model loaded; with no folder it falls back to a built-in sample and says so. "Replace model data" takes a zip or loose files for another data set. The app must not depend on exact file names. |
| Second AI feature | Chosen: offer pricing. An offer in plain words (a broker's memo as Word, PDF or text, or a typed sentence) becomes exposure rows by the model, every value is checked against its quote by code, and the rows are priced by code. With no key, or if the call fails, fixed rules do the reading and nothing leaves the browser. An old `.doc` file is refused with "Old Word format, please save as .docx". |
| The offer at the centre | Once an offer is priced, every step follows that building, with the portfolio as its context and as a second view on the same step. One picture of the offer is built once by code and handed to every step, so no step prices anything itself. |
| One home for each fact | Each figure, table and explanation lives in one step; another step that needs it gives one line and points there. The header strip carries the offer's headline figures on every step. |
| The decision | The tool does not accept or decline. Results sets out the figures, the flags with their evidence and suggested conditions; the underwriter records Accept, Accept with conditions, Refer or Decline with a note, and can download a one-page decision note. |

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
MODEL_DATA_DIR=          # optional; defaults to ../data/data, beside web
OPENAI_PRICE_IN_PER_M=   # optional; US dollars per million tokens in
OPENAI_PRICE_OUT_PER_M=  # optional; US dollars per million tokens out
GEMINI_PRICE_IN_PER_M=
GEMINI_PRICE_OUT_PER_M=
```

Each call records its model, tokens in, out and thinking, and seconds. A cost
is shown only when both prices for the provider in use are set. No price is
written in the code.

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
- **Quotes in the document.** Read the offer shows the document with the
  sentence behind each extracted value highlighted, and each value marked
  "AI, verified", "AI, unverified" or "rules".
- **Flags with evidence.** Every point raised on an offer carries a quote
  from the document or a figure from the model, and is sorted by severity.
  The thresholds behind the severities are stated assumptions.
- **Export.** From Audit: the audit report as a PDF, the full audit file
  (JSON, with the extraction record but not the document's text) and a short
  written note (data sources with links, every assumption with its value,
  the AI features and what each changed, drainage, the insurance terms, the
  Oasis check, limits), which is also a required deliverable. When an offer
  is priced the note opens with it. From Results: the one-page decision note.

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

The steps are listed once, in `web/src/lib/steps.ts`. In Offer mode each step
is about the offer's building; the last column is the second view on the same
step, and what the step shows when the header switch is on Portfolio.

| Step | In Offer mode | Portfolio view |
|---|---|---|
| 0. Dashboard | The offer's headline figures and the way into each step. | The portfolio, its losses, the model data source, and a card to drop an offer on. |
| 1. Read the offer | The document with each value's sentence highlighted; the rows in the exposure file's shape, each field marked "AI, verified", "AI, unverified" or "rules" and editable; what was sent and received, collapsed. | The same. |
| 2. Read the data | Where the offer sits in the portfolio. | Files found, each tagged real or synthetic; data checks; the 10× notice. |
| 3. Hazard map | The map zoomed to the building, its outline from the nearest OpenStreetMap building within 30 m (a marker, and a line saying so, when none is found); a return period slider; depth at the building per return period, terrain and ponding apart; distance to the nearest wet cell, river and drain. Portfolio layers are toggles, off by default. | The interactive map of Nairobi with insured buildings, wards, waterways, settlements and facilities. The hotspot test and the drainage sensitivity sit under "Model validation". |
| 4. Agents | Three columns working in parallel, then the Chair's decision in a panel that scrolls inside a fixed height; the assumption ledger; the offer priced under each set of assumptions; usage per agent. | The portfolio's loss under each set. |
| 5. Vulnerability | The building's points on its class curve, one per return period, and a "This building" row in the matrix. | Damage curves and ratios per construction class. |
| 6. Loss engine | The single-building trace per return period: depth, damage ratio, ground-up, deductible, limit, gross, each line naming its source. | The portfolio engine, the Insurance terms panel, and each event from ground-up to gross to net. |
| 7. Results | The underwriter's decision page: the offer in one line; 1-in-100 gross, average annual loss, pure rate per mille, change to the portfolio's 1-in-100; the loss chart; flags with evidence, sorted by severity; suggested conditions; the decision and its note; "Download decision note". | Total exposure, losses at key return periods, the loss curve with its band, breakdowns, with and without AI, the Oasis check. |
| 8. Audit | Every check, the extraction record, agent usage, the model data source, and the exports, including the audit report as a PDF. | The same, without the offer. |

An offer for a building outside the maps stops with "Outside the hazard maps
loaded: flood cannot be priced here"; the steps then show the portfolio view.

## 8. Technical design

- **Next.js (App Router) + TypeScript + Tailwind**, in `web/`.
- **The model runs in the browser.** Zip reading (JSZip), CSV parsing
  (PapaParse), raster lookup (geotiff.js) and PDF text (pdfjs-dist) all
  happen client-side, so there is no upload limit and the walkthrough can
  animate real progress.
- **Model calls go through server routes**, so the keys stay on the server.
  A third route serves the model data folder in place.
- **One picture of the offer.** `src/lib/offer/focus.ts` turns the offer, the
  loaded model and the assumptions in force into one object: the document
  and its fields, the building, depth, damage and loss per return period,
  the terms used, the effect on the portfolio, the price under each set of
  assumptions, the checks, the flags and the suggested conditions. Every
  step reads it.
- **The building outline** comes from the public OpenStreetMap Overpass
  service, asked from the browser with the building's coordinates.
- **Motion** for animation, hand-written SVG charts (no chart library),
  **Zod** for schemas, **Vitest** for unit tests.

```
README.md                 what it is, how to run it, a three-minute demo
PLAN.md
data/                     hackathon starter kit: data/data is the model data folder
oasis/                    the independent check with Oasis LMF
web/
  src/app/                the walkthrough page; api/agents/[role], api/offer/extract and api/model-data routes
  src/lib/model/          parameters, hazard, vulnerability, financial, insurance terms, pipeline
  src/lib/modelData/      reading the model data folder in place
  src/lib/ingest/         zip, csv, raster, dataset detection
  src/lib/checks/         the on-screen checks
  src/lib/agents/         prompts, schemas, model client, usage and cost
  src/lib/offer/          reading an offer, checking it against its words, locating and pricing it; focus.ts
  src/lib/offerFiles/     file kinds and PDF text
  src/lib/decision.ts     flags, suggested conditions, the decision record; decisionNote.ts prints it
  src/lib/export.ts       the written note and the audit file
  src/components/         dashboard, steps, charts, shared UI
  tests/                  unit tests, plus a test against the starter kit
```

### Input contract

The app looks inside the model data folder, or an uploaded zip, for:

- an exposure CSV (columns `loc_id, lat, lon, housing_class, tiv_kes`, and
  optionally `hazard_score_*`);
- hazard rasters, recognised by name: tier words (`common`, `occasional`,
  `moderate`, `severe`, `extreme`) or return periods (`rp100y`);
- optionally a hotspots CSV (`name, lat, lon`).

If the folder or zip holds more than one dataset, the viewer picks one. Rasters named by
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
9. **Model data folder and dashboard.** The model loads by itself and the
   app opens on the Dashboard.
10. **Offer-led walkthrough.** One picture of the offer for every step; PDF
    input; quotes highlighted in the document; the merged Hazard map with the
    building outline; the single-building trace; the decision page and its
    note; Audit with the extraction record, usage and the PDF.
11. **Deliverables.** The written note, the root README, this plan.

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
- The building outline on the Hazard map comes from the public OpenStreetMap
  Overpass service, which is run by volunteers. The offer building's
  coordinates and the search radius go to it, and nothing else: no name, no
  value, no word of the document. When no building is mapped within 30 m,
  the map shows a marker and says so.
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
- An offer has a ground-up and a gross loss. Net is a portfolio figure.
- The flags on an offer rest on thresholds we chose (water at the building at
  1-in-25 or more frequent is high; 1% and 5% added to the portfolio's
  1-in-100; 5% and 10% of the portfolio's insured value; a 1-in-100 gross
  loss of 3% and 10% of the sum insured). They are listed in the written
  note. The "poor drainage" flag is a word test on the document's own
  sentence, which is always shown.
- A point that the maps show as dry gives a loss of zero. That is a statement
  about the maps at those coordinates, not a finding that the building
  cannot flood; the flags say what the maps cannot see.

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
- [ ] Complete one live agent run and save it, so a run can ship with the app
      (to be done by the team on localhost).
- [ ] Get the marking rubric and check this plan against it.
- [x] Choose the second AI feature: offer pricing.
- [ ] Run one offer end to end with the hosted model on localhost (the rules
      path is covered by tests against the two test offers; to be done by
      the team).
- [x] Insurance terms: deductible, limit, quota share and excess of loss,
      with ground-up, gross and net kept apart.
- [x] Model data folder: the model loads by itself and the app opens on the
      Dashboard.
- [x] Offer-led walkthrough: every step follows the priced offer, with the
      portfolio as context and the Offer / Portfolio switch.
- [x] PDF offers, and the message for old Word files.
- [x] Decision page, decision record and the one-page decision note.
- [x] Written note, root README and this plan brought in line.
- [ ] Look at every step in a browser in Offer mode, light and dark, at
      390 px and 1920 px, with the Nairobi test offer.
- [ ] Check the building outline lookup once against the live Overpass
      service (tests use a local stand-in).
- [ ] Set the token prices in `web/.env.local` if a cost should be shown.

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
- Building outlines for an offer: OpenStreetMap through the Overpass API,
  https://overpass-api.de (OpenStreetMap contributors, ODbL).
- Oasis LMF: https://github.com/OasisLMF/OasisLMF
