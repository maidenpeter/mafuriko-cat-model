#!/usr/bin/env python3
"""Independent check of the flood model's financial engine with Oasis LMF.

Builds Oasis inputs from the hackathon exposure file (OED location and account files,
precomputed keys, and a small Oasis model: events, occurrence, footprint, vulnerability,
damage bins), runs the real oasislmf loss engine on them (ground-up only), reads the ORD
outputs (event loss table, OEP and AEP, AAL), recomputes our own engine's numbers in
Python for the same inputs and writes a comparison JSON for the web app.

Run from the project root inside the virtualenv that has oasislmf installed:

    python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \
        --out web/public/oasis/reference.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from fractions import Fraction
from functools import reduce

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import engine as eng  # noqa: E402

PERIL = "OSF"  # OED: Flash / Surface / Pluvial Flood
COUNTRY = "KE"
CURRENCY = "KES"
OCCUPANCY_RESIDENTIAL = 1050  # OED: Residential, general
CONSTRUCTION_CODE = {  # OED construction codes, informative only (keys carry the vulnerability)
    "informal_iron_sheet": 5201,  # Steel, light metal (iron sheet)
    "semi_permanent": 5101,  # Masonry, adobe (mud and wattle)
    "permanent_masonry": 5100,  # Masonry
    "concrete_rcc": 5150,  # Reinforced concrete
}
VULNERABILITY_ID = {c: i + 1 for i, c in enumerate(eng.HOUSING_CLASSES)}
EVENT_ID = {t: i + 1 for i, t in enumerate(eng.SCORE_TIERS)}
SUMMARY_SET = 1


# ---------------------------------------------------------------- helpers

def oasislmf_version() -> str:
    try:
        from importlib.metadata import version
        return version("oasislmf")
    except Exception:
        return "unknown"


def lcm(a: int, b: int) -> int:
    return a * b // math.gcd(a, b)


def period_set(return_periods: dict, min_periods: int) -> dict:
    """Number of periods and how many periods each event occurs in.

    The share of periods containing tier k equals its exceedance band 1/RP_k - 1/RP_(k+1),
    so the n-th largest period loss sits exactly at return period P / n. P is chosen so that
    P / RP_k is a whole number for every tier (for example 1,000 for 10, 25, 50, 100 and 250).
    """
    rps = [float(return_periods[t]) for t in eng.SCORE_TIERS]
    fractions = [Fraction(r).limit_denominator(1000) for r in rps]
    exact = all(abs(float(f) - r) <= 1e-9 * r for f, r in zip(fractions, rps))
    periods = None
    if exact:
        base = reduce(lcm, [f.numerator for f in fractions])  # P / (p/q) = Pq/p is whole when p divides P
        periods = base * max(1, math.ceil(min_periods / base))
        if periods > 5_000_000:
            periods, exact = None, False
    if periods is None:
        periods = max(min_periods, 100_000)
    if exact:
        cumulative = [periods * f.denominator // f.numerator for f in fractions] + [0]
    else:
        cumulative = [int(round(periods / r)) for r in rps] + [0]
    counts = {t: cumulative[i] - cumulative[i + 1] for i, t in enumerate(eng.SCORE_TIERS)}
    if any(v <= 0 for v in counts.values()):
        raise ValueError(f"return periods too close together for {periods} periods: {return_periods}")
    effective = {t: periods / cumulative[i] for i, t in enumerate(eng.SCORE_TIERS)}
    return {"periods": periods, "counts": counts, "effectiveReturnPeriods": effective, "exact": exact}


def damage_bin_index(damage: np.ndarray, step: float) -> np.ndarray:
    """1-based index of the point damage bin nearest to each damage ratio (bin 1 = no damage)."""
    return np.rint(np.asarray(damage, dtype=float) / step).astype(np.int64) + 1


def intensity_bin_index(depth: np.ndarray, step: float) -> np.ndarray:
    """1-based depth bin: bin k covers depths in ((k-1) x step, k x step]. 0 means dry."""
    d = np.asarray(depth, dtype=float)
    return np.where(d > 0, np.maximum(1, np.ceil(d / step)), 0).astype(np.int64)


def write_csv(df: pd.DataFrame, path: str) -> None:
    df.to_csv(path, index=False)


def clear_dir(path: str) -> None:
    """Remove a folder's previous contents so stale model files are never picked up."""
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)


def tidy_params(params: dict) -> dict:
    """Whole-number return periods as integers, so the JSON reads 10 rather than 10.0."""
    out = json.loads(json.dumps(params))
    out["returnPeriods"] = {t: int(v) if float(v).is_integer() else v for t, v in out["returnPeriods"].items()}
    return out


# ---------------------------------------------------------------- Oasis inputs

def build_inputs(run_dir, df, tiv, depths, params, pset, samples, intensity_step, damage_step):
    from oasislmf.pytools.converters.csvtobin.manager import csvtobin

    exp_dir = os.path.join(run_dir, "exposure")
    model_dir = os.path.join(run_dir, "model_data")  # binary files the Oasis kernel reads
    csv_dir = os.path.join(run_dir, "model_data_csv")  # the same model data as readable CSV
    for d in (exp_dir, model_dir, csv_dir):
        clear_dir(d)
    n = len(df)
    loc_number = df["loc_id"].astype(str).to_numpy()
    if len(set(loc_number)) != n:  # OED needs one LocNumber per location
        loc_number = np.array([f"{v}-{i + 1}" for i, v in enumerate(loc_number)])
    # oasislmf numbers locations by sorting PortNumber, AccNumber, LocNumber; use its own function
    # so the precomputed keys point at the right rows.
    from oasislmf.utils.data import get_ids
    ids_frame = pd.DataFrame({"PortNumber": "1", "AccNumber": "1", "LocNumber": loc_number})
    loc_ids = np.asarray(get_ids(ids_frame, ["PortNumber", "AccNumber", "LocNumber"]), dtype=np.int64)
    area_peril = np.arange(1, n + 1)  # every building is its own area peril cell

    # OED location and account files (OED v5 field names).
    location = pd.DataFrame({
        "PortNumber": "1",
        "AccNumber": "1",
        "LocNumber": loc_number,
        "CountryCode": COUNTRY,
        "Latitude": df["lat"].to_numpy(),
        "Longitude": df["lon"].to_numpy(),
        "LocPeril": PERIL,
        "LocPerilsCovered": PERIL,
        "BuildingTIV": tiv,
        "OtherTIV": 0.0,
        "ContentsTIV": 0.0,
        "BITIV": 0.0,
        "LocCurrency": CURRENCY,
        "OccupancyCode": OCCUPANCY_RESIDENTIAL,
        "ConstructionCode": df["housing_class"].map(CONSTRUCTION_CODE).to_numpy(),
        "NumberOfBuildings": 1,
        "FlexiLocHousingClass": df["housing_class"].to_numpy(),
    })
    account = pd.DataFrame([{
        "PortNumber": "1",
        "AccNumber": "1",
        "AccCurrency": CURRENCY,
        "PolNumber": "1",
        "PolPeril": PERIL,
        "PolPerilsCovered": PERIL,
    }])
    keys = pd.DataFrame({
        "LocID": loc_ids,
        "PerilID": PERIL,
        "CoverageTypeID": 1,  # buildings
        "AreaPerilID": area_peril,
        "VulnerabilityID": df["housing_class"].map(VULNERABILITY_ID).to_numpy(),
    })
    paths = {
        "location": os.path.join(exp_dir, "location.csv"),
        "account": os.path.join(exp_dir, "account.csv"),
        "keys": os.path.join(exp_dir, "keys.csv"),
        "model_data": model_dir,
        "analysis_settings": os.path.join(run_dir, "analysis_settings.json"),
    }
    write_csv(location, paths["location"])
    write_csv(account, paths["account"])
    write_csv(keys, paths["keys"])

    # Footprint: one row per (event, wet building), probability 1 in the building's depth bin.
    footprint_parts = []
    max_bin = int(math.ceil(params["depthScaleM"] / intensity_step))
    for t in eng.SCORE_TIERS:
        k = intensity_bin_index(depths[t], intensity_step)
        wet = k > 0
        max_bin = max(max_bin, int(k.max()) if wet.any() else 0)
        footprint_parts.append(pd.DataFrame({
            "event_id": EVENT_ID[t],
            "areaperil_id": area_peril[wet],
            "intensity_bin_id": k[wet],
            "probability": 1.0,
        }))
    footprint = pd.concat(footprint_parts, ignore_index=True).sort_values(["event_id", "areaperil_id"])
    write_csv(footprint, os.path.join(csv_dir, "footprint.csv"))
    csvtobin(os.path.join(csv_dir, "footprint.csv"), os.path.join(model_dir, "footprint.bin"), "footprint",
             idx_file_out=os.path.join(model_dir, "footprint.idx"), zip_files=False,
             max_intensity_bin_idx=max_bin, no_intensity_uncertainty=False, decompressed_size=False,
             no_validation=False)

    # Intensity bins (for reference; the engine only uses bin ids): bin k = ((k-1)w, kw], midpoint value.
    k_all = np.arange(1, max_bin + 1)
    write_csv(pd.DataFrame({
        "bin_index": k_all,
        "bin_from": (k_all - 1) * intensity_step,
        "bin_to": k_all * intensity_step,
        "interpolation": (k_all - 0.5) * intensity_step,
    }), os.path.join(csv_dir, "intensity_bin_dict.csv"))

    # Damage bins: point bins every damage_step from 0 to 1, so every sample equals the mean.
    n_damage = int(round(1.0 / damage_step)) + 1
    values = np.round(np.arange(n_damage) * damage_step, 10)
    write_csv(pd.DataFrame({
        "bin_index": np.arange(1, n_damage + 1),
        "bin_from": values,
        "bin_to": values,
        "interpolation": values,
        "damage_type": 1,  # relative to TIV
    }), os.path.join(csv_dir, "damage_bin_dict.csv"))
    csvtobin(os.path.join(csv_dir, "damage_bin_dict.csv"), os.path.join(model_dir, "damage_bin_dict.bin"), "damagebin",
             no_validation=False)

    # Vulnerability: one function per housing class, damage at each depth bin's midpoint, probability 1.
    mid_depth = (k_all - 0.5) * intensity_step
    vuln_parts = []
    for cls in eng.HOUSING_CLASSES:
        dmg = eng.damage_ratio(mid_depth, params["fragility"][cls], params["cap"][cls])
        vuln_parts.append(pd.DataFrame({
            "vulnerability_id": VULNERABILITY_ID[cls],
            "intensity_bin_id": k_all,
            "damage_bin_id": damage_bin_index(dmg, damage_step),
            "probability": 1.0,
        }))
    write_csv(pd.concat(vuln_parts, ignore_index=True), os.path.join(csv_dir, "vulnerability.csv"))
    csvtobin(os.path.join(csv_dir, "vulnerability.csv"), os.path.join(model_dir, "vulnerability.bin"), "vulnerability",
             idx_file_out=None, max_damage_bin_idx=n_damage, no_validation=False, suppress_int_bin_checks=False,
             zip_files=False)

    # Events and occurrence.
    events_csv = os.path.join(csv_dir, "events.csv")
    write_csv(pd.DataFrame({"event_id": sorted(EVENT_ID.values())}), events_csv)
    csvtobin(events_csv, os.path.join(model_dir, "events.bin"), "eve")

    rows, period = [], 1
    for t in reversed(eng.SCORE_TIERS):  # rarest first; order does not change any result
        for _ in range(pset["counts"][t]):
            rows.append((EVENT_ID[t], period, 1))
            period += 1
    occ_csv = os.path.join(csv_dir, "occurrence.csv")
    write_csv(pd.DataFrame(rows, columns=["event_id", "period_no", "occ_date_id"]), occ_csv)
    csvtobin(occ_csv, os.path.join(model_dir, "occurrence.bin"), "occurrence",
             no_of_periods=pset["periods"], no_date_alg=True)

    rp_out = sorted({int(round(params["returnPeriods"][t])) for t in eng.SCORE_TIERS})
    analysis_settings = {
        "model_supplier_id": "Mafuriko",
        "model_name_id": "NairobiPluvialProxy",
        "model_settings": {},
        "number_of_samples": samples,
        "gul_threshold": 0,
        "return_periods": rp_out,
        "gul_output": True,
        "gul_summaries": [{
            "id": SUMMARY_SET,
            "ord_output": {
                "elt_sample": True,
                "elt_moment": True,
                "plt_moment": True,
                "alt_period": True,
                "alt_meanonly": True,
                "ept_full_uncertainty_oep": True,
                "ept_full_uncertainty_aep": True,
                "ept_mean_sample_oep": True,
                "ept_mean_sample_aep": True,
                "ept_per_sample_mean_oep": True,
                "ept_per_sample_mean_aep": True,
                # Full EP table: one row per rank, at return period P / rank, no interpolation.
                "return_period_file": False,
            },
        }],
        "il_output": False,
        "ri_output": False,
    }
    with open(paths["analysis_settings"], "w", encoding="utf-8") as fh:
        json.dump(analysis_settings, fh, indent=2)

    stats = {
        "locations": n,
        "footprintRows": int(len(footprint)),
        "intensityBins": int(max_bin),
        "damageBins": int(n_damage),
        "vulnerabilityRows": int(sum(len(p) for p in vuln_parts)),
        "occurrenceRows": len(rows),
    }
    return paths, stats


def run_oasis(paths: dict, work_dir: str, log_path: str) -> list[str]:
    """Run `oasislmf model run` in work_dir.

    work_dir should be on a local Linux disk with no spaces in its path: oasislmf writes a bash
    script that changes into its own folder without quoting it, and it uses named pipes and
    symbolic links, which some mounted Windows folders do not handle.
    """
    if os.path.isdir(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(os.path.dirname(work_dir), exist_ok=True)
    venv_bin = os.path.dirname(os.path.abspath(sys.executable))
    env = dict(os.environ)
    # The kernel tools (evepy, modelpy, gulmc, summarypy, lecpy, aalpy ...) are called by name.
    env["PATH"] = venv_bin + os.pathsep + env.get("PATH", "")
    # aalpy pre-allocates this many GB by default (4); keep it small for laptops and small VMs.
    env.setdefault("OASIS_AAL_MEMORY", "0.5")
    oasislmf_cli = os.path.join(venv_bin, "oasislmf")
    cmd = [
        oasislmf_cli if os.path.exists(oasislmf_cli) else "oasislmf",
        "model", "run",
        "-x", paths["location"],
        "-y", paths["account"],
        "-z", paths["keys"],
        "-d", paths["model_data"],
        "-a", paths["analysis_settings"],
        "-r", work_dir,
    ]
    with open(log_path, "w", encoding="utf-8") as log:
        proc = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, env=env, cwd=os.path.dirname(work_dir))
    if proc.returncode != 0:
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            tail = fh.read()[-3000:]
        raise RuntimeError(f"oasislmf model run failed (exit {proc.returncode}). Log tail:\n{tail}")
    return cmd


def copy_run_back(work_dir: str, model_run_dir: str) -> None:
    """Copy the Oasis run (inputs it generated, outputs, logs, kernel script) into oasis/runs.
    Named pipes, scratch files, the links to the model data and gulmc's cached arrays
    (tens of MB, rebuilt on every run) are left behind."""
    shutil.rmtree(model_run_dir, ignore_errors=True)
    shutil.copytree(work_dir, model_run_dir, symlinks=False, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("fifo", "work", "static", "gulmc_structure"),
                    copy_function=shutil.copyfile)


# ---------------------------------------------------------------- Oasis outputs

def read_ord(model_run_dir: str) -> dict:
    out = os.path.join(model_run_dir, "output")

    def load(name):
        path = os.path.join(out, f"gul_S{SUMMARY_SET}_{name}.csv")
        return pd.read_csv(path) if os.path.exists(path) else None

    return {k: load(k) for k in ["melt", "selt", "ept", "palt", "altmeanonly", "mplt"]}


def ord_event_losses(melt: pd.DataFrame) -> dict:
    """Event loss by tier from the moment ELT. SampleType 1 = analytical mean, 2 = sample mean."""
    res = {}
    for st in (1, 2):
        rows = melt[melt["SampleType"] == st]
        by_event = rows.groupby("EventId")["MeanLoss"].sum()
        res[st] = {t: float(by_event.get(EVENT_ID[t], 0.0)) for t in eng.SCORE_TIERS}
    return res


def ord_ep(ept: pd.DataFrame, targets: dict) -> dict:
    """Loss at each tier's return period, read from the full EP table (no interpolation).

    EPCalc: 1 mean damage, 2 full uncertainty, 3 per-sample mean, 4 sample mean.
    EPType: 1 OEP, 3 AEP (2 and 4 are the TVaR versions).
    """
    res = {}
    for calc in sorted(ept["EPCalc"].unique()):
        for ep_type, label in ((1, "oep"), (3, "aep")):
            rows = ept[(ept["EPCalc"] == calc) & (ept["EPType"] == ep_type)]
            rp_col = rows["ReturnPeriod"].to_numpy(dtype=float)
            loss_col = rows["Loss"].to_numpy(dtype=float)
            curve = {}
            for t, rp in targets.items():
                hit = np.flatnonzero(np.abs(rp_col - rp) <= 1e-6 * rp)
                curve[t] = float(loss_col[hit[-1]]) if len(hit) else float("nan")
            res[(int(calc), label)] = curve
    return res


def ord_aal(palt: pd.DataFrame) -> dict:
    """SampleType 1 = analytical mean, 2 = sample mean."""
    return {int(st): float(g["MeanLoss"].sum()) for st, g in palt.groupby("SampleType")}


# ---------------------------------------------------------------- main

def kes(x: float):
    """Whole KES for the JSON; None when Oasis did not return a value."""
    return None if x is None or not math.isfinite(x) else int(round(x))


def pct(a: float, b: float) -> float:
    return 0.0 if b == 0 else (a - b) / b * 100.0


def fmt_kes(x: float) -> str:
    return f"KES {x / 1e6:,.1f}m"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data-dir", required=True, help="folder with the exposure CSV (and optionally the hazard GeoTIFFs)")
    ap.add_argument("--params", help="params JSON of the app's shape; default is the reference parameters")
    ap.add_argument("--tiv-basis", choices=["file", "documented"], default="file")
    ap.add_argument("--out", required=True, help="where to write the comparison JSON")
    ap.add_argument("--samples", type=int, default=10, help="Oasis samples per event (default 10)")
    ap.add_argument("--min-periods", type=int, default=1000, help="smallest period set to use (default 1000)")
    ap.add_argument("--intensity-step-m", type=float, default=0.001, help="depth bin width in metres (default 0.001)")
    ap.add_argument("--damage-step", type=float, default=0.001, help="damage bin spacing (default 0.001)")
    ap.add_argument("--slopes-from", choices=["auto", "rasters", "columns"], default="auto")
    ap.add_argument("--run-name", help="folder name under oasis/runs (default: built from dataset, TIV basis and params)")
    ap.add_argument("--work-dir", help="local scratch folder for the Oasis run, on a Linux disk and without spaces "
                    "(default: <system temp>/mafuriko-oasis); the run uses a subfolder named after the run, "
                    "which is replaced on each run, and the results are copied back to oasis/runs")
    ap.add_argument("--parse-only", action="store_true", help="skip the Oasis run and read the outputs of the last run")
    args = ap.parse_args(argv)

    t0 = time.time()
    dataset = os.path.basename(os.path.normpath(args.data_dir))
    params, adjustments = eng.load_params(args.params)
    df, info = eng.load_exposure(args.data_dir)
    tiv, tiv_fallbacks = eng.building_tiv(df, args.tiv_basis)

    # Tier slopes: rasters when readable (as the app does when they are loaded), otherwise the building columns.
    col_slopes = eng.slopes_from_columns(df)
    ras_slopes, ras_reason = (None, "not requested")
    if args.slopes_from in ("auto", "rasters"):
        ras_slopes, ras_reason = eng.slopes_from_rasters(args.data_dir)
        if ras_slopes is None and args.slopes_from == "rasters":
            raise SystemExit(f"Could not fit slopes on the rasters: {ras_reason}")
    slopes = ras_slopes if ras_slopes is not None else col_slopes
    slope_source = "rasters" if ras_slopes is not None else "columns"
    slope_gap = max(abs(col_slopes[t] - (ras_slopes or col_slopes)[t]) for t in eng.SCORE_TIERS)

    ours = eng.run_engine(df, tiv, slopes, params)
    our_loss = ours["eventLossKes"]
    rps = params["returnPeriods"]
    pset = period_set(rps, args.min_periods)
    points = eng.curve_points(our_loss, rps)
    our_trap = eng.trapezoid_aal(points)
    band_prob = [pset["counts"][t] / pset["periods"] for t in eng.SCORE_TIERS]
    our_disc = eng.banded_aal([(rps[t], our_loss[t]) for t in eng.SCORE_TIERS], band_prob)

    # What Oasis should return given its discrete files: same engine, depth and damage rounded to the bins.
    frag, cap = eng.class_arrays(df, params)
    tiv32 = tiv.astype(np.float32).astype(np.float64)  # Oasis stores TIV as 32-bit floats
    our_binned = {}
    for t in eng.SCORE_TIERS:
        k = intensity_bin_index(ours["depths"][t], args.intensity_step_m)
        mid = np.where(k > 0, (k - 0.5) * args.intensity_step_m, 0.0)
        dmg = (damage_bin_index(eng.damage_ratio(mid, frag, cap), args.damage_step) - 1) * args.damage_step
        our_binned[t] = float((np.where(k > 0, dmg, 0.0) * tiv32).sum())

    params_tag = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:8]
    run_name = args.run_name or f"{dataset}_{args.tiv_basis}_{params_tag}"
    run_dir = os.path.join(HERE, "runs", run_name)
    os.makedirs(run_dir, exist_ok=True)
    model_run_dir = os.path.join(run_dir, "oasis_run")
    log_path = os.path.join(run_dir, "oasislmf.log")

    print(f"Building Oasis inputs in {run_dir} ...", flush=True)
    t_build = time.time()
    paths, stats = build_inputs(run_dir, df, tiv, ours["depths"], params, pset, args.samples,
                                args.intensity_step_m, args.damage_step)
    print(f"  built in {time.time() - t_build:.0f} s", flush=True)
    cmd = None
    if not args.parse_only:
        print(f"Running oasislmf {oasislmf_version()} on {len(df)} locations, 5 events, {pset['periods']} periods ...", flush=True)
        t_run = time.time()
        work_root = os.path.abspath(args.work_dir or os.path.join(tempfile.gettempdir(), "mafuriko-oasis"))
        work_dir = os.path.join(work_root, run_name)
        cmd = run_oasis(paths, work_dir, log_path)
        print(f"  Oasis run finished in {time.time() - t_run:.0f} s", flush=True)
        copy_run_back(work_dir, model_run_dir)
        shutil.rmtree(work_dir, ignore_errors=True)

    ord_out = read_ord(model_run_dir)
    if ord_out["melt"] is None or ord_out["ept"] is None or ord_out["palt"] is None:
        raise SystemExit(f"Oasis outputs not found in {model_run_dir}/output; see {log_path}")
    ev = ord_event_losses(ord_out["melt"])
    ep = ord_ep(ord_out["ept"], pset["effectiveReturnPeriods"])
    aal = ord_aal(ord_out["palt"])

    # Headline Oasis numbers: sample based (full Monte Carlo path). Analytical versions are cross-checked.
    oasis_event = ev[2]
    oasis_oep = ep.get((2, "oep"))
    oasis_aep = ep.get((2, "aep"))
    oasis_aal = aal.get(2, aal.get(1))

    event_diffs = {t: pct(oasis_event[t], our_loss[t]) for t in eng.SCORE_TIERS}
    max_event_diff = max(abs(v) for v in event_diffs.values())
    binned_diff = max(abs(pct(oasis_event[t], our_binned[t])) for t in eng.SCORE_TIERS)
    analytic_vs_sample = max(abs(pct(ev[1][t], ev[2][t])) for t in eng.SCORE_TIERS)
    ep_variants_gap = 0.0
    for (calc, label), curve in ep.items():
        for t in eng.SCORE_TIERS:
            base = (oasis_oep if label == "oep" else oasis_aep)[t]
            ep_variants_gap = max(ep_variants_gap, abs(pct(curve[t], base)))
    # Loss at each tier's return period should be that tier's event loss.
    ep_vs_event = 0.0
    for t in eng.SCORE_TIERS:
        for curve in (oasis_oep, oasis_aep):
            ep_vs_event = max(ep_vs_event, abs(pct(curve[t], oasis_event[t])))
    aal_vs_disc = pct(oasis_aal, our_disc)
    trap_vs_disc = pct(our_trap, our_disc)

    # ------------------------------------------------ notes (plain English)
    total_tiv = float(tiv.sum())
    notes = [
        f"Oasis LMF {oasislmf_version()} ran the five tier events on {len(df)} buildings "
        f"(total TIV {fmt_kes(total_tiv)}, {args.tiv_basis} TIV basis) with {args.samples} samples per event "
        f"over {pset['periods']:,} periods, ground-up loss only.",
        "Our figures come from a Python copy of the app's engine (web/src/lib/model) run on the same file and "
        "parameters.",
        f"Every event loss matches our engine to within {max_event_diff:.3f}%. The small gap comes from the Oasis "
        f"model files being discrete: depth is stored in {args.intensity_step_m * 1000:g} mm bins and damage ratios "
        f"in {args.damage_step * 100:g}% steps. Our engine with the same rounding matches Oasis to {binned_diff:.5f}%.",
        f"Each event occurs in a share of periods equal to its exceedance band (for example "
        f"{pset['counts']['extreme']} of {pset['periods']:,} periods for the 1-in-{rps['extreme']:g} event, "
        f"{pset['counts']['common']} for the 1-in-{rps['common']:g}), and no period holds more than one event. "
        f"So Oasis OEP and AEP at each tier's return period equal that tier's event loss "
        f"(largest gap {ep_vs_event:.4f}%), which confirms the loss to return period mapping the app uses.",
        f"Oasis AAL ({fmt_kes(oasis_aal)}) is the average loss per period, which is each event's loss times its band "
        f"probability, a step curve. The same banded sum from our losses is {fmt_kes(our_disc)} "
        f"({aal_vs_disc:+.3f}%).",
        f"The app's AAL ({fmt_kes(our_trap)}) joins the five points with straight lines over annual exceedance "
        f"probability (trapezoid), so it is {trap_vs_disc:.1f}% higher than the step value. Both treat events more "
        f"frequent than 1-in-{rps['extreme']:g} as no loss and hold the 1-in-{rps['common']:g} loss for anything "
        f"rarer; the difference is only the shape assumed between the five points.",
        f"The vulnerability functions are deterministic (each depth bin maps to one damage value), so every sample "
        f"equals the mean: analytical and sample-mean event losses agree to {analytic_vs_sample:.5f}%, and the "
        f"mean-damage, full-uncertainty, per-sample and sample-mean EP curves agree to {ep_variants_gap:.5f}%.",
        f"Tier slopes were fitted on the {'five hazard rasters' if slope_source == 'rasters' else 'building hazard columns'}"
        + (f"; the building columns give the same slopes to within {slope_gap:.1e}." if slope_source == "rasters" else
           f" because the rasters could not be used ({ras_reason}).")
        ,
        "This checks the loss arithmetic, the event to period mapping and the OEP, AEP and AAL maths. It does not "
        "test the hazard scores, the depth scale, the JRC damage curve or the class parameters, because both "
        "engines take those from the same inputs.",
    ]
    if not pset["exact"]:
        eff = ", ".join(f"{t} 1-in-{pset['effectiveReturnPeriods'][t]:.2f}" for t in eng.SCORE_TIERS)
        notes.append(f"The return periods do not divide a whole number of periods, so the period counts were "
                     f"rounded and the EP points are read at these return periods: {eff}.")
    if adjustments:
        notes.append("Parameter adjustments applied with the app's bounds: " + "; ".join(adjustments) + ".")
    if args.tiv_basis == "documented":
        ratio = float(df["tiv_file_kes"].sum()) / total_tiv if total_tiv else float("nan")
        notes.append(f"TIV basis 'documented' uses floor area times cost per square metre rounded to the nearest "
                     f"KES 5,000; the file values are {ratio:.2f} times larger in total."
                     + (f" {tiv_fallbacks} rows without area or cost kept the file value." if tiv_fallbacks else ""))
    if info["rowsDropped"] or info["unknownClassRows"]:
        notes.append(f"{info['rowsDropped']} rows were dropped for missing coordinates or TIV and "
                     f"{info['unknownClassRows']} rows with an unknown housing class used the permanent masonry curve, "
                     f"as in the app.")

    result = {
        "engine": "Oasis LMF",
        "oasislmfVersion": oasislmf_version(),
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "dataset": dataset,
        "tivBasis": args.tiv_basis,
        "params": tidy_params(params),
        "slopes": {t: round(float(slopes[t]), 6) for t in eng.SCORE_TIERS},
        "samples": args.samples,
        "periods": pset["periods"],
        "events": [
            {"tier": t, "returnPeriod": tidy_params(params)["returnPeriods"][t], "oasisLossKes": kes(oasis_event[t]), "ourLossKes": kes(our_loss[t])}
            for t in eng.SCORE_TIERS
        ],
        "ep": {
            "oep": [{"returnPeriod": tidy_params(params)["returnPeriods"][t], "lossKes": kes(oasis_oep[t])}
                    for t in eng.SCORE_TIERS],
            "aep": [{"returnPeriod": tidy_params(params)["returnPeriods"][t], "lossKes": kes(oasis_aep[t])}
                    for t in eng.SCORE_TIERS],
        },
        "aal": {"oasisKes": kes(oasis_aal), "ourTrapezoidKes": kes(our_trap), "ourDiscreteKes": kes(our_disc)},
        "maxEventDiffPct": round(max_event_diff, 4),
        "notes": notes,
    }
    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)
        fh.write("\n")

    # Fuller detail for local inspection (stays under oasis/runs, which git ignores).
    detail = {
        "result": result,
        "command": cmd,
        "inputs": stats,
        "exposure": info,
        "periodSet": pset,
        "slopes": {"used": slope_source, "rasters": ras_slopes, "rasterNote": ras_reason, "columns": col_slopes},
        "eventLoss": {
            t: {"ours": our_loss[t], "oursBinned": our_binned[t], "oasisAnalytical": ev[1][t], "oasisSample": ev[2][t],
                "diffPct": event_diffs[t]}
            for t in eng.SCORE_TIERS
        },
        "ep": {f"EPCalc{c}_{label}": curve for (c, label), curve in ep.items()},
        "aal": {"oasisAnalytical": aal.get(1), "oasisSample": aal.get(2), "ourTrapezoid": our_trap, "ourBanded": our_disc},
        "runSeconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(run_dir, "comparison_detail.json"), "w", encoding="utf-8") as fh:
        json.dump(detail, fh, indent=2, default=str)

    # Console summary (totals only, no building rows).
    print(f"\n{'tier':<11}{'RP':>6}{'ours (KES m)':>16}{'Oasis (KES m)':>16}{'diff %':>10}")
    for t in eng.SCORE_TIERS:
        print(f"{t:<11}{rps[t]:>6g}{our_loss[t] / 1e6:>16,.2f}{oasis_event[t] / 1e6:>16,.2f}{event_diffs[t]:>10.4f}")
    print(f"\nAAL Oasis {oasis_aal / 1e6:,.2f}m | ours banded {our_disc / 1e6:,.2f}m ({aal_vs_disc:+.4f}%) | "
          f"ours trapezoid {our_trap / 1e6:,.2f}m")
    print(f"Wrote {out_path}\nDetail: {os.path.join(run_dir, 'comparison_detail.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
