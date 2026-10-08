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
| `src/lib/agents/` | Agent prompts, reply schemas, the OpenAI and Gemini calls, and the two-round orchestration. |
| `src/app/api/agents/` | Server routes that hold the keys and call the model. |
| `src/components/` | The nine walkthrough steps, the risk map and the charts. |
| `tests/` | Vitest tests. |

Only `openai.ts` and `gemini.ts` in `src/lib/agents/` call a model, and `provider.ts` picks between them.
To add another provider, write a third file with the same three functions and list it in `provider.ts`.
