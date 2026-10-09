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

## The demo path

Ten stops, in order. The header stays in view throughout: a control bar with the switches
**View** (Offer or Portfolio), **Losses from** (Depth only or All loss drivers), **Flood source**
(Terrain only or Terrain + drainage) and, once a run of the agents is in force, **Assumptions**
(Agreed by agents or Reference, no AI); under it a row of figures that follows those switches
on every step. Nothing is tied to one offer: any placement memo for a building inside the
hazard maps goes through the same steps. Only three things need a network or a key, and each
says so on screen: the model reading an offer, a live run of the agents, and the map's
background tiles and building outline.

1. **Dashboard.** The app opens here with the model data loaded. With no run of the agents in
   this browser, the run saved with the app is replayed straight away. At the top is the
   **Price an offer** call-out; under it the portfolio's six figures and charts, each with its
   source badge. The total insured value carries a flag: the exposure file's values are ten
   times their own documented formula.
2. **Price an offer.** Press **Price an offer**, **Choose a file** and pick the memo (Word,
   PDF or text), then **Price this offer**. The first card says who read the file (the model,
   or the fixed rules when no key is set or **Fixed rules only** is ticked), and how many
   values code verified against the document. Each value is a row marked "Verified", "Check
   this" or "Not stated" and can be edited; **View the document** opens the memo with each
   value's sentence marked and contact details removed. The **View** switch goes to **Offer**
   and the figures row shows the building's sum insured, 1-in-100 gross loss, average annual
   loss and flood rate. The Dashboard now leads with the offer.
3. **Hazard map.** The map zooms to the building and stands it as a 3D block on its
   OpenStreetMap outline (offline, a square block at the stated coordinates). **Play the
   flood** sweeps the return periods, the slider picks one, **3D view** tilts the map, the
   chips switch layers, and zooming out shows the wards. **Flood source** switches drainage
   ponding on and off: known flood areas matched go from 12 to 16 of 24.
4. **Agents.** The run card is tagged "Saved run from <date>, model <name>" when the run that
   ships with the app is replayed. For an offer the app has not seen before, press **Run the
   agents on this offer** (needs a key and a network). **Assumptions** in the bar switches
   between **Agreed by agents** and **Reference, no AI** on every step. The chart **How much
   of the AI's change each assumption accounts for (exact Shapley values)** splits the
   difference between the two across groups of assumptions, and prints the shares added up
   beside the whole change: the same figure.
5. **How depth becomes money.** Two steps, one stop. **Vulnerability**: the JRC flood damage
   curve with the building on it, one diamond per modelled flood. **Loss engine**: one flood
   in five steps, from the water reaching the building to what the insurer pays, each line
   with its source. Flip **Losses from** to **Depth only** to see the model without the loss
   drivers.
6. **Results.** The offer's page: the flood rate and premium, with the line that they rest on
   two placeholders to be set by Kenya Re underwriting; the loss by driver at each return
   period; what the offer does to the portfolio; and **Which assumptions move the answer
   most**, a tornado of every assumption swung across its allowed range. With no offer the
   page shows the portfolio: loss curve, key figures and loss by housing class.
7. **Oasis check.** The portfolio result for the settings on screen beside the same portfolio
   run through Oasis LMF. For three settings on the starter kit a saved run is shown at once.
   For any other settings or data, **Run Oasis now on these settings** runs Oasis on this
   machine (about a minute and a half) and shows the table when it finishes. When Oasis is
   fed damage ratios the page says what that covers: "Oasis checked the loss arithmetic and
   return period maths for these damage ratios. It did not check the damage curve or the loss
   driver assumptions."
8. **Decision.** At the foot of Results: the points to weigh with their evidence, the
   suggested conditions, the rate per mille and the decision. **Download decision note** or
   **Print or save as PDF** gives one page.
9. **An offer outside the maps.** A memo for a building the loaded maps do not cover stops
   with "Outside the hazard maps loaded: flood cannot be priced here". No loss figure is
   shown, never a zero.
10. **Audit.** Every check, the extraction record, every assumption with its value, range,
    source and who set it, what each model call used, and the model data. The audit report
    prints as a PDF, and the written note and the full audit file download.

### What the live Oasis run needs

- Oasis LMF installed in WSL as [oasis/README.md](oasis/README.md) describes (the distribution
  `Ubuntu` and `~/oasis-venv` by default; `OASIS_WSL_DISTRO` and `OASIS_PYTHON` in
  `web/.env.local` change them).
- The data set on this machine's disk, in the model data folder: Oasis reads the exposure file
  from there. A data set dropped into the browser is not on disk, and the page says so.
- Nothing leaves the machine. The export and the output are written under `oasis/runs/live`,
  which is not in git, and a result that has been run once is shown again without a new run.

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
