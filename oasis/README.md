# Oasis LMF check of the loss engine

This folder runs our Nairobi flood model through Oasis LMF, the open-source catastrophe
modelling platform used across the insurance and reinsurance industry (Python package
`oasislmf`, version 2.5.8). It is an independent check of our damage function, our financial
engine and our return period maths: same inputs, two engines, numbers side by side.

There are three runs, one for each setting of the header bar that the app ships a check for.
Each is fed by the app's own building-level export for that setting, so Oasis checks what the
screen shows and not a separate copy of it.

| Run | Flood source | Losses from | Oasis is given | What it proves |
|---|---|---|---|---|
| `reference.json` | Terrain only | Depth only | The depth at every building (`--depths`) | The damage function, the financial engine, and the EP and AAL maths |
| `reference-drainage.json` | Terrain + drainage | Depth only | The depth at every building, drainage ponding included (`--depths`) | The same three, with drainage ponding in the depths |
| `reference-drivers.json` | Terrain + drainage | All loss drivers | The final damage ratio at every building (`--damage-ratios`) | The financial engine and the EP and AAL maths, with every loss driver in the damage. Not the damage function or the drivers |

All three use the reference assumptions with nothing typed over. For any other combination
(assumptions agreed by the agents, a typed figure that reaches the portfolio, or Terrain only
with All loss drivers) the app says "Not checked by Oasis for these settings" and shows no
figures.

`build_and_run.py` does five things:

1. Reads the exposure file, and either the app's building-level export (`--depths` or
   `--damage-ratios`) or, with neither, the parameters to work the depths out itself.
2. Writes them in Oasis formats: an OED location and account file, precomputed keys, and a
   small Oasis model (events, occurrence, footprint, vulnerability, damage bins).
3. Runs the real Oasis loss engine (`oasislmf model run`), ground-up loss only.
4. Reads the Oasis ORD outputs: event loss table, OEP and AEP curves, average annual loss.
5. Sets our own figures beside them and writes a comparison JSON for the web app
   (`web/public/oasis/<name>.json`), with the view it was made for copied from the export.

## Results

Reference assumptions, insured values as in the file (file TIV), 600 buildings, 10 samples,
1,000 periods. Oasis LMF 2.5.8, run on 8 October 2026.

### 1. Terrain only, Depth only (`reference.json`, result fingerprint `bdc87191`)

| Tier | Return period | Our engine (KES) | Oasis (KES) | Difference |
|---|---|---|---|---|
| extreme | 1 in 10 | 380,527,457 | 380,371,008 | -0.041% |
| severe | 1 in 25 | 739,364,955 | 739,143,040 | -0.030% |
| moderate | 1 in 50 | 1,952,414,104 | 1,952,820,864 | +0.021% |
| occasional | 1 in 100 | 3,581,174,278 | 3,581,434,368 | +0.007% |
| common | 1 in 250 | 5,945,505,626 | 5,944,936,960 | -0.010% |

| Average annual loss | KES |
|---|---|
| Oasis (average over 1,000 periods) | 102,401,680 |
| Our losses, same banded sum | 102,412,156 (Oasis is -0.010%) |
| Our app (trapezoid) | 140,544,567 |

These are the same figures as the run made before the export existed, to the shilling: the
depths the script worked out itself and the depths the app exports are the same depths.

### 2. Terrain + drainage, Depth only (`reference-drainage.json`, result fingerprint `b6cc5322`)

| Tier | Return period | Our engine (KES) | Oasis (KES) | Difference |
|---|---|---|---|---|
| extreme | 1 in 10 | 592,233,279 | 591,737,984 | -0.084% |
| severe | 1 in 25 | 1,062,456,260 | 1,061,915,456 | -0.051% |
| moderate | 1 in 50 | 2,399,524,295 | 2,400,825,856 | +0.054% |
| occasional | 1 in 100 | 4,044,755,944 | 4,043,869,184 | -0.022% |
| common | 1 in 250 | 6,471,817,611 | 6,471,403,008 | -0.006% |

| Average annual loss | KES |
|---|---|
| Oasis (average over 1,000 periods) | 130,899,672 |
| Our losses, same banded sum | 130,934,171 (Oasis is -0.026%) |
| Our app (trapezoid) | 173,918,884 |

### 3. Terrain + drainage, All loss drivers (`reference-drivers.json`, result fingerprint `0b90e5f6`)

Reference assumptions beyond flood depth: 250 m buffer, drains designed for 1 in 25, 0.1 m of
water when they are overloaded.

| Tier | Return period | Our engine (KES) | Oasis (KES) | Difference |
|---|---|---|---|---|
| extreme | 1 in 10 | 2,688,729,816 | 2,687,139,328 | -0.059% |
| severe | 1 in 25 | 4,794,503,863 | 4,793,667,072 | -0.017% |
| moderate | 1 in 50 | 9,082,803,750 | 9,089,346,560 | +0.072% |
| occasional | 1 in 100 | 11,981,528,697 | 11,984,833,536 | +0.028% |
| common | 1 in 250 | 15,473,448,347 | 15,478,381,568 | +0.032% |

| Average annual loss | KES |
|---|---|
| Oasis (average over 1,000 periods) | 481,817,696 |
| Our losses, same banded sum | 481,824,869 (Oasis is -0.001%) |
| Our app (trapezoid) | 612,850,473 |

In all three runs the Oasis OEP and AEP at 1 in 10, 25, 50, 100 and 250 equal the event losses
above exactly.

The small event differences come only from the Oasis model files being discrete. In runs 1
and 2 depth is stored in 1 mm bins and damage in 0.1% steps; in run 3 the damage ratio is
stored in 0.1% steps. Our figures with the same rounding match Oasis to 0.00003% or better in
every run. In runs 1 and 2 the Python copy of the damage function gives the app's own damage
ratio at every building to within 2.2e-16, the last digit a computer keeps.

## How our model is written in Oasis terms

| Oasis piece | What we put in it |
|---|---|
| OED location file | One row per building: CountryCode KE, LocPerilsCovered OSF (OED code for flash, surface and pluvial flood), BuildingTIV, LocCurrency KES, OccupancyCode 1050 (residential), ConstructionCode by class (5201 light metal, 5101 adobe, 5100 masonry, 5150 reinforced concrete), FlexiLocHousingClass |
| OED account file | One account and one policy with no financial terms (ground-up only) |
| Keys | Precomputed `keys.csv`: each building is its own area peril; vulnerability id = housing class. No lookup server needed |
| Events | Five events, one per tier: 1 extreme, 2 severe, 3 moderate, 4 occasional, 5 common |
| Footprint, with depths | For each event and each wet building: the depth, in 1 mm bins, probability 1. The depth comes from the export (`--depths`) or, with neither CSV, is score x tier slope x depth scale |
| Vulnerability, with depths | Four functions, one per housing class: damage = min(JRC Africa residential curve(depth x fragility), cap), taken at each depth bin's midpoint, probability 1 |
| Footprint, with damage ratios | For each event and each damaged building: the final damage ratio from the export, in 0.1% bins, probability 1. The intensity bins are the damage bins |
| Vulnerability, with damage ratios | The identity, once per housing class: each intensity bin maps to the damage bin of the same value, probability 1. Oasis adds nothing to the damage it is given |
| Damage bins | 1,001 point bins from 0 to 1 in 0.1% steps, so every sample equals the mean |
| Occurrence | P periods. Each event occurs in a share of periods equal to its exceedance band. For 10, 25, 50, 100 and 250 years: 1,000 periods, with the extreme event in 60, severe in 20, moderate in 10, occasional in 6, common in 4 and no event in 900 |
| Analysis settings | Ground-up only, 10 samples, ORD outputs: ELT (sample and moment), PLT, ALT, EPT (mean damage, full uncertainty, per-sample mean, sample mean) |

Because the n-th largest period loss sits at return period P / n, the loss at 1 in 10
(the 100th of 1,000) is the extreme event's loss, at 1 in 25 (the 40th) the severe event's,
and so on. P is chosen so every P / return period is a whole number (for 12.5, 30, 60, 150
and 400 it is 1,200).

## Why two ways of feeding Oasis

For the portfolio, every loss driver acts by putting water at the building: the depth at the
point, the deepest water within the buffer, drainage ponding and drain overload. The loss is
the damage function read once, at the deepest of them, times the insured value.

- **Depths (`--depths`).** Oasis is given the depth and applies the damage function itself,
  from vulnerability files this script writes. A wrong step in the app's damage function, its
  cap or its fragility would show as a difference.
- **Damage ratios (`--damage-ratios`).** Oasis is given the finished damage ratio (loss over
  insured value, after every driver in force) and an identity vulnerability. It cannot check
  how the ratio was reached, but it works for any set of loss drivers, whatever they are, and
  it checks the part that follows: ratio times insured value, the sum over the portfolio, the
  exceedance curve and the average annual loss.

## Why the Oasis AAL is lower than the app's AAL

Oasis averages the loss over all periods, so each event's loss counts for exactly its own
band of probability: 6% x extreme + 2% x severe + 1% x moderate + 0.6% x occasional
+ 0.4% x common. That is a step curve. The app draws straight lines between the five points
on the loss against annual exceedance probability chart (trapezoid), which adds half of each
step. Both treat anything more frequent than 1 in 10 as no loss and hold the 1 in 250 loss
for anything rarer, so the gap is only the shape assumed between the points: KES 38.1m (37%
above the step value) in run 1, KES 43.0m (33%) in run 2 and KES 131.0m (27%) in run 3.
`ourDiscreteKes` in the JSON is the step value from our own losses, so it is the like for
like figure to compare with Oasis.

## How to run it

You need Python 3.10 or newer for Oasis and Node for the export. Run the Python commands
from the project root.

### 1. The Oasis environment (Linux, macOS, or Windows through WSL)

```bash
python3 -m venv ~/oasis-venv
~/oasis-venv/bin/pip install -r oasis/requirements.txt
~/oasis-venv/bin/oasislmf warmup        # optional, compiles the engine once (3 to 6 minutes)
```

If `python3 -m venv` fails because the system Python has no `venv` or `pip` (a fresh Ubuntu
in WSL), or its Python is too new for `oasislmf` 2.5.8, the standalone `uv` tool builds the
same environment with Python 3.10 and needs no root:

```bash
mkdir -p ~/oasis-tools
curl -LsSf https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C /tmp
cp /tmp/uv-x86_64-unknown-linux-gnu/uv ~/oasis-tools/uv
~/oasis-tools/uv venv --python 3.10 ~/oasis-venv
~/oasis-tools/uv pip install --python ~/oasis-venv/bin/python -r oasis/requirements.txt
```

The three runs below were made this way, in WSL (Ubuntu) on Windows, with Python 3.10.

### 2. The building-level exports

The app writes one row per building and return period for the settings in force: the depth of
water at the site and the final ground-up damage ratio. Two comment lines head the file; the
second carries the view (flood source, losses from, the assumptions, the result fingerprint)
as one line of JSON.

For the three shipped runs, make the exports with the app's own library on the starter kit:

```bash
cd web
node scripts/export-buildings.mjs          # writes ../oasis/runs/exports/
cd ..
```

It writes three CSV files (and the view of each as JSON) and prints each one's fingerprint
and event losses:

- `team_a_nairobi_terrain_depth-only.csv`
- `team_a_nairobi_drainage_depth-only.csv`
- `team_a_nairobi_drainage_all-drivers.csv`

For any other settings, choose them in the header bar of the app, open the Audit step and
press "Download the building-level export". The file is the same format.

The exports hold the starter kit's buildings, so they stay out of git: `oasis/runs/` is
ignored. Do not move them elsewhere in the repository.

### 3. The three runs

```bash
# 1. Terrain only, Depth only
~/oasis-venv/bin/python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \
    --depths oasis/runs/exports/team_a_nairobi_terrain_depth-only.csv \
    --out web/public/oasis/reference.json

# 2. Terrain + drainage, Depth only
~/oasis-venv/bin/python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \
    --depths oasis/runs/exports/team_a_nairobi_drainage_depth-only.csv \
    --out web/public/oasis/reference-drainage.json

# 3. Terrain + drainage, All loss drivers, reference assumptions
~/oasis-venv/bin/python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \
    --damage-ratios oasis/runs/exports/team_a_nairobi_drainage_all-drivers.csv \
    --out web/public/oasis/reference-drivers.json
```

Each run takes about a minute once the engine is compiled. Without `warmup`, the first run
compiles it and takes about seven minutes.

The script stops, and writes nothing, when the export does not match the exposure file
(buildings, housing classes or insured values) or when its rows do not reproduce the event
losses in its own view. `npm test` in `web` then checks that each of the three files carries
the fingerprint of the result the app gives now.

### With neither CSV

```bash
~/oasis-venv/bin/python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \
    --out some-folder/terrain.json
```

This is the run as it was before the export existed: the script works the depths out itself
(score x tier slope x depth scale), terrain only. It gives the figures of run 1 exactly. Its
output names no view, so the app does not show it; use it to try other parameters with
`--params`.

### Windows

PyPI ships Windows builds of `oasislmf`, so the install works, but `oasislmf model run`
drives the engine through a generated bash script that uses named pipes. Run it inside WSL
(Ubuntu) with the Linux steps above, or in any Linux Python 3.10+ Docker container. We have
not run it on native Windows.

If the project sits on the Windows drive (for example `/mnt/c/...` in WSL), that is fine: the
script runs Oasis in a scratch folder in the system temp folder and copies the results back.
The Oasis kernel script does not cope with spaces in its own folder path (our project folder
name has spaces), and a local Linux folder is faster and safer for the named pipes and links
it creates.

### Options

| Flag | Meaning |
|---|---|
| `--data-dir` | Folder with the `*with_hazard*.csv` exposure file and, optionally, the five hazard GeoTIFFs |
| `--depths` | The app's building-level export. Its depths are used and the damage function is applied here, so Oasis checks the damage function too |
| `--damage-ratios` | The app's building-level export. Its final damage ratios are used with an identity vulnerability, so Oasis checks the financial engine and the EP and AAL maths for any set of loss drivers. Give `--depths` or `--damage-ratios`, not both |
| `--view` | View JSON of the export, for a CSV that does not carry it on its comment line |
| `--params` | Params JSON of the app's shape `{"depthScaleM", "fragility", "cap", "returnPeriods"}`. Default: the parameters in the export's view, or the reference parameters with neither CSV. Values are held inside the app's bounds, and any change is listed in the notes. With a CSV the return periods are always the export's |
| `--tiv-basis` | `file` (default) keeps `tiv_kes`; `documented` uses floor area x cost per m2 rounded to the nearest KES 5,000. With a CSV only `file` is allowed: the export carries the app's insured values |
| `--out` | Where to write the comparison JSON |
| `--samples` | Oasis samples per event (default 10) |
| `--min-periods` | Smallest period set (default 1,000) |
| `--intensity-step-m`, `--damage-step` | Bin sizes (defaults 0.001 m and 0.001) |
| `--slopes-from` | With neither CSV: `auto` (rasters when readable, else columns), `rasters` or `columns` |
| `--run-name` | Folder name under `oasis/runs` (default: built from the dataset, the mode and the view's fingerprint; with neither CSV, from the dataset, the TIV basis and the parameters) |
| `--work-dir` | Scratch folder for the Oasis run (default: system temp) |
| `--parse-only` | Re-read the outputs of the last run without running Oasis again |

Example with your own parameters and the documented TIV, with neither CSV:

```bash
~/oasis-venv/bin/python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \
    --params my_params.json --tiv-basis documented --out web/public/oasis/documented.json
```

## What gets written

- `web/public/oasis/<name>.json`: the comparison the web app reads (events, OEP, AEP, AAL,
  largest event difference, plain-English notes), with `mode` (`depths` or `damage_ratios`)
  and `view`, the export's header. It holds totals only, never a building.
- `oasis/runs/exports/` (ignored by git): the building-level exports.
- `oasis/runs/<dataset>_<mode>_<fingerprint>/` (ignored by git, it holds the hackathon data):
  - `exposure/`: OED location and account files and the keys file.
  - `model_data/`: the binary model files Oasis reads; `model_data_csv/` holds the same as CSV.
  - `analysis_settings.json`, `oasislmf.log`, `comparison_detail.json` (all variants of every
    number).
  - `oasis_run/`: what Oasis generated: its input files, ORD outputs in `output/`
    (`gul_S1_melt.csv`, `gul_S1_ept.csv`, `gul_S1_palt.csv` and others) and logs.

## How the app chooses a file

The Results step reads the flood source, the "Losses from" switch and the assumptions in
force, and loads the one file made for that combination. It shows the comparison only when
the file's view carries the fingerprint of the result on screen. Otherwise it says
"Not checked by Oasis for these settings": for agreed or typed assumptions, for Terrain only
with All loss drivers, for other model data, and for a file made before the engine or the data
changed. It never shows a match from other settings.

## What this checks

- Runs 1 and 2: that the damage function, applied by Oasis to the app's depths, gives the
  app's losses. Run 2 has drainage ponding in those depths.
- All three: that our losses per event add up the same way in an industry engine.
- All three: that the loss at each return period and the OEP and AEP curves follow from the
  event losses and their probabilities as we claim.
- All three: that the AAL difference between Oasis and the app is fully explained by the
  curve shape (step against trapezoid) and nothing else.
- Run 3: that this holds with every loss driver in force for the portfolio (surrounding
  flooding, drainage ponding, drain overload).

## What this does not check

- The hazard itself: the scores, the tier slopes, the 4 m depth scale, the drainage layer and
  the return periods given to each tier. Both engines read the same depths.
- The damage function's own figures: the JRC curve, fragility multipliers and caps. Our code
  writes the Oasis vulnerability functions from the same formula, so a wrong curve would be
  wrong in both. Runs 1 and 2 check that the formula is applied the same way, not that it is
  the right formula.
- In run 3, how the loss drivers reach the damage ratio (the buffer, the drain design return
  period, the overload depth): Oasis takes the ratio as given.
- Basement ingress, business interruption, the uncertainty loading and the premium build-up.
  They belong to an offer, not to the portfolio, and are in no Oasis run.
- Assumptions agreed by the agents or typed over on screen. No shipped run covers them; the
  export and `--damage-ratios` make one for any such result.
- The TIV values in the file.
- Financial terms (deductibles, limits), reinsurance, secondary uncertainty and correlation:
  the runs are deterministic and ground-up only.

## Limits

- Five events only. Between the five return periods Oasis shows steps, while the app
  interpolates against log return period; the two agree at the five points.
- Depth bins of 1 mm and damage steps of 0.1% keep each event within 0.1% of our engine.
  Smaller bins are possible with the flags above, at the cost of memory (Oasis holds an
  intensity bins x damage bins table per housing class).
- The script is built for the five score tiers of the Nairobi data. It stops on an export
  with other scenarios, such as the Nzoia depth maps.
- Oasis stores TIV and losses as 32-bit numbers, about seven significant digits.
- In the rare case that whole period counts would need more than 5 million periods, the
  counts are rounded on 100,000 periods and the notes give the return periods actually used.
- The `aalpy` step reserves 4 GB of memory by default; the script lowers this to 0.5 GB
  (`OASIS_AAL_MEMORY`) so it runs on small machines.
- With neither CSV, slopes are fitted on the GeoTIFFs only when `tifffile` and `imagecodecs`
  are installed; otherwise on the building columns, which give the same slopes to within
  0.0000001 here.
