# Mafuriko

Kenya Re catastrophe modelling hackathon · Team A · Nairobi Urban Flood Challenge

## What this is

Mafuriko is an explainable flood model for an underwriter. A broker's offer for one
building goes in as a Word, PDF or text file, and every step of the app then works on that
building to answer one question: should we take this business, and on what terms? It reads
the offer, sets the assumptions, pinpoints the building on the flood maps, works out the
damage and the loss flood by flood, and ends on a decision page with the points to weigh, the
conditions to consider and a one-page note to print. The loaded portfolio is the context
throughout: the other insured buildings around the site, the range of the building's class,
and what the offer adds to the book.

One rule holds everywhere: **language models read the document and choose assumptions; code
checks, locates, prices and reconciles.** No loss figure ever comes from a model. Every value
read from the offer is shown beside the sentence it came from and is checked against that
sentence by code before it is used. Every number on screen says where it came from, and the
checks behind it run on screen.

## Losses beyond flood depth

Read at one point on a flood map, a dry building prices at zero, even when the ground around
it floods in heavy rain, its drains are overloaded and its plant sits in a basement. So a loss
is the sum of six loss drivers, each with a stated source, and then the deductible and the
limit:

| Loss driver | What it is | Where its figures come from |
|---|---|---|
| Surrounding flooding | The highest map depth within a buffer around the building (250 m: its footprint plus the error in a stated coordinate), shown beside the depth at the point. | The hazard maps; the buffer is an assumption. |
| Drainage ponding | Shallow ponding near mapped drains and informal settlements, as before. | Open map data; reach and depths are assumptions. |
| Drain overload | When the event is rarer than the drains were designed for, the site holds 0.1 m of water even where the maps are dry. | The design return period from the offer when it states one, otherwise 1-in-25 as an assumption. |
| Basement ingress | When water at the site reaches 0.10 m and the building has basements: value below ground x a basement damage ratio that rises with the event (15% to 70%). The value below ground never loses a smaller share than the damage curve gives the structure at the same water. | The basements and the value below ground from the offer; 8% of the insured value when it states no value; the ratios are assumptions. |
| Business interruption | Outage days for the event (2 to 40) x a day's rent or revenue. Off unless the offer says it is covered. | Rent from the offer, otherwise 8% of the insured value a year; the days are assumptions. |
| Uncertainty loading | 10% on top of the five above, for causes not modelled: seepage, blocked drains, pump failure. Always its own line. | An assumption. |

The first three all put water at the same building, so the structure's loss is read once on
the damage curve, at the deepest of the three, and each driver is credited with what it adds.
Nothing is counted twice, and All loss drivers never prices a building below Depth only.

- **The switch.** "Losses from" in the header chooses **Depth only** or **All loss drivers**.
  All loss drivers is the default. Depth only is the model as it was, to the last decimal:
  the depth at the point and drainage ponding, nothing else. Tests hold it there.
- **The premium build-up.** On Results: the modelled average annual loss by driver, the
  uncertainty loading, a capital load (8% of what the offer adds to the portfolio's 1-in-100
  gross loss, so never more than 8% of the flood limit), then a minimum rate (0.1 per mille)
  as a floor. The cost of capital and the minimum rate are placeholders for figures only
  Kenya Re underwriting can set: both stay editable, both carry the badge "Assumption, to be
  set by Kenya Re underwriting" wherever they are shown, and neither is a market figure. The
  flood rate says once, beside it, that it rests on them. That gives the flood
  premium and a flood rate per mille, shown beside the offer's own all-risks rate when it
  states a premium. The offer's own flood loss history sits beside it as a sense check and
  is not blended in.
- **Broker questions.** A value the offer does not state is never guessed. The price uses a
  marked assumption, and the value is listed as a question for the broker: the basements and
  their depth, the equipment and the value below ground, the drain design, sump pumps and
  their backup power, flood barriers and non-return valves, the value split, rent, whether
  business interruption is covered, the premium. The questions are listed in full in Price an
  offer and on the decision page; the Audit step gives their count, and the print view and
  the downloads carry the list.
- **Read but not verified.** With All loss drivers, a value that switches a driver on or sets
  its size (basement levels, value below ground, drain design, interruption cover, rent) and
  fails its check holds the price back until it is confirmed, edited or cleared, like any
  other value the price rests on.
- **The portfolio.** The synthetic portfolio carries the first three drivers. It has no
  basement or rent data, so basement ingress and business interruption are not modelled for
  it. One sentence says so, on the Loss engine's portfolio view and in the records.
- **Without AI.** The reference run uses the reference values and anything the underwriter
  typed, never a figure the agents set. The buffer the agents agree is therefore part of what
  "with and without AI" shows.
- **Who set each assumption.** The offer (with its sentence), the agents (with the Chair's
  reason), the underwriter (typed on screen) or the reference value. The Audit step lists all
  19 with their allowed ranges.

## How to run it

You need Node.js 20 or newer.

1. **Model data.** The hazard maps, the exposure file and the flood areas are read from the
   folder `data/data` at the root of this repository (the hackathon starter kit, with
   `team_a_nairobi` inside it). To keep them elsewhere, set `MODEL_DATA_DIR` in
   `web/.env.local`. If the folder is missing, the app opens on a small built-in sample and
   says so.
2. **Keys.** Copy `web/.env.example` to `web/.env.local` and paste in the provider key:
   `OPENAI_API_KEY`, or the `GEMINI_API_KEY` settings. `AGENT_PROVIDER` chooses between them.
   Without a key the app still runs end to end: the offer is read by fixed rules, the Agents
   step replays the run saved with the app (from `web/public/agents`), and the screen says
   so. With no saved run shipped, the model uses its reference assumptions.
3. **Start it.**

   ```bash
   cd web
   npm install
   npm run build && npm start      # http://localhost:3000
   ```

   For development use `npm run dev` instead of the last line. More detail, the settings and
   the tests are in [web/README.md](web/README.md).

## A five-minute demo

Ten stops, in order. The header stays in view throughout: a control bar with the switches
**View** (Offer or Portfolio), **Losses from** (Depth only or All loss drivers), **Flood source**
(Terrain only or Terrain + drainage) and, once a run of the agents is in force, **Assumptions**
(Agreed by agents or Reference, no AI); under it a row of four figures that follows those
switches on every step. Nothing below needs a key or a network connection; where a stop is
different offline, it says so.

1. **Dashboard.** The app opens here with the Nairobi starter kit loaded. With no run of the
   agents in this browser, the run saved with the app is replayed straight away, so the
   assumptions in force are the agents'. At the top is the **Price an offer** call-out; under
   it the portfolio's six figures and charts. The total insured value carries a flag: the
   exposure file's values are a fixed multiple of their own documented formula, and Read the
   data explains it.
2. **Give it the offer.** Press **Price an offer**, then **Choose a file** and pick the
   Landmark Plaza memo (a Word, PDF or text file), or open `http://localhost:3000/?offer=1`,
   which loads the Nairobi test offer from `data/test-data` and reads it straight away. The
   **View** switch goes to **Offer**, and the row of four figures now shows the building's sum
   insured, 1-in-100 gross loss, average annual loss and flood rate.
3. **Price an offer.** The first card says who read the file (the model, or the fixed rules
   when no key is set), where pricing stands and how many values need your check; its button
   **See the building on the hazard map** jumps ahead. Below it each extracted value is a
   compact row marked "Verified", "Check this" or "Not stated", and any value can be edited
   or confirmed; a value code could not check holds the price back until it is settled.
   **View the document** opens the memo with each value's sentence marked. What the document
   leaves out is folded below as questions for the broker.
4. **Hazard map.** The map zooms to the building and stands it as a 3D block on its
   OpenStreetMap outline, with the buffer ring and the portfolio's buildings around it.
   Offline there is no outline to look up, so a square block of approximate shape marks the
   stated coordinates instead. The call-out beside the building gives the water at the site
   and the loss in the flood chosen. In the control strip above the map, **Play the flood**
   sweeps the return periods from the most frequent to the rarest, the slider picks one,
   **3D view** tilts the map and the chips switch layers; the fullscreen button takes the
   strip, the map and the key with it.
5. **Losses from.** Flip **Losses from** to **Depth only**: the figures row and every step
   go back to the depth at the building's point and drainage ponding, the model as it was
   before the loss drivers, to the last decimal. Flip it back to **All loss drivers** to see
   what surrounding flooding, drain overload, basement ingress and the uncertainty loading add.
6. **Agents.** The run card is tagged "Saved run from <date>, model <name>": the run that
   ships with the app, its replies as given and every figure worked out again by code. **Run
   the agents** makes a live run when a key is set. The card under it shows what their
   judgement does to this offer: the flood rate under the reference, optimistic, cautious and
   agreed assumptions, and the spread to carry. **Assumptions** in the bar switches between
   **Agreed by agents** and **Reference, no AI** on every step, from the saved run alone.
7. **Vulnerability.** The JRC flood damage curve with the building on it: one diamond for each
   flood modelled, at its depth of water and its share of value lost. Below, the building as
   components: the structure, the value below ground on the basement ladder, and lost rent
   or revenue.
8. **Loss engine.** One flood, step by step, in five steps: how much water reaches the
   building, what the water damages, what the model cannot see, the damage in full, and what
   the insurer pays after the deductible and the limit. Each line names its source.
9. **Results.** The offer's page: the flood rate and the flood premium, with the line that
   they rest on two placeholders to be set by Kenya Re underwriting (the capital load and the
   minimum rate: the minimum rate is editable under **How the flood rate is built up**, both
   are editable in the Agents step's table of assumptions), the loss by driver at
   each return period, what the offer does to the portfolio, the points to weigh and the
   suggested conditions. Record a decision, then **Download decision note** or **Print or save
   as PDF**: one page. **Independent check: the portfolio run through Oasis LMF** follows the
   header settings: with **Reference, no AI** selected it shows the Oasis run for Terrain
   only or Terrain + drainage with Depth only, and for Terrain + drainage with All loss
   drivers; any other combination says "Not checked by Oasis for these settings".
10. **Audit.** Every check, the extraction record, every assumption beyond flood depth with
    its value, range, source and who set it, what each model call used, and the model data.
    **Download the building-level export** gives, for the settings in force, each building's
    depth and final damage ratio at every return period: the file Oasis is fed. The audit
    report prints as a PDF, and the written note and the full audit file download.

An offer for a building outside the maps (the Nzoia test offer, for example) stops with
"Outside the hazard maps loaded: flood cannot be priced here" and shows no loss figure.

## What is real, synthetic, assumed and from AI

The app marks every figure with one of four badges.

| Badge | What carries it |
|---|---|
| Real data | The terrain and the mapped rivers behind the hazard maps; the county's named flood areas; OpenStreetMap rivers, drains, settlement outlines and building outlines; the ward boundaries; the published damage curve; the words of the offer document. |
| Synthetic | The portfolio: every building, its location and its insured value. It is not a real client's holdings. Its insured values are as written in the exposure file, a fixed multiple of the formula documented with it; every total of them on screen and in the records carries that flag. |
| Assumption | Reading the hazard score as a depth; the return period given to each map; the fragility and damage cap of each construction class; the drainage ponding rule; the 19 figures behind the loss drivers beyond depth (buffer, drain design and overload depth, ingress threshold, basement damage ladder, value below ground, outage days, rent, uncertainty loading, cost of capital, minimum rate); the example insurance terms used where an offer states none; the thresholds behind the flags. |
| AI | The values read from an offer by the hosted model, each checked against its sentence by code; the assumptions the agents agree, each with its reason and kept in its range by code. Never a loss. |

The limits of all this are stated in the app, in the written note and in section 10 of the
plan.

## Where to look next

- [PLAN.md](PLAN.md): the model, the decisions, the checks and the honest limits.
- [web/README.md](web/README.md): running, settings, the steps and where the code is.
- [oasis/](oasis/README.md): the same portfolio run through the open-source Oasis LMF engine
  as an independent check, for three settings of the header: Terrain only and Terrain +
  drainage with Depth only, and Terrain + drainage with All loss drivers.
- [web/public/geo/SOURCES.md](web/public/geo/SOURCES.md): the source and licence of every
  map layer.
