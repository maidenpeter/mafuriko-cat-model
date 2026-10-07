# Oasis LMF check of the loss engine

This folder runs our Nairobi flood model through Oasis LMF, the open-source catastrophe
modelling platform used across the insurance and reinsurance industry (Python package
`oasislmf`, version 2.5.8). It is an independent check of our financial engine and our
return period maths: same inputs, two engines, numbers side by side.

`build_and_run.py` does five things:

1. Reads the exposure file and the parameters (the reference set, or a params JSON).
2. Writes them in Oasis formats: an OED location and account file, precomputed keys, and a
   small Oasis model (events, occurrence, footprint, vulnerability, damage bins).
3. Runs the real Oasis loss engine (`oasislmf model run`), ground-up loss only.
4. Reads the Oasis ORD outputs: event loss table, OEP and AEP curves, average annual loss.
5. Recomputes our own engine in Python (`engine.py`, a line by line copy of
   `web/src/lib/model`) and writes a comparison JSON for the web app
   (`web/public/oasis/reference.json`).

## Result for the reference parameters (file TIV)

| Tier | Return period | Our engine (KES) | Oasis (KES) | Difference |
|---|---|---|---|---|
| extreme | 1 in 10 | 380,527,457 | 380,371,008 | -0.041% |
| severe | 1 in 25 | 739,364,955 | 739,143,040 | -0.030% |
| moderate | 1 in 50 | 1,952,414,104 | 1,952,820,864 | +0.021% |
| occasional | 1 in 100 | 3,581,174,278 | 3,581,434,368 | +0.007% |
| common | 1 in 250 | 5,945,505,626 | 5,944,936,960 | -0.010% |

Oasis OEP and AEP at 1 in 10, 25, 50, 100 and 250 equal the event losses above exactly.

| Average annual loss | KES |
|---|---|
| Oasis (average over 1,000 periods) | 102,401,680 |
| Our losses, same banded sum | 102,412,156 (-0.010%) |
| Our app (trapezoid) | 140,544,567 |

The small event differences come only from Oasis storing depth in 1 mm bins and damage in
0.1% steps. Our engine with the same rounding matches Oasis to 0.00001%.

## How our model is written in Oasis terms

| Oasis piece | What we put in it |
|---|---|
| OED location file | One row per building: CountryCode KE, LocPerilsCovered OSF (OED code for flash, surface and pluvial flood), BuildingTIV, LocCurrency KES, OccupancyCode 1050 (residential), ConstructionCode by class (5201 light metal, 5101 adobe, 5100 masonry, 5150 reinforced concrete), FlexiLocHousingClass |
| OED account file | One account and one policy with no financial terms (ground-up only) |
| Keys | Precomputed `keys.csv`: each building is its own area peril; vulnerability id = housing class. No lookup server needed |
| Events | Five events, one per tier: 1 extreme, 2 severe, 3 moderate, 4 occasional, 5 common |
| Footprint | For each event and each wet building: depth = score x tier slope x depth scale, in 1 mm bins, probability 1 |
| Vulnerability | Four functions, one per housing class: damage = min(JRC Africa residential curve(depth x fragility), cap), taken at each depth bin's midpoint, probability 1 |
| Damage bins | 1,001 point bins from 0 to 1 in 0.1% steps, so every sample equals the mean |
| Occurrence | P periods. Each event occurs in a share of periods equal to its exceedance band. For 10, 25, 50, 100 and 250 years: 1,000 periods, with the extreme event in 60, severe in 20, moderate in 10, occasional in 6, common in 4 and no event in 900 |
| Analysis settings | Ground-up only, 10 samples, ORD outputs: ELT (sample and moment), PLT, ALT, EPT (mean damage, full uncertainty, per-sample mean, sample mean) |

Because the n-th largest period loss sits at return period P / n, the loss at 1 in 10
(the 100th of 1,000) is the extreme event's loss, at 1 in 25 (the 40th) the severe event's,
and so on. P is chosen so every P / return period is a whole number (for 12.5, 30, 60, 150
and 400 it is 1,200).

## Why the Oasis AAL is lower than the app's AAL

Oasis averages the loss over all periods, so each event's loss counts for exactly its own
band of probability: 6% x extreme + 2% x severe + 1% x moderate + 0.6% x occasional
+ 0.4% x common. That is a step curve. The app draws straight lines between the five points
on the loss against annual exceedance probability chart (trapezoid), which adds half of each
step. Both treat anything more frequent than 1 in 10 as no loss and hold the 1 in 250 loss
for anything rarer, so the gap is only the shape assumed between the points: KES 38.1m, or
37% above the step value. `ourDiscreteKes` in the JSON is the step value from our own losses,
so it is the like for like figure to compare with Oasis.

## How to run it

You need Python 3.10 or newer. Run everything from the project root.

### Linux, macOS, or Windows through WSL

```bash
python3 -m venv ~/oasis-venv
~/oasis-venv/bin/pip install -r oasis/requirements.txt
~/oasis-venv/bin/oasislmf warmup        # optional, compiles the engine once (3 to 6 minutes)
~/oasis-venv/bin/python oasis/build_and_run.py \
    --data-dir data/data/team_a_nairobi \
    --out web/public/oasis/reference.json
```

The run takes about a minute once the engine is compiled. Without `warmup`, the first run
compiles it and takes a few minutes longer.

### Windows

PyPI ships Windows builds of `oasislmf`, so the install works, but `oasislmf model run`
drives the engine through a generated bash script that uses named pipes. Run it inside WSL
(Ubuntu) with the Linux steps above, or in any Linux Python 3.10+ Docker container. We built
and tested this on Ubuntu 22.04 with Python 3.10; we have not run it on native Windows.

If the project sits on the Windows drive (for example `/mnt/c/...` in WSL), that is fine: the
script runs Oasis in a scratch folder in the system temp folder and copies the results back.
The Oasis kernel script does not cope with spaces in its own folder path (our project folder
name has spaces), and a local Linux folder is faster and safer for the named pipes and links
it creates.

### Options

| Flag | Meaning |
|---|---|
| `--data-dir` | Folder with the `*with_hazard*.csv` exposure file and, optionally, the five hazard GeoTIFFs |
| `--params` | Params JSON of the app's shape `{"depthScaleM", "fragility", "cap", "returnPeriods"}`. Default: the reference parameters. Values are held inside the app's bounds, and any change is listed in the notes |
| `--tiv-basis` | `file` (default) keeps `tiv_kes`; `documented` uses floor area x cost per m2 rounded to the nearest KES 5,000 |
| `--out` | Where to write the comparison JSON |
| `--samples` | Oasis samples per event (default 10) |
| `--min-periods` | Smallest period set (default 1,000) |
| `--intensity-step-m`, `--damage-step` | Bin sizes (defaults 0.001 m and 0.001) |
| `--slopes-from` | `auto` (rasters when readable, else columns), `rasters` or `columns` |
| `--work-dir` | Scratch folder for the Oasis run (default: system temp) |
| `--parse-only` | Re-read the outputs of the last run without running Oasis again |

Example with your own parameters and the documented TIV:

```bash
~/oasis-venv/bin/python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \
    --params my_params.json --tiv-basis documented --out web/public/oasis/documented.json
```

## What gets written

- `web/public/oasis/<name>.json`: the comparison the web app reads (events, OEP, AEP, AAL,
  largest event difference, plain-English notes).
- `oasis/runs/<dataset>_<tiv basis>_<params id>/` (ignored by git, it holds the hackathon data):
  - `exposure/`: OED location and account files and the keys file.
  - `model_data/`: the binary model files Oasis reads; `model_data_csv/` holds the same as CSV.
  - `analysis_settings.json`, `oasislmf.log`, `comparison_detail.json` (all variants of every
    number, including the slopes fitted both ways).
  - `oasis_run/`: what Oasis generated: its input files, ORD outputs in `output/`
    (`gul_S1_melt.csv`, `gul_S1_ept.csv`, `gul_S1_palt.csv` and others) and logs.

## What this checks

- That our losses per event add up the same way in an industry engine.
- That the loss at each return period and the OEP and AEP curves follow from the event
  losses and their probabilities as we claim.
- That the AAL difference between Oasis and the app is fully explained by the curve shape
  (step against trapezoid) and nothing else.

## What this does not check

- The hazard itself: the scores, the tier slopes, the 4 m depth scale and the return periods
  given to each tier. Both engines read the same depths.
- The vulnerability: the JRC curve, fragility multipliers and caps. Our code writes the Oasis
  vulnerability functions from the same formula, so a wrong curve would be wrong in both.
- The TIV values in the file.
- Financial terms (deductibles, limits), reinsurance, secondary uncertainty and correlation:
  the model is deterministic and ground-up only.

## Limits

- Five events only. Between the five return periods Oasis shows steps, while the app
  interpolates against log return period; the two agree at the five points.
- Depth bins of 1 mm and damage steps of 0.1% keep each event within 0.1% of our engine.
  Smaller bins are possible with the flags above, at the cost of memory (Oasis holds a
  depth bins x damage bins table per housing class).
- Oasis stores TIV and losses as 32-bit numbers, about seven significant digits.
- In the rare case that whole period counts would need more than 5 million periods, the
  counts are rounded on 100,000 periods and the notes give the return periods actually used.
- The `aalpy` step reserves 4 GB of memory by default; the script lowers this to 0.5 GB
  (`OASIS_AAL_MEMORY`) so it runs on small machines.
- Slopes are fitted on the GeoTIFFs only when `tifffile` and `imagecodecs` are installed;
  otherwise on the building columns, which give the same slopes to within 0.0000001 here.
