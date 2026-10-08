# Mafuriko

Kenya Re catastrophe modelling hackathon · Team A · Nairobi Urban Flood Challenge

## What this is

Mafuriko is an explainable flood model for an underwriter. A broker's offer for one
building goes in as a Word, PDF or text file, and every step of the app then works on that
building to answer one question: should we take this business, and on what terms? It reads
the offer, pinpoints the building on the flood maps, sets the assumptions, works out the
damage and the loss flood by flood, and ends on a decision page with the points to weigh, the
conditions to consider and a one-page note to print. The loaded portfolio is the context
throughout: the other insured buildings around the site, the range of the building's class,
and what the offer adds to the book.

One rule holds everywhere: **language models read the document and choose assumptions; code
checks, locates, prices and reconciles.** No loss figure ever comes from a model. Every value
read from the offer is shown beside the sentence it came from and is checked against that
sentence by code before it is used. Every number on screen says where it came from, and the
checks behind it run on screen.

## How to run it

You need Node.js 20 or newer.

1. **Model data.** The hazard maps, the exposure file and the flood areas are read from the
   folder `data/data` at the root of this repository (the hackathon starter kit, with
   `team_a_nairobi` inside it). To keep them elsewhere, set `MODEL_DATA_DIR` in
   `web/.env.local`. If the folder is missing, the app opens on a small built-in sample and
   says so.
2. **Keys.** Copy `web/.env.example` to `web/.env.local` and paste in the provider key:
   `OPENAI_API_KEY`, or the `GEMINI_API_KEY` settings. `AGENT_PROVIDER` chooses between them.
   Without a key the app still runs end to end: the offer is read by fixed rules, the model
   uses reference assumptions, and the screen says so.
3. **Start it.**

   ```bash
   cd web
   npm install
   npm run build && npm start      # http://localhost:3000
   ```

   For development use `npm run dev` instead of the last line. More detail, the settings and
   the tests are in [web/README.md](web/README.md).

## A three-minute demo

1. **Dashboard.** The app opens here with the model already loaded: the portfolio, its
   flood losses and a card to drop an offer on.
2. **Drop the offer.** Drop the Nairobi test offer on the card, or open
   `http://localhost:3000/?offer=1`, which loads it from `data/test-data` and reads it
   straight away. The header switches to **Offer**, and its figures strip now shows this
   building's sum insured, 1-in-100 gross loss, average annual loss, pure rate and its effect
   on the portfolio.
3. **Read the offer.** The document is on one side with every extracted value's sentence
   highlighted; the values are on the other in the exposure file's shape, each marked
   "AI, verified", "AI, unverified" or "rules". Click a value to see its sentence. Any value
   can be edited, and a value that fails its check holds the price back until it is settled.
4. **Hazard map.** The map zooms to the building and draws its outline from OpenStreetMap,
   with the portfolio's insured buildings around it. Move the return period slider and read
   the depth at the building, terrain and drainage ponding apart, and the distances to the
   nearest flood water, river and drain.
5. **Agents.** Run the panel. An Optimist, a Cautious voice and a Critic work in parallel
   and a Chair settles the assumptions. The step shows what their judgement does to this
   offer's price: the same building under the reference, optimistic, cautious and agreed
   assumptions.
6. **Vulnerability.** The building's points sit on the damage curve of its construction
   class, one per return period, beside the range for that class in the portfolio.
7. **Loss engine.** The single-building trace: depth, damage ratio, ground-up loss,
   deductible, limit and gross loss for each return period, each line naming its source.
8. **Results.** The decision page: the offer in one line, the headline figures, the loss
   chart, the flags with their evidence sorted by severity, and suggested conditions. Record
   Accept, Accept with conditions, Refer or Decline with a note, then **Download decision
   note** for a one-page printable summary.
9. **Audit.** Every check, the extraction record, what each model call used, and where the
   model data came from, with the audit report as a PDF, the written note and the full audit
   file as downloads.

The **Offer / Portfolio** switch in the header returns to the portfolio view of every step at
any time. An offer for a building outside the maps (the Nzoia test offer, for example) stops
with "Outside the hazard maps loaded: flood cannot be priced here" and shows no loss figure.

## What is real, synthetic, assumed and from AI

The app marks every figure with one of four badges.

| Badge | What carries it |
|---|---|
| Real data | The terrain and the mapped rivers behind the hazard maps; the county's named flood areas; OpenStreetMap rivers, drains, settlement outlines and building outlines; the ward boundaries; the published damage curve; the words of the offer document. |
| Synthetic | The portfolio: every building, its location and its insured value. It is not a real client's holdings. |
| Assumption | Reading the hazard score as a depth; the return period given to each map; the fragility and damage cap of each construction class; the drainage ponding rule; the example insurance terms used where an offer states none; the thresholds behind the flags. |
| AI | The values read from an offer by the hosted model, each checked against its sentence by code; the assumptions the agents agree, each with its reason. Never a loss. |

The limits of all this are stated in the app, in the written note and in section 10 of the
plan.

## Where to look next

- [PLAN.md](PLAN.md): the model, the decisions, the checks and the honest limits.
- [web/README.md](web/README.md): running, settings, the steps and where the code is.
- [oasis/](oasis/README.md): the same portfolio run through the open-source Oasis LMF engine
  as an independent check of the loss arithmetic.
- [web/public/geo/SOURCES.md](web/public/geo/SOURCES.md): the source and licence of every
  map layer.
