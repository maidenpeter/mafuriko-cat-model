"""Python copy of the web app's flood loss engine (web/src/lib/model/*.ts).

It reproduces, for one exposure file and one parameter set:
  * the tier slopes (hazard.ts),
  * depth, damage ratio and loss for every building and tier (pipeline.ts, vulnerability.ts),
  * the trapezoid average annual loss (financial.ts),
  * the banded (step) average annual loss that a period based engine such as Oasis computes.

Nothing in here depends on oasislmf, so it can be run and tested on its own.
"""
from __future__ import annotations

import copy
import glob
import json
import math
import os

import numpy as np
import pandas as pd

HOUSING_CLASSES = ["informal_iron_sheet", "semi_permanent", "permanent_masonry", "concrete_rcc"]
FALLBACK_CLASS = "permanent_masonry"
# Narrowest footprint (most frequent event) to widest (rarest), as in types.ts.
SCORE_TIERS = ["extreme", "severe", "moderate", "occasional", "common"]

REFERENCE_PARAMS = {
    "depthScaleM": 4.0,
    "fragility": {"informal_iron_sheet": 1.5, "semi_permanent": 1.2, "permanent_masonry": 1.0, "concrete_rcc": 0.7},
    "cap": {"informal_iron_sheet": 0.95, "semi_permanent": 0.9, "permanent_masonry": 0.85, "concrete_rcc": 0.8},
    "returnPeriods": {"extreme": 10, "severe": 25, "moderate": 50, "occasional": 100, "common": 250},
}

BOUNDS = {
    "depthScaleM": (1.0, 6.0),
    "fragility": (0.4, 2.5),
    "cap": (0.6, 1.0),
    "returnPeriod": (2, 1000),
}

# Huizinga, de Moel and Szewczyk (2017), JRC105688, Africa, residential buildings.
JRC_DEPTHS_M = np.array([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0])
JRC_DAMAGE = np.array([0.0, 0.22, 0.38, 0.53, 0.64, 0.82, 0.90, 0.96, 1.00])


# ---------------------------------------------------------------- parameters

def load_params(path: str | None) -> tuple[dict, list[str]]:
    """Read a params JSON of the app's shape and apply the app's bounds (params.ts enforceBounds).

    Returns the parameters actually used and a list of plain-English adjustment messages.
    """
    if not path:
        raw = copy.deepcopy(REFERENCE_PARAMS)
    else:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
    return enforce_bounds(raw)


def enforce_bounds(raw: dict) -> tuple[dict, list[str]]:
    adjustments: list[str] = []

    def fix(path, value, lo, hi, fallback):
        try:
            v = float(value)
        except (TypeError, ValueError):
            v = float("nan")
        start = v if math.isfinite(v) else fallback
        out = min(hi, max(lo, start))
        if not math.isfinite(v):
            adjustments.append(f"{path} was missing or not a number, so the reference value {fallback} was used")
        elif out != v:
            adjustments.append(f"{path} = {v} was outside the allowed range {lo} to {hi} and was set to {out}")
        return out

    fragility, cap = {}, {}
    for c in HOUSING_CLASSES:
        fragility[c] = fix(f"fragility.{c}", (raw.get("fragility") or {}).get(c), *BOUNDS["fragility"], REFERENCE_PARAMS["fragility"][c])
        cap[c] = fix(f"cap.{c}", (raw.get("cap") or {}).get(c), *BOUNDS["cap"], REFERENCE_PARAMS["cap"][c])

    return_periods, previous = {}, 0.0
    for t in SCORE_TIERS:
        rp = fix(f"returnPeriods.{t}", (raw.get("returnPeriods") or {}).get(t), *BOUNDS["returnPeriod"], REFERENCE_PARAMS["returnPeriods"][t])
        if rp <= previous:
            adjustments.append(f"returnPeriods.{t} = {rp} must be rarer than the tier before it and was set to {previous + 1}")
            rp = previous + 1
        return_periods[t] = rp
        previous = rp

    params = {
        "depthScaleM": fix("depthScaleM", raw.get("depthScaleM"), *BOUNDS["depthScaleM"], REFERENCE_PARAMS["depthScaleM"]),
        "fragility": fragility,
        "cap": cap,
        "returnPeriods": return_periods,
    }
    return params, adjustments


# ---------------------------------------------------------------- exposure

def load_exposure(data_dir: str) -> tuple[pd.DataFrame, dict]:
    """Read the exposure CSV with hazard scores the same way the app's ingest does."""
    matches = sorted(glob.glob(os.path.join(data_dir, "*with_hazard*.csv")))
    if not matches:
        raise FileNotFoundError(f"No *with_hazard*.csv file in {data_dir}")
    path = matches[0]
    df = pd.read_csv(path, dtype={"loc_id": str})
    missing = [c for c in ["loc_id", "lat", "lon", "housing_class", "tiv_kes"] if c not in df.columns]
    missing += [f"hazard_score_{t}" for t in SCORE_TIERS if f"hazard_score_{t}" not in df.columns]
    if missing:
        raise ValueError(f"{os.path.basename(path)} is missing columns: {missing}")

    rows_in = len(df)
    lat = pd.to_numeric(df["lat"], errors="coerce")
    lon = pd.to_numeric(df["lon"], errors="coerce")
    tiv = pd.to_numeric(df["tiv_kes"], errors="coerce")
    keep = np.isfinite(lat) & np.isfinite(lon) & (tiv >= 0)
    df = df.loc[keep].reset_index(drop=True)

    raw_class = df["housing_class"].fillna("").astype(str).str.strip()
    known = raw_class.isin(HOUSING_CLASSES)
    out = pd.DataFrame({
        "loc_id": df["loc_id"].fillna("").astype(str).str.strip(),
        "lat": pd.to_numeric(df["lat"]),
        "lon": pd.to_numeric(df["lon"]),
        "housing_class": np.where(known, raw_class, FALLBACK_CLASS),
        "floor_area_m2": pd.to_numeric(df.get("floor_area_m2"), errors="coerce"),
        "cost_per_m2_kes": pd.to_numeric(df.get("cost_per_m2_kes"), errors="coerce"),
        "tiv_file_kes": pd.to_numeric(df["tiv_kes"]),
    })
    blank = out["loc_id"] == ""
    out.loc[blank, "loc_id"] = [f"row-{i + 2}" for i in np.flatnonzero(blank)]
    for t in SCORE_TIERS:
        s = pd.to_numeric(df[f"hazard_score_{t}"], errors="coerce").to_numpy(dtype=float)
        out[f"score_{t}"] = np.where(np.isfinite(s) & (s > 0), s, 0.0)

    info = {
        "file": os.path.basename(path),
        "rowsIn": int(rows_in),
        "rowsUsed": int(len(out)),
        "rowsDropped": int(rows_in - len(out)),
        "unknownClassRows": int((~known).sum()),
    }
    return out, info


def building_tiv(df: pd.DataFrame, basis: str) -> tuple[np.ndarray, int]:
    """TIV per building. 'file' keeps tiv_kes; 'documented' = round(floor area x cost / 5000) x 5000.

    Returns the TIV array and how many rows fell back to the file value because area or cost was missing.
    """
    file_tiv = df["tiv_file_kes"].to_numpy(dtype=float)
    if basis == "file":
        return file_tiv, 0
    if basis != "documented":
        raise ValueError(f"unknown TIV basis {basis!r}")
    product = df["floor_area_m2"].to_numpy(dtype=float) * df["cost_per_m2_kes"].to_numpy(dtype=float)
    ok = np.isfinite(product) & (product > 0)
    # Half rounds up, as JavaScript Math.round does.
    documented = np.floor(product / 5000.0 + 0.5) * 5000.0
    return np.where(ok, documented, file_tiv), int((~ok).sum())


# ---------------------------------------------------------------- tier slopes

def fit_slopes(grids: list[np.ndarray]) -> list[float]:
    """Least-squares slope of the widest tier's score on each tier's score (hazard.ts tierSlopes)."""
    n = len(grids)
    totals = [float(g.sum()) for g in grids]
    widest = int(np.argmax(totals))
    slopes = []
    for k in range(n):
        if k == widest:
            slopes.append(1.0)
            continue
        x, y = grids[k], grids[widest]
        both = (x > 0) & (y > 0)
        m = int(both.sum())
        if m < 2:
            slopes.append(1.0)
            continue
        x, y = x[both].astype(float), y[both].astype(float)
        sx, sy = x.sum(), y.sum()
        var_x = (x * x).sum() - sx * sx / m
        if not var_x > 1e-12:
            slopes.append(1.0)
            continue
        slope = ((x * y).sum() - sx * sy / m) / var_x
        slopes.append(min(1.0, float(slope)) if math.isfinite(slope) and slope > 0 else 1.0)
    return slopes


def slopes_from_columns(df: pd.DataFrame) -> dict:
    grids = [df[f"score_{t}"].to_numpy(dtype=float) for t in SCORE_TIERS]
    return dict(zip(SCORE_TIERS, fit_slopes(grids)))


def slopes_from_rasters(data_dir: str) -> tuple[dict | None, str]:
    """Fit the slopes on the five GeoTIFFs when they can be read and share one grid."""
    try:
        import tifffile  # noqa: F401
    except ImportError:
        return None, "tifffile is not installed"
    grids, shape, transform = [], None, None
    for t in SCORE_TIERS:
        found = sorted(glob.glob(os.path.join(data_dir, f"*_{t}.tif")) + glob.glob(os.path.join(data_dir, f"*_{t}.tiff")))
        if not found:
            return None, f"no raster found for tier {t}"
        try:
            with tifffile.TiffFile(found[0]) as tf:
                page = tf.pages[0]
                data = page.asarray().astype(np.float64)
                nodata_tag = page.tags.get("GDAL_NODATA")
                scale = page.tags.get("ModelPixelScaleTag")
                tie = page.tags.get("ModelTiepointTag")
                tr = (tuple(scale.value) if scale else None, tuple(tie.value) if tie else None)
        except Exception as exc:  # e.g. LZW without imagecodecs
            return None, f"could not read {os.path.basename(found[0])}: {exc}"
        if data.ndim > 2:
            data = data[..., 0] if data.shape[-1] < data.shape[0] else data[0]
        if shape is None:
            shape, transform = data.shape, tr
        elif data.shape != shape or tr != transform:
            return None, "rasters are not on one grid"
        valid = np.isfinite(data) & (data > 0)
        if nodata_tag is not None:
            try:
                valid &= data != float(str(nodata_tag.value).strip("\x00 "))
            except ValueError:
                pass
        grids.append(np.where(valid, data, 0.0).ravel())
    return dict(zip(SCORE_TIERS, fit_slopes(grids))), "fitted on the five hazard rasters"


# ---------------------------------------------------------------- damage and loss

def jrc_curve(depth_m: np.ndarray) -> np.ndarray:
    d = np.asarray(depth_m, dtype=float)
    # np.interp holds 1.0 beyond 6 m; depth <= 0 gives no damage.
    return np.where(d > 0, np.interp(d, JRC_DEPTHS_M, JRC_DAMAGE), 0.0)


def damage_ratio(depth_m: np.ndarray, fragility: np.ndarray, cap: np.ndarray) -> np.ndarray:
    effective = np.maximum(0.0, depth_m) * fragility
    return np.minimum(jrc_curve(effective), cap)


def tier_depths(df: pd.DataFrame, slopes: dict, params: dict) -> dict:
    """Depth in metres per building for each tier: score x slope x depth scale."""
    return {t: df[f"score_{t}"].to_numpy(dtype=float) * slopes[t] * params["depthScaleM"] for t in SCORE_TIERS}


def class_arrays(df: pd.DataFrame, params: dict) -> tuple[np.ndarray, np.ndarray]:
    frag = df["housing_class"].map(params["fragility"]).to_numpy(dtype=float)
    cap = df["housing_class"].map(params["cap"]).to_numpy(dtype=float)
    return frag, cap


def run_engine(df: pd.DataFrame, tiv: np.ndarray, slopes: dict, params: dict) -> dict:
    """Event loss per tier, exactly as pipeline.ts runModel computes it."""
    frag, cap = class_arrays(df, params)
    depths = tier_depths(df, slopes, params)
    losses = {}
    for t in SCORE_TIERS:
        losses[t] = float((damage_ratio(depths[t], frag, cap) * tiv).sum())
    return {"depths": depths, "eventLossKes": losses}


def curve_points(event_loss: dict, return_periods: dict) -> list[tuple[float, float]]:
    pts = sorted(((float(return_periods[t]), float(event_loss[t])) for t in SCORE_TIERS), key=lambda p: p[0])
    return pts


def trapezoid_aal(points: list[tuple[float, float]]) -> float:
    """financial.ts averageAnnualLoss: trapezoid over annual exceedance probability,
    nothing more frequent than the first point, flat beyond the last."""
    aal = 0.0
    for (rp_a, loss_a), (rp_b, loss_b) in zip(points[:-1], points[1:]):
        aal += (1.0 / rp_a - 1.0 / rp_b) * 0.5 * (loss_a + loss_b)
    rp_last, loss_last = points[-1]
    return aal + loss_last / rp_last


def banded_aal(points: list[tuple[float, float]], band_probability: list[float] | None = None) -> float:
    """Each event's loss held over its own exceedance band: sum of band probability x event loss.

    This is the average over periods that Oasis reports when each event occurs in a share of
    periods equal to its band.
    """
    if band_probability is None:
        probs = [1.0 / rp for rp, _ in points] + [0.0]
        band_probability = [probs[i] - probs[i + 1] for i in range(len(points))]
    return float(sum(p * loss for p, (_, loss) in zip(band_probability, points)))
