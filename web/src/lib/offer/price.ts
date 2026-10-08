import { withDrainage } from "../geo/drainageView";
import { sampleRaster } from "../ingest/raster";
import { averageAnnualLoss, type CurvePoint } from "../model/financial";
import { depthAt, runModel } from "../model/pipeline";
import { HOUSING_CLASSES, type Building, type Dataset, type HousingClass, type ModelResult } from "../model/types";
import { inKenya } from "./coords";
import { locateByName, nearestWetCellM, wardOf } from "./locate";
import { grossLosses } from "./terms";
import {
  OUTSIDE_MAPS_MESSAGE,
  type OfferLocation,
  type OfferRow,
  type OfferScenario,
  type OfferTotals,
  type PlaceMatch,
  type PortfolioFigures,
  type PriceOffer,
  type PricingRow,
  type PricingRows,
  type RowPricing,
  type RowScenario,
} from "./types";
import { usableValue, waitingValues } from "./verify";

/**
 * Pricing one offer. Code only: nothing in this file reaches a model.
 *
 * The offer's buildings are priced by the same engine as the portfolio. They are added to the
 * loaded buildings, the model is run on the longer list, and each offer row is read back out of
 * that run. So an offer and the portfolio are always measured the same way, on the same maps,
 * with the same assumptions.
 */

/** A stated quantity that can be used in a sum: a number above zero. */
const positive = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v > 0 ? v : null);

function locate(row: OfferRow, placeName: string | null, place: PlaceMatch | null): OfferLocation {
  // Coordinates the document gives but code could not verify are settled first. A place name
  // never quietly stands in for them: the underwriter confirms, edits or clears them.
  if (row.lat.status === "unverified" || row.lon.status === "unverified") return { kind: "none", reason: "The coordinates are not verified: confirm, edit or clear them." };
  const lat = usableValue(row.lat);
  const lon = usableValue(row.lon);
  const hasPoint = lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon);
  if (hasPoint && inKenya(lat, lon)) {
    // A reading describes the document's own words, so it is dropped once the underwriter has typed over either number.
    const typed = row.lat.status === "edited" || row.lon.status === "edited";
    return { kind: "exact", lat, lon, reading: typed ? null : row.coordinates };
  }
  if (placeName && place) return { kind: "approximate", lat: place.lat, lon: place.lon, source: place.source, matchedName: place.matchedName, placeName };

  const unknownPlace = placeName ? ` "${placeName}" is not a ward or a named flood area in the loaded data.` : "";
  if (hasPoint) return { kind: "none", reason: `The coordinates are outside Kenya.${unknownPlace}` };
  if (placeName) return { kind: "none", reason: `No usable coordinates.${unknownPlace}` };
  return { kind: "none", reason: "No usable coordinates and no place name." };
}

export const pricingRows: PricingRows = (extraction, wards, hotspots) => {
  const placeName = usableValue(extraction.terms.placeName)?.trim() || null;
  const place = placeName ? locateByName(placeName, wards, hotspots) : null;
  // A value that failed its check is never priced around: it blocks its own row, or every row
  // when it belongs to the offer as a whole.
  const waiting = waitingValues(extraction);
  const notVerified = (label: string) => `${label} is not verified. Confirm it, edit it or clear it.`;

  return extraction.rows.map((row, index): PricingRow => {
    const location = locate(row, placeName, place);
    const stated = usableValue(row.housingClass);
    const housingClass: HousingClass | null = stated !== null && (HOUSING_CLASSES as readonly string[]).includes(stated) ? stated : null;
    const floorAreaM2 = positive(usableValue(row.floorAreaM2));
    const costPerM2Kes = positive(usableValue(row.costPerM2Kes));
    const statedTiv = positive(usableValue(row.tivKes));
    const workedOut = floorAreaM2 !== null && costPerM2Kes !== null ? floorAreaM2 * costPerM2Kes : null;
    const tivKes = statedTiv ?? workedOut;

    const blockers: string[] = [];
    if (location.kind === "none") blockers.push(`No location. ${location.reason}`);
    if (housingClass === null) blockers.push("No housing class. Pick one of the four classes.");
    if (tivKes === null) blockers.push("No insured value. Enter it, or the floor area and the cost per m².");
    for (const w of waiting) if (w.ref.scope === "terms" || (w.ref.scope === "row" && w.ref.row === index)) blockers.push(notVerified(w.label));

    return {
      index,
      locId: `OFFER-${index + 1}`,
      name: usableValue(row.name)?.trim() || `Building ${index + 1}`,
      path: row.path,
      location,
      housingClass,
      floorAreaM2,
      costPerM2Kes,
      tivKes,
      tivFrom: statedTiv !== null ? "stated" : workedOut !== null ? "area_times_cost" : null,
      blockers,
    };
  });
};

const scenariosOf = (result: ModelResult): OfferScenario[] => result.scenarios.map((s) => ({ id: s.id, label: s.label, returnPeriod: s.returnPeriod }));

function portfolioFigures(result: ModelResult): PortfolioFigures {
  const at100 = result.standardLosses.find((s) => s.returnPeriod === 100);
  return {
    buildings: result.buildingCount,
    totalTivKes: result.totalTivKes,
    loss100Kes: at100?.lossKes ?? null,
    loss100Extrapolated: at100?.extrapolated ?? false,
    aalKes: result.aalKes,
  };
}

/** A row that is located, inside every map, and has a class and a value: ready for the engine. */
interface Ready {
  row: PricingRow;
  location: Exclude<OfferLocation, { kind: "none" }>;
  housingClass: HousingClass;
  tivKes: number;
  /** Hazard value per scenario, in the order of Dataset.scenarios. */
  hazard: number[];
}

export const priceOffer: PriceOffer = ({ dataset, params, drainage, rows, terms, wards }) => {
  // Drainage is decided by the drainage argument alone, whatever the dataset arrived with.
  const base: Dataset = { ...dataset, drainage: undefined };
  const kind = base.hazardKind;
  // One map per scenario is needed to say anything about a point. Hazard taken from columns in
  // the exposure file has no map behind it, so a new point cannot be looked up at all.
  const maps = base.scenarios.map((s) => base.rasters.find((r) => r.scenarioId === s.id));
  const mapsLoaded = maps.length > 0 && maps.every((m) => m !== undefined);

  const ready: Ready[] = [];
  const outcome: (RowPricing | Ready)[] = rows.map((row) => {
    const { locId, name, location } = row;
    const notReady = (): RowPricing => ({ status: "not_ready", locId, name, location, blockers: row.blockers.length > 0 ? row.blockers : ["No location."] });
    if (location.kind === "none") return notReady();

    // Location is tested before anything else: outside the maps there is no flood figure to give,
    // whatever else the row has or lacks. A point outside is never handed to the engine, which
    // would read "outside" as dry and return a loss of zero.
    const samples = maps.map((m) => (m ? sampleRaster(m, location.lon, location.lat, kind) : null));
    const inside = mapsLoaded && Number.isFinite(location.lat) && Number.isFinite(location.lon) && samples.every((s) => s !== null && s.inside);
    if (!inside) return { status: "outside", locId, name, location, message: OUTSIDE_MAPS_MESSAGE };

    if (row.housingClass === null || row.tivKes === null || row.blockers.length > 0) return notReady();
    const item: Ready = { row, location, housingClass: row.housingClass, tivKes: row.tivKes, hazard: samples.map((s) => s?.value ?? 0) };
    ready.push(item);
    return item;
  });

  // The tier slopes are fitted on the hazard maps, which are shared untouched, so the extra
  // buildings do not move them. The portfolio alone is also run on its own below, so the
  // "without" figures are exactly the ones the rest of the app shows.
  const added: Building[] = ready.map((r) => ({
    locId: r.row.locId,
    lat: r.location.lat,
    lon: r.location.lon,
    housingClassRaw: r.housingClass,
    housingClass: r.housingClass,
    floorAreaM2: r.row.floorAreaM2,
    costPerM2Kes: r.row.costPerM2Kes,
    tivKes: r.tivKes,
    synthetic: false,
    hazard: r.hazard,
  }));
  const own = base.buildings.length;
  const combined: Dataset = { ...base, buildings: [...base.buildings, ...added] };
  const withOffer = drainage ? withDrainage(combined, drainage) : combined;
  // The portfolio alone, under the same drainage. Its ponding is the first part of the combined list.
  const alone: Dataset = withOffer.drainage ? { ...base, drainage: { ...withOffer.drainage, buildingStress: withOffer.drainage.buildingStress.slice(0, own) } } : base;

  const without = runModel(alone, params);
  const scenarios = scenariosOf(without);
  const common = { scenarios, terms, drainageOn: drainage !== null };

  if (ready.length === 0) {
    return { ...common, rows: outcome.filter((o): o is RowPricing => "status" in o), totals: null, portfolio: null };
  }

  const result = runModel(withOffer, params);
  const curve = (losses: number[]): CurvePoint[] => scenarios.map((s, k) => ({ returnPeriod: s.returnPeriod, lossKes: losses[k] }));
  // Result scenarios run from most frequent to rarest; the dataset keeps its own order.
  const source = result.scenarios.map((s) => base.scenarios.findIndex((d) => d.id === s.id));

  // Gross loss per scenario and building: ground-up less the deductible, capped at the limit.
  const tivs = ready.map((r) => r.tivKes);
  const offerTiv = tivs.reduce((t, v) => t + v, 0);
  const grossBy = result.scenarios.map((_, k) => grossLosses(ready.map((_r, j) => result.buildings[own + j].perScenario[k].lossKes), tivs, terms));
  const groundUp = result.scenarios.map((_, k) => ready.reduce((t, _r, j) => t + result.buildings[own + j].perScenario[k].lossKes, 0));
  const gross = grossBy.map((row) => row.reduce((t, v) => t + v, 0));

  const priced = new Map<Ready, RowPricing>();
  ready.forEach((r, j) => {
    const bi = own + j;
    const { lat, lon } = r.location;
    const perScenario: RowScenario[] = result.scenarios.map((s, k) => {
      const p = result.buildings[bi].perScenario[k];
      const d = depthAt(withOffer, bi, source[k], params, s.tierSlope);
      const map = maps[source[k]];
      return {
        id: s.id,
        label: s.label,
        returnPeriod: s.returnPeriod,
        hazard: p.hazard,
        terrainM: d.terrainM,
        drainageM: d.drainageM,
        depthM: p.depthM,
        damageRatio: p.damageRatio,
        groundUpKes: p.lossKes,
        grossKes: grossBy[k][j],
        // "Dry" is said of the terrain map, whatever the drainage ponding adds.
        nearestWetM: p.hazard > 0 || !map ? null : nearestWetCellM(map, lon, lat, kind),
      };
    });
    const aalGroundUpKes = averageAnnualLoss(curve(perScenario.map((x) => x.groundUpKes)));
    const aalGrossKes = averageAnnualLoss(curve(perScenario.map((x) => x.grossKes)));
    priced.set(r, {
      status: "priced",
      locId: r.row.locId,
      name: r.row.name,
      location: r.location,
      housingClass: r.housingClass,
      tivKes: r.tivKes,
      tivFrom: r.row.tivFrom ?? "stated",
      ward: wardOf({ lat, lon }, wards),
      scenarios: perScenario,
      dryInEveryTier: perScenario.every((x) => !(x.hazard > 0)),
      aalGroundUpKes,
      aalGrossKes,
      ratePerMilleGroundUp: (aalGroundUpKes / r.tivKes) * 1000,
      ratePerMilleGross: (aalGrossKes / r.tivKes) * 1000,
    });
  });

  const aalGroundUpKes = averageAnnualLoss(curve(groundUp));
  const aalGrossKes = averageAnnualLoss(curve(gross));
  const totals: OfferTotals = {
    rows: ready.length,
    tivKes: offerTiv,
    scenarios: scenarios.map((s, k) => ({ ...s, groundUpKes: groundUp[k], grossKes: gross[k] })),
    aalGroundUpKes,
    aalGrossKes,
    ratePerMilleGroundUp: (aalGroundUpKes / offerTiv) * 1000,
    ratePerMilleGross: (aalGrossKes / offerTiv) * 1000,
  };

  return {
    ...common,
    rows: outcome.map((o) => ("status" in o ? o : priced.get(o)!)),
    totals,
    portfolio: { without: portfolioFigures(without), with: portfolioFigures(result) },
  };
};
