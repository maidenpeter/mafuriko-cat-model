# Mafuriko web app

An explainable flood model for an underwriter, for the Kenya Re hackathon (Team A, Nairobi).
Once an offer has been read and priced, every step is about that building; the loaded portfolio
is its context. A five-minute demo path is in [`../README.md`](../README.md), and the plan and
the modelling decisions are in [`../PLAN.md`](../PLAN.md).

## Run it

```bash
npm install
cp .env.example .env.local   # then paste the OpenAI key, or the Gemini keys, into .env.local
npm run dev                  # http://localhost:3000
```

The agents run on OpenAI or on Gemini. `AGENT_PROVIDER` in `.env.local` chooses; left blank,
OpenAI is used when it has a key. The Agents step shows the model in use next to the run button.

Restart `npm run dev` after changing `.env.local`, and after editing `src/app/globals.css`.
The dev server can keep showing the previous version of the styles until it restarts
(the Tailwind loader lags one edit behind on that file). Changes to components show up live.

For a presentation, run the built app instead of the dev server. It starts faster and has no
live reloading to go wrong:

```bash
npm run build
npm start                    # http://localhost:3000
```

Without keys the walkthrough still runs: the offer is read by fixed rules, and the screen says
so. The agents' run saved with the app (`public/agents/`, see its README) is replayed on load
whenever this browser holds no run of its own, tagged "Saved run from <date>, model <name>",
so the Agents step and the Assumptions switch work with no key and no network. With no saved
run shipped, the model uses its reference assumptions.

An estimated cost in US dollars appears beside the token counts only when both
`OPENAI_PRICE_IN_PER_M` and `OPENAI_PRICE_OUT_PER_M` (or the `GEMINI_` pair) are set in
`.env.local`. No price is written in the code.

## Model data

The model loads by itself. On first load the app reads the Nairobi data set (hazard maps,
exposure CSV, hotspots) from the model data folder and opens on the Dashboard with the model ready.

- The folder is `MODEL_DATA_DIR` in `.env.local`. Left blank, it is `../data/data`, beside this
  `web` folder. A relative value is taken from this `web` folder. The files are read in place
  and never copied.
- When the folder is missing or cannot be read (for example `MODEL_DATA_DIR` points at a folder
  that does not exist), the app falls back to `public/sample-data.zip`. The Model data panel
  then reads "from the built-in sample", and the Dashboard says why.
- **Model data** in the control bar opens a panel that shows where the data came from, for
  example "Nairobi starter kit, from the model data folder". **Replace model data** in it
  takes a zip, or loose files, for a different data set.
- A `.docx` or `.txt` in an upload that gives coordinates or a sum insured is treated as an
  offer and opens in step 1, Price an offer. Problem statements and the data dictionary stay
  documentation.

## The offer

- **Inputs.** An offer is always a file: a `.docx`, a `.pdf` or a `.txt`. The one upload is in
  step 1, Price an offer, and the Dashboard's "Price an offer" call-out opens it. A PDF is
  turned into text in the browser. An old `.doc` file is refused with "Old Word format,
  please save as .docx".
- **Offer mode.** When an offer is priced, the **View** switch in the control bar reads
  **Offer** and every step follows that building. **Portfolio** on the same switch returns to
  the portfolio view. It is the only such switch: no step has its own.
- **Outside the maps.** A building outside the hazard maps stops with "Outside the hazard maps
  loaded: flood cannot be priced here" and no loss figure.
- **What leaves the browser.** With a key, the offer's text goes to the hosted model with email
  addresses, phone numbers and contact blocks removed; "Fixed rules only" sends nothing. The
  building's coordinates go to the public OpenStreetMap Overpass service to fetch its outline.
- **Decision note.** On Results, the underwriter records Accept, Accept with conditions, Refer
  or Decline with a note. **Download decision note** gives one printable page.
- **Audit.** The Audit step holds every check, the extraction record, every assumption beyond
  flood depth with its value, range, source and who set it, what each model call used and the
  model data source. The offer's checks, the three on its loss drivers among them, come from
  the one picture of the offer (`focus.checks`) and are counted in "Checks so far" beside the
  steps. On screen the broker questions are a count with a link to Price an offer. The step
  gives the audit report as a PDF, the written note (Markdown) and the full audit file (JSON).
  The PDF lists the broker questions; the note and the file also carry the offer's loss by
  driver per return period, the premium build-up, the broker questions and the portfolio's
  loss by driver.

## Losses beyond flood depth

A building that is dry at its own point on the map can still lose money in a flood. The header
switch **Losses from** chooses between two ways of working out a loss:

- **Depth only**: the depth at the building's point and drainage ponding, nothing else. This is
  the model as it was before the loss drivers, and tests hold it to the same figures to the last
  decimal.
- **All loss drivers** (the default): the loss at each return period is the sum of six drivers,
  then the deductible and the limit.

| # | Loss driver | In one line |
|---|---|---|
| 1 | Surrounding flooding | The highest map depth within the buffer around the building, shown beside the depth at the point. |
| 2 | Drainage ponding | Ponding near mapped drains and informal settlements, as the Flood source switch sets it. |
| 3 | Drain overload | Beyond the drain design return period the site holds a shallow depth of water even where the maps are dry. |
| 4 | Basement ingress | Once water at the site reaches the ingress threshold and the building has basements: value below ground x the basement damage ratio for the event, and never a smaller share than the damage curve gives the structure at the same water. |
| 5 | Business interruption | Outage days for the event x a day's rent or revenue, only when the offer says it is covered. |
| 6 | Uncertainty loading | A stated share on top of the other five, for causes not modelled. Always its own line. |

Drivers 1 to 3 put water at the same building, so the structure's loss is read once, at the
deepest of the three, and each is credited with what it adds beyond the ones before it. The
structure's value is the insured value less the value below ground, so no value is counted twice.
The method is stated in full at the top of `src/lib/offer/judgement.ts`.

- **The assumptions.** All 19 are in `src/lib/offer/judgement.ts`, each with a reference value
  and an allowed range that code enforces. Reference values: buffer 250 m; ingress threshold
  0.10 m; basement damage 15%, 25%, 40%, 55% and 70% from the most frequent event to the rarest;
  value below ground 8% of the insured value when the offer does not state it; outage 2, 5, 10,
  20 and 40 days; uncertainty loading 10%; drain design 1-in-25 when the offer does not state
  it; 0.1 m of water when the drains are overloaded; a year's rent 8% of the insured value when
  the offer does not state it; cost of capital 8%; minimum rate 0.1 per mille. The cost of
  capital and the minimum rate are placeholders for figures only Kenya Re underwriting can set:
  editable, badged "Assumption, to be set by Kenya Re underwriting" wherever they appear
  (`PLACEHOLDER_BADGE` in `src/lib/labels.ts`, drawn by `PlaceholderBadge`), and never market
  figures. A headline flood rate says once that it rests on them (`PLACEHOLDER_RATE_LINE`).
- **Who sets them.** The offer where it states the figure (with its sentence), then anything the
  underwriter types, then the agents' agreed set while "Agreed by agents" is on, otherwise the
  reference value. The agents argue 14 of the 19: the buffer, the ingress threshold, the
  basement damage ladder, the share below ground, the outage days and the uncertainty loading.
  "Reference, no AI" puts those back on their reference values. The reference run of the
  portfolio never carries a figure the agents set, so the buffer they agree shows up in "with
  and without AI". A rung of either ladder is named by its place and its flood ("rung 1 of 5,
  most frequent flood").
- **The premium build-up** (Results): modelled average annual loss by driver, the uncertainty
  loading, a capital load (cost of capital x what the offer adds to the portfolio's 1-in-100
  gross loss), then the minimum rate as a floor. The result is the flood premium and a
  flood rate per mille, beside the offer's all-risks rate when it states a premium.
- **Broker questions.** Anything the drivers need that the offer does not state is listed as a
  question, never guessed (`src/lib/offer/questions.ts`). Their home is Price an offer.
- **Read but not verified.** With All loss drivers, an unverified value that switches a driver
  on or sets its size (basement levels, value below ground, drain design, interruption cover,
  rent) holds the price until it is confirmed, edited or cleared (`src/lib/offer/verify.ts`).
  With Depth only none of them is read.
- **The portfolio.** Drivers 1 to 3 apply to the synthetic portfolio. It has no basement or
  rent data, so drivers 4 and 5 are not modelled for it. One sentence says so, on the Loss
  engine's portfolio view and in the records.
- **Outside the maps.** Neither mode prices an offer outside the hazard maps.

## The steps

The steps are listed once, in `src/lib/steps.ts`. Every step takes its number and name from there.

| Step | Name |
|---|---|
| 0 | Dashboard |
| 1 | Price an offer |
| 2 | Read the data |
| 3 | Agents |
| 4 | Hazard map |
| 5 | Vulnerability |
| 6 | Loss engine |
| 7 | Results |
| 8 | Audit |

The header has three rows: a top bar with the brand, "Step N of 8" with the step's name and the
two display settings (theme and text size); a lighter control bar with the switches View,
Losses from, Flood source and Assumptions and a Model data panel; and one row of four figures.

Every step is open as soon as the model has loaded. The hazard maps and the risk map are one
step, Hazard map. The agents come before it, so every step after them shows the price they
shaped.

| Step | In Offer mode | Portfolio view |
|---|---|---|
| Dashboard | A call-out with the offer's headline figures, its 1-in-100 loss by driver and the decision recorded on it, then the portfolio | With no offer read, a "Price an offer" call-out; then the portfolio's figures and charts, what the agents changed and the model chain |
| Price an offer | First where the building is, with the way on to the hazard map; then the extracted values as compact rows a person can edit and confirm (the basements, drains, pumps, value split and cover among them); the document behind "View the document"; the broker questions, folded | The same: this page and the Dashboard have no View switch |
| Read the data | Where the offer sits in the portfolio; the value split with the source of each figure; under-insurance against the class range | Files found, data checks |
| Agents | The assumptions, the model's and the ones beyond depth, who set each, their reasons and the offer's price under each set | The portfolio's loss under each set |
| Hazard map | The building pinpointed with its buffer ring; per return period the depth at the point, within the buffer, ponding and whether the drains are overloaded | Portfolio layers, hotspot test and drainage sensitivity under "Model validation" |
| Vulnerability | The building as components: structure, basement machinery and contents, interruption | Curves and damage ratios by class |
| Loss engine | The stack of loss drivers for one return period, line by line, the same figures for every return period, then the deductible and the limit | The portfolio engine with drivers 1 to 3, and the insurance terms |
| Results | The price and the flood rate, the premium build-up, "Loss by driver", what the offer does to the portfolio, the Oasis check on the portfolio, points for the underwriter, suggested conditions, the decision and the decision note | Loss curve, the portfolio's loss by driver, breakdowns, with and without AI, the Oasis check |
| Audit | Every check, the extraction record (what was sent to the model and what came back), the assumptions beyond flood depth, the count of broker questions, usage, the exports, the building-level export | The same, without the offer |

Each fact has one home, and another step that needs it gives one line and a link. The row of
four figures in the header stays in view on every step: the offer's in Offer mode, the
portfolio's otherwise.

The exposure file's insured values are a fixed multiple of the formula documented with them.
Every total of them (the figures row, the Dashboard, Read the data, Results, Audit, the written
note and the audit file) carries the flag from `insuredValueFlag` in `src/lib/labels.ts`. An
offer's own sum insured comes from the broker's document and does not.

**The Oasis check** (Results, on the portfolio view and on the offer's page) follows the header
settings. On reference assumptions it shows the Oasis run made for Terrain only or Terrain +
drainage with Depth only (fed depths), or Terrain + drainage with All loss drivers (fed final
damage ratios, so it checks the financial engine and the loss arithmetic). Any other
combination reads "Not checked by Oasis for these settings". The runs and how to make them are
in [`../oasis/README.md`](../oasis/README.md).

## Rehearsal shortcuts

- `http://localhost:3000/?step=7` opens that step once the model has loaded (numbers as in the
  first table above: 7 is Results, 8 is Audit). Old links with `sample=1` still work: the model loads by itself, so it changes nothing.
- `http://localhost:3000/?offer=1` opens step 1, Price an offer, with the Nairobi test offer and
  reads it straight away. The offer is the first `.docx` with NAIROBI in its name in the
  `test-data` folder beside the model data folder (`../data/test-data` by default). It is served
  from there and never copied. When that folder is not present the step opens with nothing loaded.

## Check it

```bash
npm test         # unit tests, plus a run against the real starter kit in ../data
npm run lint
npm run build
```

## Where things are

| Path | What |
|---|---|
| `src/lib/model/` | The model: parameters and ranges, damage curve, loss curve, pipeline. `drivers.ts` holds loss drivers 1 to 3 and the two modes. Pure code, no AI. |
| `src/lib/steps.ts` | The steps, in order: the one place that sets each step's number and name. |
| `src/lib/modelData/`, `src/app/api/model-data/` | Reading the model data folder in place, with the fallback to the built-in sample. |
| `src/app/api/test-offer/` | Serves the Nairobi test offer for the `?offer=1` shortcut. |
| `src/lib/ingest/` | Reading the data: zip, CSV, GeoTIFF lookup, dataset detection, telling an offer from documentation. |
| `src/lib/checks/` | The checks shown on screen. |
| `src/lib/agents/` | Agent prompts, reply schemas, the OpenAI and Gemini calls, and the two-round orchestration. |
| `src/app/api/agents/` | Server routes that hold the keys and call the model. |
| `src/lib/offer/` | Reading an offer, checking each value against its sentence, locating and pricing it. `judgement.ts` holds the assumptions beyond flood depth, `drivers.ts` the six loss drivers and the premium build-up, `questions.ts` the broker questions. `focus.ts` builds the one picture of the offer every step reads. |
| `src/lib/offerFiles/` | Telling `.docx`, `.pdf`, `.txt` and old `.doc` apart, and turning a PDF into text. |
| `src/app/api/offer/extract/` | The server route that sends the offer's text, contact details removed, to the model. |
| `src/lib/decision.ts`, `src/lib/decisionNote.ts` | Flags, suggested conditions, the decision record and the printable decision note. |
| `src/lib/export.ts` | The written note and the full audit file. |
| `src/lib/oasisExport.ts` | The building-level export (depth and final damage ratio per building and return period) and which Oasis run matches the settings in force. |
| `src/lib/agents/shipped.ts`, `public/agents/` | The agents' run saved with the app, and how it is replayed on load. |
| `src/lib/labels.ts` | The shared wording: return periods, amounts, rates per mille, the source badges, the two names of the "Losses from" switch, the placeholder badge and the insured value flag. |
| `src/components/` | The dashboard, the walkthrough steps, the hazard map and the charts. |
| `tests/` | Vitest tests. |

Only `openai.ts` and `gemini.ts` in `src/lib/agents/` call a model, and `provider.ts` picks between them.
To add another provider, write a third file with the same three functions and list it in `provider.ts`.
