# Mafuriko: Team A build plan

Nairobi Urban Flood Challenge · Kenya Re catastrophe modelling hackathon

## 1. What we are building

A web app for an underwriter. It loads the hackathon data by itself, takes a
broker's offer for one building, and walks through a complete flood
catastrophe model with that building at the centre of every step:

**Dashboard → Price an offer → Read the data → Agents → Hazard map → Vulnerability → Loss engine → Results → Audit**

Once an offer has been read and priced the app is in **Offer mode**, and every
step answers one question: should we take this business, and on what terms?
The model data is not set aside. The synthetic portfolio is the offer's
context on every step (the other insured buildings around it on the map, the
range of its construction class, what it adds to the book), and the full
portfolio view of every step is one switch away: **View** (Offer or
Portfolio) in the header. No step has a switch of its own.

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
| Second AI feature | Chosen: offer pricing. An offer in plain words (a broker's memo, always a file: Word, PDF or text) becomes exposure rows by the model, every value is checked against its quote by code, and the rows are priced by code. With no key, or if the call fails, fixed rules do the reading and nothing leaves the browser. An old `.doc` file is refused with "Old Word format, please save as .docx". |
| The offer at the centre | Once an offer is priced, every step follows that building, with the portfolio as its context and as the other side of the header's View switch. One picture of the offer is built once by code and handed to every step, so no step prices anything itself. |
| One home for each fact | Each figure, table and explanation lives in one step; another step that needs it gives one line and points there. The row of four figures in the header carries the offer's headline figures on every step. |
| Losses beyond flood depth | A building's loss is the sum of six loss drivers, then the deductible and the limit: surrounding flooding, drainage ponding, drain overload, basement ingress, business interruption and an uncertainty loading (section 3.5). A header switch, "Losses from", chooses "Depth only" or "All loss drivers"; All loss drivers is the default. Depth only is the model as it was, to the last decimal, and tests hold it there. This replaces an earlier, half-built method (an average over a radius, percentage loadings and a blend with the loss history), which is removed. |
| Not stated means asked, not guessed | A value the drivers need and the offer does not state is listed as a question for the broker. The price uses a marked assumption until it is answered. |
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

### 3.5 Losses beyond flood depth

Read at one point, a dry building prices at zero, even when the ground around
it floods in heavy rain, its drains are overloaded and its plant sits in a
basement. So with "All loss drivers" the loss of a building at each return
period is the sum of six drivers, then the deductible and the limit:

| # | Loss driver | How it is worked out | Source |
|---|---|---|---|
| 1 | Surrounding flooding | The hazard map is read as the highest depth within a buffer around the building (its footprint plus the error in a stated coordinate), not only at the point. Both depths are shown side by side: "at the point" and "within the buffer". | Hazard maps; the buffer is an assumption. |
| 2 | Drainage ponding | As in 3.1. | Open map data; reach and depths are assumptions. |
| 3 | Drain overload | When the event's return period is greater than the drain design return period, the site holds at least a shallow depth of water, even where the maps are dry. | The design return period from the offer when it states one and code verified it; otherwise an assumption. The depth is an assumption. |
| 4 | Basement ingress | When water at the site (driver 1, 2 or 3) reaches the ingress threshold and the building has basements: value below ground × the basement damage ratio for that event. The value below ground never loses a smaller share than the damage curve gives the structure at the same water. | Basements and value below ground from the offer; a share of the insured value when the offer states no value. Threshold and ratios are assumptions. |
| 5 | Business interruption | Only when the offer says it is covered, and only at return periods where water reaches the site: outage days for that event × a day's rent or revenue. | A year's rent or revenue from the offer ÷ 365; otherwise a share of the insured value. The days are assumptions. |
| 6 | Uncertainty loading | A stated share of drivers 1 to 5, for causes not modelled (seepage, blocked drains, pump failure). Always its own line, never mixed into the others. | An assumption. |

- **No double counting.** Drivers 1 to 3 all put water at the same building,
  so the structure's loss is read once on the damage curve, at the deepest of
  the three. Each driver is credited with what it adds beyond the ones before
  it, in this order: the depth at the point, what the surroundings add,
  ponding, drain overload. The four parts add up to the structure's loss. The
  "Surrounding flooding" line is the first two together.
- **No value counted twice.** The structure's value is the insured value less
  the value below ground.
- **Never below Depth only.** Because the value below ground loses at least
  what the curve gives at the same water, taking it off the curve cannot make
  a building cheaper than Depth only prices it.
- **Terms.** The deductible and the limit act on the sum of all six. Gross is
  after them.
- **Depth only.** The depth is the deeper of the terrain depth at the point
  and the drainage ponding, nothing else: the model exactly as it was. Every
  earlier figure, the checks in section 6 and the Oasis comparison refer to
  it. Tests pin its results.
- **The portfolio.** Drivers 1 to 3 apply to every building of the synthetic
  portfolio, with one drain design return period for all of them. The
  portfolio has no basement or rent data, so drivers 4 and 5 are not modelled
  for it. One sentence says so: on the Loss engine's portfolio view, and in
  the records.
- **The reference run.** The portfolio's "without AI" run uses the reference
  values and anything the underwriter typed, never a figure the agents set.
  The buffer the agents agree is therefore part of what the AI changes.
- **An offer outside the maps** is not priced in either mode: "Outside the
  hazard maps loaded: flood cannot be priced here", and no figure.

The assumptions behind the drivers (`web/src/lib/offer/judgement.ts`). Code
keeps each inside its range, and each ladder never falls as events get rarer:

| Assumption | Reference value | Allowed range | Argued by the agents |
|---|---|---|---|
| Buffer around the building (m) | 250 | 0 to 500 | Yes |
| Surface water at which a basement takes water (m) | 0.10 | 0 to 0.5 | Yes |
| Basement damage ratio: rung 1 (most frequent flood) to rung 5 (rarest flood) | 0.15 / 0.25 / 0.40 / 0.55 / 0.70 | 0 to 1, never falling | Yes |
| Share of insured value below ground, when the offer does not state it | 0.08 | 0 to 0.5 | Yes |
| Outage days: rung 1 (most frequent flood) to rung 5 (rarest flood) | 2 / 5 / 10 / 20 / 40 | 0 to 365, never falling | Yes |
| Uncertainty loading (share of drivers 1 to 5) | 0.10 | 0 to 0.5 | Yes |
| Drain design return period, when the offer does not state it (years) | 25 | 2 to 200 | No, set on screen |
| Surface water when the drains are overloaded (m) | 0.10 | 0 to 0.5 | No, set on screen |
| A year's rent or revenue, when the offer does not state it (share of insured value) | 0.08 | 0 to 0.3 | No, set on screen |
| Cost of capital (share per year) | 0.08 | 0 to 0.3 | No, set on screen |
| Minimum flood rate (per mille of insured value) | 0.1 | 0 to 2 | No, set on screen |

That is 19 figures, 14 of them argued by the agents. Each one in force is
marked with who set it: the **offer** (read from the document, with its
sentence), the **agents** (the agreed set, when they ran on this offer and
"Agreed by agents" is on), **typed** (the underwriter typed over it) or
**reference**. "Reference, no AI" uses the reference value for everything the
agents would set.

**Premium build-up** (an offer, on Results). Modelled average annual loss by
driver, gross; the uncertainty loading as its own line; a capital load of the
cost of capital × what the offer adds to the portfolio's 1-in-100 gross loss
(gross like every other line, so no capital is charged on the deductible or
on anything above the limit); then the minimum rate × insured value as a
floor. The result is the
flood premium and a flood rate per mille, shown beside the offer's stated
premium and all-risks rate when it states a premium. The document's own flood
loss history is shown beside the modelled average annual loss as a sense
check, and is not blended in.

### 3.6 Parameters the agents decide

| Parameter | Reference value (no AI) | Allowed range |
|---|---|---|
| Depth scale (m at score 1.0, widest tier) | 4.0 | 1.0 to 6.0 |
| Fragility: informal / semi-permanent / masonry / concrete | 1.5 / 1.2 / 1.0 / 0.7 | 0.4 to 2.5 |
| Cap: informal / semi-permanent / masonry / concrete | 0.95 / 0.90 / 0.85 / 0.80 | 0.60 to 1.00 |
| Return period: extreme / severe / moderate / occasional / common | 10 / 25 / 50 / 100 / 250 years | 2 to 1000, strictly rising |

With an offer loaded the agents also decide the 14 assumptions marked "Yes"
in 3.5, in the same reply: 28 entries in all.

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

With an offer loaded, the agents are also given a short brief of it (what it
states about basements, drains, pumps, barriers and cover, and the depths at
the building per tier: at the point, within the buffer, ponding, drains
overloaded). The Optimist and the Cautious voice then each propose the 14
beyond-depth assumptions of section 3.5 as well, within their ranges and with
a reason for each; the two ladders are argued as ladders. The Critic raises at
least three challenges about the offer, and the Chair settles the agreed set.
This is part of what the AI changes: the same offer is priced under each set.

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
- **Quotes in the document.** Price an offer marks each extracted value
  "AI, verified", "AI, unverified" or "rules", and "View the document" opens
  the document with the sentence behind each value marked.
- **Flags with evidence.** Every point raised on an offer carries a quote
  from the document or a figure from the model, and is sorted by severity.
  The thresholds behind the severities are stated assumptions.
- **Export.** From Audit: the audit report as a PDF, the full audit file
  (JSON, with the extraction record but not the document's text) and a short
  written note (data sources with links, every assumption with its value,
  the AI features and what each changed, drainage, the insurance terms, the
  Oasis check, limits), which is also a required deliverable. When an offer
  is priced the note opens with it. From Results: the one-page decision note.
- **Losses beyond flood depth on the record.** Audit lists every one of the
  19 assumptions with its value in force, its allowed range, its source and
  who set it, and says which mode is in force. The note and the audit file
  carry the same table, the offer's loss by driver per return period, the
  premium build-up, the broker questions and the portfolio's loss by driver.

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
- With all loss drivers, for the portfolio and for the offer: the drivers add
  up to each loss; the depth within the buffer is never below the depth at
  the point; Depth only never gives more than All loss drivers, and for the
  offer it reproduces the point reading.

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
- The values the loss drivers read (basement depth, drain design return
  period, value below ground, rent, cover, premium) pass the same check as
  every other value. A drain design must be written as a return period. With
  All loss drivers, one that switches a driver on or sets its size (basement
  levels, value below ground, drain design, interruption cover, rent) and
  fails its check holds the price until it is confirmed, edited or cleared.
  With Depth only none of them is read.
- The three checks on the offer's loss drivers (the drivers add up to its
  loss; its depth within the buffer is never below its depth at the point;
  Depth only reproduces the point reading) are part of the offer's own list
  of checks, built once with the picture of the offer. Audit and both exports
  read that one list, and "Checks so far" beside the steps counts it.

## 7. The walkthrough

The steps are listed once, in `web/src/lib/steps.ts`. In Offer mode each step
is about the offer's building; the last column is what the same step shows
when the header's View switch is on Portfolio.

| Step | In Offer mode | Portfolio view |
|---|---|---|
| 0. Dashboard | A call-out with the offer's headline figures, its 1-in-100 loss by driver and the decision recorded on it, then the portfolio. The page has no View switch. | With no offer read, the call-out is "Price an offer" with one button that opens step 1. Then the portfolio's figures and charts, what the agents changed and the model chain with its checks. |
| 1. Price an offer | The one upload: a Word, PDF or text file. Once it is read, first where the building is (its class and ward, the terms, the checks) with the way on to the hazard map; then the extracted values as compact rows, each marked "AI, verified", "AI, unverified" or "rules", editable, and confirmed by a person where code could not check it; among them the values the loss drivers read (number and depth of basements, equipment below ground, drain design return period, sump pump capacity and backup power, flood barriers and non-return valves, value split, rent, business interruption cover, premium); the document behind "View the document"; the broker questions, folded. What was sent and received is in Audit. | The same: the page has no View switch. |
| 2. Read the data | Where the offer sits in the portfolio; the value split with the source of each figure (offer quote or assumption); under-insurance, from the value per m² against the class range. | Files found, each tagged real or synthetic; data checks; the 10× notice. |
| 3. Agents | Three columns working in parallel, then the Chair's decision in a panel that scrolls inside a fixed height; the assumption ledger, the model's parameters and the beyond-depth assumptions, with who set each; the offer priced under each set of assumptions; usage per agent. | The portfolio's loss under each set. |
| 4. Hazard map | The map zoomed to the building, its outline from the nearest OpenStreetMap building within 30 m (a marker, and a line saying so, when none is found) and the buffer ring around it; a return period slider; per return period the depth at the point, the depth within the buffer, ponding and "drains overloaded: yes or no"; distance to the nearest wet cell, river and drain. Portfolio layers are toggles, off by default. | The interactive map of Nairobi with insured buildings, wards, waterways, settlements and facilities. The hotspot test and the drainage sensitivity sit under "Model validation". |
| 5. Vulnerability | The building as components: structure (JRC curve), basement machinery and contents (basement ladder), business interruption (outage days), each with its value and damage per return period. | Damage curves and ratios per construction class. |
| 6. Loss engine | The stack for one return period, line by line: surrounding flooding, drainage ponding, drain overload, basement ingress, business interruption, uncertainty loading, then deductible and limit, each line naming its source; and the same figures for every return period in one table. | The portfolio engine with drivers 1 to 3, the Insurance terms panel, and each event from ground-up to gross to net. |
| 7. Results | The underwriter's decision page: the "Loss by driver" chart; the premium build-up and the flood rate beside the all-risks rate; broker questions; points for the underwriter with evidence, sorted by severity; suggested conditions; the decision and its note; "Download decision note". The headline figures are in the row of figures in the header. | Total exposure, losses at key return periods, the loss curve with its band, the portfolio's loss by driver, breakdowns, with and without AI, the Oasis check. |
| 8. Audit | The offer on record with its decision and the count of broker questions; every check, the model's and the offer's; the extraction record; the assumptions beyond flood depth with value, range, source and who set each; agent usage; the model data source; and the exports, including the audit report as a PDF, which lists the questions. | The same, without the offer. |

The header has three rows. A slim top bar holds the brand, "Step N of 8"
with the step's name, and the two display settings (theme and text size). A
lighter control bar holds the switches: "View" (Offer or Portfolio, on the
steps that differ between the two), "Losses from" (Depth only, or All loss
drivers), "Flood source" (terrain only, or terrain and drainage, once the
drainage layer is ready) and, once the agents have agreed a set,
"Assumptions" (Agreed by agents, or Reference, no AI), with a "Model data"
button whose panel names the data, its origin and "Replace model data". Under
them one row of four figures stays in view on every step: the offer's in
Offer mode, the portfolio's otherwise.

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
  the terms used, the mode, the loss drivers with their sources and the
  premium build-up, the assumptions beyond depth and who set each, the broker
  questions, the effect on the portfolio, the price under each set of
  assumptions, the checks, the flags and the suggested conditions. Every
  step reads it, and no step works out a figure of its own.
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
  src/lib/model/          parameters, hazard, vulnerability, financial, insurance terms, pipeline; drivers.ts for loss drivers 1 to 3
  src/lib/modelData/      reading the model data folder in place
  src/lib/ingest/         zip, csv, raster, dataset detection
  src/lib/checks/         the on-screen checks
  src/lib/agents/         prompts, schemas, model client, usage and cost
  src/lib/offer/          reading an offer, checking it against its words, locating and pricing it; focus.ts;
                          judgement.ts (the assumptions beyond depth), drivers.ts (the six drivers and the
                          premium build-up), questions.ts (the broker questions)
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
engine. The comparison refers to Depth only on reference assumptions: the
loss drivers beyond depth are not in the Oasis run. On reference assumptions
every event loss agrees within 0.05%, and the step-method average annual loss
agrees within 0.01%. The app's own average
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
12. **Losses beyond flood depth.** The six loss drivers through every step,
    the "Losses from" switch, the extra values read from the offer, the
    broker questions, the agents arguing the beyond-depth assumptions, the
    premium build-up, and the record of all of it on Audit.

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
  for. That is flagged on screen when it applies.
- The buffer takes the **highest** depth nearby, not an average, so it reads
  high: one deep cell within 250 m sets the depth for the whole building. On
  the starter kit at reference values with drainage on, All loss drivers
  lifts the portfolio's average annual loss from about KES 174m to about
  KES 613m, and almost all of that is the buffer. The radius is the lever
  and is editable; with Depth only it is not read at all.
- Drain overload is an assumption applied to every building alike. Beyond the
  design return period (1-in-25 unless the offer states one) every site is
  taken to hold 0.1 m of water, whether or not its own drains would cope. So
  with all loss drivers every portfolio building counts as affected from the
  1-in-50 event upwards.
- The basement damage ladder, the outage days, the value below ground and the
  rent when the offer does not state them, the uncertainty loading, the cost
  of capital and the minimum rate are assumptions, not measurements. Each is
  shown with the Assumption badge, its range and who set it.
- Sump pumps, backup power, flood barriers and non-return valves are read
  from the offer, given to the agents and asked about, and change no figure
  by themselves: there is no formula for them.
- Drivers 4 and 5 (basement ingress and business interruption) are not
  modelled for the synthetic portfolio, which has no basement or rent data.
  What an offer adds to the portfolio is therefore the offer's six drivers on
  top of a portfolio measured on three.
- The capital load rests on what the offer adds to the portfolio's 1-in-100
  gross loss, and at the reference cost of capital it can be the largest line
  of the premium build-up. It can never exceed the cost of capital × the
  flood limit.
- The Oasis comparison refers to Depth only on reference assumptions. It
  does not test the loss drivers beyond depth.
- An offer has a ground-up and a gross loss. Net is a portfolio figure.
- The flags on an offer rest on thresholds we chose (water at the building at
  1-in-25 or more frequent is high; 1% and 5% added to the portfolio's
  1-in-100; 5% and 10% of the portfolio's insured value; a 1-in-100 gross
  loss of 3% and 10% of the sum insured). They are listed in the written
  note. The "poor drainage" flag is a word test on the document's own
  sentence, which is always shown.
- With Depth only, a point that the maps show as dry gives a loss of zero.
  That is a statement about the maps at those coordinates, not a finding
  that the building cannot flood; the flags say what the maps cannot see,
  and All loss drivers prices what it can of it.

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
- [x] Losses beyond flood depth: six loss drivers, the "Losses from" switch,
      the premium build-up, broker questions, and the record on Audit.
- [ ] Decide whether a 250 m buffer is the right reference value: it more
      than triples the portfolio's average annual loss.
- [ ] Look at the "Losses from" switch and the new tables in a browser, light
      and dark, at 390 px and 1920 px.
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
