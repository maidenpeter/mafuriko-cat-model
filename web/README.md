# Mafuriko web app

An explainable flood loss walkthrough for the Kenya Re hackathon (Team A, Nairobi).
The plan and the modelling decisions are in [`../PLAN.md`](../PLAN.md).

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

Without keys the walkthrough still runs, on reference assumptions, and says so.

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

## The steps

The steps are listed once, in `src/lib/steps.ts`. Every step takes its number and name from there.

| Step | Name |
|---|---|
| 0 | Dashboard |
| 1 | Read the offer |
| 2 | Read the data |
| 3 | Hazard |
| 4 | Risk map |
| 5 | Agents |
| 6 | Vulnerability |
| 7 | Loss engine |
| 8 | Results |
| 9 | Audit |

Every step is open as soon as the model has loaded.

## Rehearsal shortcuts

- `http://localhost:3000/?step=8` opens that step once the model has loaded (numbers as in the
  table above). Old links with `sample=1` still work: the model loads by itself, so it changes nothing.
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
| `src/components/` | The dashboard, the walkthrough steps, the risk map and the charts. |
| `tests/` | Vitest tests. |

Only `openai.ts` and `gemini.ts` in `src/lib/agents/` call a model, and `provider.ts` picks between them.
To add another provider, write a third file with the same three functions and list it in `provider.ts`.
