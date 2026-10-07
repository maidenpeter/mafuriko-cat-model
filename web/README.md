# Mafuriko web app

An explainable flood loss walkthrough for the Kenya Re hackathon (Team A, Nairobi).
The plan and the modelling decisions are in [`../PLAN.md`](../PLAN.md).

## Run it

```bash
npm install
cp .env.example .env.local   # then paste the Gemini keys into .env.local
npm run dev                  # http://localhost:3000
```

Restart `npm run dev` after changing `.env.local`.

- Upload a zip shaped like `data/data/`, or press **Use the starter kit**.
- `http://localhost:3000/?sample=1&step=7` loads the starter kit and opens a given step (rehearsal shortcut).
- Without keys the walkthrough still runs, on reference assumptions, and says so.

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
| `src/lib/ingest/` | Reading the upload: zip, CSV, GeoTIFF lookup, dataset detection. |
| `src/lib/checks/` | The checks shown on screen. |
| `src/lib/agents/` | Agent prompts, reply schemas, the Gemini call, and the two-round orchestration. |
| `src/app/api/agents/` | Server routes that hold the keys and call the model. |
| `src/components/` | The eight walkthrough steps and the charts. |
| `tests/` | Vitest tests. |

To change provider, edit `generateJson` in `src/lib/agents/gemini.ts`; nothing else calls the model.
