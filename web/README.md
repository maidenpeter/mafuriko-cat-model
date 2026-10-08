# Mafuriko web app

An explainable flood model for an underwriter, for the Kenya Re hackathon (Team A, Nairobi).
Once an offer has been read and priced, every step is about that building; the loaded portfolio
is its context. A three-minute demo path is in [`../README.md`](../README.md), and the plan and
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

Without keys the walkthrough still runs: the offer is read by fixed rules, the model uses
reference assumptions, and the screen says so.

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
  that does not exist), the app falls back to `public/sample-data.zip`. The header then reads
  "from the built-in sample", and the Dashboard says why.
- The header shows where the data came from, for example
  "Model data: Nairobi starter kit, from the model data folder". **Replace model data** beside it
  takes a zip, or loose files, for a different data set. A zip dropped on the Dashboard's offer
  card does the same.
- A `.docx` or `.txt` in an upload that gives coordinates or a sum insured is treated as an
  offer and opens in step 1, Read the offer. Problem statements and the data dictionary stay
  documentation.

## The offer

- **Inputs.** An offer is a `.docx`, a `.pdf` or a `.txt` file, or text typed into the box. A PDF
  is turned into text in the browser. An old `.doc` file is refused with "Old Word format,
  please save as .docx".
- **Offer mode.** When an offer is priced, the header switch reads **Offer** and every step
  follows that building. **Portfolio** on the same switch returns to the portfolio view, and
  each step keeps the portfolio as a second view beside "This offer".
- **Outside the maps.** A building outside the hazard maps stops with "Outside the hazard maps
  loaded: flood cannot be priced here" and no loss figure.
- **What leaves the browser.** With a key, the offer's text goes to the hosted model with email
  addresses, phone numbers and contact blocks removed; "Fixed rules only" sends nothing. The
  building's coordinates go to the public OpenStreetMap Overpass service to fetch its outline.
- **Decision note.** On Results, the underwriter records Accept, Accept with conditions, Refer
  or Decline with a note. **Download decision note** gives one printable page.
- **Audit.** The Audit step holds every check, the extraction record, what each model call used
  and the model data source. It gives the audit report as a PDF, the written note (Markdown) and
  the full audit file (JSON).

## The steps

The steps are listed once, in `src/lib/steps.ts`. Every step takes its number and name from there.

| Step | Name |
|---|---|
| 0 | Dashboard |
| 1 | Read the offer |
| 2 | Read the data |
| 3 | Hazard map |
| 4 | Agents |
| 5 | Vulnerability |
| 6 | Loss engine |
| 7 | Results |
| 8 | Audit |

Every step is open as soon as the model has loaded. The hazard maps and the risk map are one
step, Hazard map.

| Step | In Offer mode | Portfolio view |
|---|---|---|
| Dashboard | The offer's headline figures and where to go next | The portfolio, its losses and the offer drop card |
| Read the offer | The document with each value's sentence highlighted, the editable fields and their sources, what was sent and received | The same |
| Read the data | Where the offer sits in the portfolio | Files found, data checks |
| Hazard map | The building pinpointed, depth per return period, distances to water and drains | Portfolio layers, hotspot test and drainage sensitivity under "Model validation" |
| Agents | The assumptions, their reasons and the offer's price under each set | The portfolio's loss under each set |
| Vulnerability | The building's points on its class curve | Curves and damage ratios by class |
| Loss engine | The single-building trace per return period | The portfolio engine and the insurance terms |
| Results | Flags, suggested conditions, the decision and the decision note | Loss curve, breakdowns, with and without AI, the Oasis check |
| Audit | Every check, the extraction record, usage, the exports | The same, without the offer |

## Rehearsal shortcuts

- `http://localhost:3000/?step=7` opens that step once the model has loaded (numbers as in the
  first table above: 7 is Results, 8 is Audit). Old links with `sample=1` still work: the model loads by itself, so it changes nothing.
- `http://localhost:3000/?offer=1` opens step 1, Read the offer, with the Nairobi test offer and
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
| `src/lib/model/` | The model: parameters and ranges, damage curve, loss curve, pipeline. Pure code, no AI. |
| `src/lib/steps.ts` | The steps, in order: the one place that sets each step's number and name. |
| `src/lib/modelData/`, `src/app/api/model-data/` | Reading the model data folder in place, with the fallback to the built-in sample. |
| `src/app/api/test-offer/` | Serves the Nairobi test offer for the `?offer=1` shortcut. |
| `src/lib/ingest/` | Reading the data: zip, CSV, GeoTIFF lookup, dataset detection, telling an offer from documentation. |
| `src/lib/checks/` | The checks shown on screen. |
| `src/lib/agents/` | Agent prompts, reply schemas, the OpenAI and Gemini calls, and the two-round orchestration. |
| `src/app/api/agents/` | Server routes that hold the keys and call the model. |
| `src/lib/offer/` | Reading an offer, checking each value against its sentence, locating and pricing it. `focus.ts` builds the one picture of the offer every step reads. |
| `src/lib/offerFiles/` | Telling `.docx`, `.pdf`, `.txt` and old `.doc` apart, and turning a PDF into text. |
| `src/app/api/offer/extract/` | The server route that sends the offer's text, contact details removed, to the model. |
| `src/lib/decision.ts`, `src/lib/decisionNote.ts` | Flags, suggested conditions, the decision record and the printable decision note. |
| `src/lib/export.ts` | The written note and the full audit file. |
| `src/components/` | The dashboard, the walkthrough steps, the hazard map and the charts. |
| `tests/` | Vitest tests. |

Only `openai.ts` and `gemini.ts` in `src/lib/agents/` call a model, and `provider.ts` picks between them.
To add another provider, write a third file with the same three functions and list it in `provider.ts`.
