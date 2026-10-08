import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { financialChecks } from "../src/lib/checks";
import { drainageDistances, drainageSensitivity } from "../src/lib/geo/drainage";
import { withDrainage, type DrainageState } from "../src/lib/geo/drainageView";
import type { GeoCollection, SettlementProps, WardProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import type { LossMode } from "../src/lib/model/drivers";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { resultFingerprint, runModel } from "../src/lib/model/pipeline";
import { DEFAULT_TERMS } from "../src/lib/model/terms";
import type { Dataset, ModelResult } from "../src/lib/model/types";
import { extractOffer } from "../src/lib/offer/client";
import { docxToText } from "../src/lib/offer/docx";
import { DRIVER_IDS, DRIVER_LABELS } from "../src/lib/offer/drivers";
import { buildOfferFocus, isPriced, portfolioJudgement, type OfferFocus, type PricedFocus } from "../src/lib/offer/focus";
import { JUDGEMENT_KEYS, REFERENCE_JUDGEMENT } from "../src/lib/offer/judgement";
import { priceOffer, pricingRows } from "../src/lib/offer/price";
import { policyTerms } from "../src/lib/offer/terms";
import { OUTSIDE_MAPS_MESSAGE, type ExtractionRun, type OfferState } from "../src/lib/offer/types";

/**
 * The three lines the work on loss drivers is done by, proved the way the screen works: the
 * starter kit with drainage on, the header switch in each position, the reference assumptions,
 * and one picture of the offer built from what the rules read. No network and no model.
 *
 * Nothing here prints or holds any of the test documents' text: only figures worked out from them.
 */

const KIT = join(__dirname, "..", "..", "data", "data");
const TEST_DATA = join(__dirname, "..", "..", "data", "test-data");

function filesUnder(root: string): FileSource[] {
  const out: FileSource[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        out.push({
          path: relative(root, full).replaceAll("\\", "/"),
          size: statSync(full).size,
          text: async () => readFileSync(full, "utf8"),
          arrayBuffer: async () => {
            const b = readFileSync(full);
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
          },
        });
      }
    }
  };
  walk(root);
  return out;
}

const geo = <P,>(file: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", file), "utf8")) as GeoCollection<P>;
const kes = (v: number | null) => `KES ${Math.round(v ?? 0).toLocaleString("en-KE")}`;
const ALL: LossMode = "all_drivers";
const DEPTH: LossMode = "depth_only";

describe.skipIf(!existsSync(KIT))("loss drivers, end to end on the Nairobi starter kit with drainage on", () => {
  let dataset: Dataset;
  let drained: Dataset;
  let drainage: DrainageState;
  const layers = { wards: geo<WardProps>("wards.geojson"), waterways: geo<WaterwayProps>("waterways.geojson") };
  const results = {} as Record<LossMode, ModelResult>;

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
    const widest = dataset.rasters.find((r) => r.scenarioId === "common")!;
    const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, layers.waterways, geo<SettlementProps>("informal-settlements.geojson"));
    drainage = { distances, sensitivity: drainageSensitivity(distances, widest, dataset.hotspots) };
    drained = withDrainage(dataset, drainage);
    // The two runs the shell makes for the portfolio, one for each position of the header switch.
    results.depth_only = runModel(drained, REFERENCE_PARAMS, { mode: DEPTH, judgement: portfolioJudgement().assumed });
    results.all_drivers = runModel(drained, REFERENCE_PARAMS, { mode: ALL, judgement: portfolioJudgement().assumed });
  }, 120_000);

  /** The picture of an offer as the shell builds it: the view with drainage on, reference assumptions, nothing typed, no agents. */
  const focusOf = (run: ExtractionRun, name: string, mode: LossMode): OfferFocus => {
    const offer: OfferState = { document: { name, kind: "typed", text: run.documentText }, run, extraction: run.extraction };
    const focus = buildOfferFocus({ offer, session: { dataset: drained }, active: { source: "reference", params: REFERENCE_PARAMS, result: results[mode] }, drainage, policyDefaults: DEFAULT_TERMS, deliberation: null, layers, mode });
    if (!focus) throw new Error("an offer was read, so there should be a focus");
    return focus;
  };
  const priced = (focus: OfferFocus): PricedFocus => {
    if (!isPriced(focus)) throw new Error(`the offer should be priced, not ${focus.status}`);
    return focus;
  };
  const read = (text: string) => {
    const knownPlaces = [...layers.wards.features.flatMap((f) => (f.properties.name ?? "").split("/").map((n) => n.trim())), ...dataset.hotspots.map((h) => h.name)].filter(Boolean);
    return extractOffer(text, { rulesOnly: true, knownPlaces });
  };
  /** The engine's own pricing of the same rows, as it stood before the loss drivers: the offer's buildings run with the portfolio, depth at the point and ponding. */
  const pointPricing = (run: ExtractionRun) =>
    priceOffer({ dataset, params: REFERENCE_PARAMS, drainage, rows: pricingRows(run.extraction, layers.wards, dataset.hotspots), terms: policyTerms(run.extraction.terms, DEFAULT_TERMS), wards: layers.wards });

  /** Depth only on the picture of the offer is the engine's point pricing, figure for figure. */
  const expectPointPricing = (run: ExtractionRun, name: string) => {
    const focus = priced(focusOf(run, name, DEPTH));
    const engine = pointPricing(run);
    if (!engine.totals || !engine.portfolio) throw new Error("the engine should price the offer");
    const { total, portfolio } = focus.price;
    expect(total.tivKes).toBe(engine.totals.tivKes);
    expect(total.curve.map((c) => c.returnPeriod)).toEqual(engine.totals.scenarios.map((s) => s.returnPeriod));
    expect(total.curve.map((c) => c.groundUpKes)).toEqual(engine.totals.scenarios.map((s) => s.groundUpKes));
    expect(total.curve.map((c) => c.grossKes)).toEqual(engine.totals.scenarios.map((s) => s.grossKes));
    expect(total.aalGroundUpKes).toBe(engine.totals.aalGroundUpKes);
    expect(total.aalGrossKes).toBe(engine.totals.aalGrossKes);
    expect(total.ratePerMilleGross).toBe(engine.totals.ratePerMilleGross);
    // The portfolio it is set against is the depth-only portfolio every other figure refers to.
    expect(portfolio.without.loss100Kes).toBe(engine.portfolio.without.loss100Kes);
    expect(portfolio.without.aalKes).toBe(engine.portfolio.without.aalKes);
    expect(portfolio.without.aalKes).toBe(results.depth_only.aalKes);
    // Depth only is also what "All loss drivers" reports as its comparison.
    const all = priced(focusOf(run, name, ALL));
    expect(all.price.depthOnly.curve.map((c) => c.groundUpKes)).toEqual(total.curve.map((c) => c.groundUpKes));
    expect(all.price.depthOnly.aalGrossKes).toBe(total.aalGrossKes);
    // In depth-only mode the drivers beyond depth are off and carry no loss.
    for (const r of focus.drivers.perReturnPeriod) for (const id of ["overload", "basement", "interruption", "uncertainty"] as const) expect(r.groundUpKes[id]).toBe(0);
    return { focus, all };
  };

  it("Depth only reproduces the portfolio's figures from before the loss drivers, and All loss drivers adds to them", () => {
    const before = runModel(drained, REFERENCE_PARAMS);
    // The fingerprint and the figures printed before the work began, with drainage on.
    expect(resultFingerprint(results.depth_only)).toBe("b6cc5322");
    expect(resultFingerprint(before)).toBe("b6cc5322");
    expect(results.depth_only.mode).toBe(DEPTH);
    expect(results.depth_only.scenarios.map((s) => s.lossKes)).toEqual([592233279.4265198, 1062456260.2646208, 2399524294.86634, 4044755943.6941547, 6471817611.03932]);
    expect(results.depth_only.aalKes).toBe(173918884.04320398);
    expect(resultFingerprint(runModel(dataset, REFERENCE_PARAMS, { mode: DEPTH }))).toBe("bdc87191");

    const all = results.all_drivers;
    expect(all.mode).toBe(ALL);
    expect(all.judgement).toEqual(REFERENCE_JUDGEMENT);
    expect(all.totalTivKes).toBe(before.totalTivKes);
    all.scenarios.forEach((s, k) => expect(s.lossKes).toBeGreaterThanOrEqual(before.scenarios[k].lossKes));
    expect(all.aalKes).toBeGreaterThan(before.aalKes);
    // Drivers 1 to 3 only on the portfolio, and they add up to each scenario's loss.
    for (const s of all.scenarios) {
      const by = s.byDriver;
      if (!by) throw new Error("all loss drivers should split each scenario by driver");
      const sum = Object.values(by).reduce((t, v) => t + v, 0);
      expect(Math.abs(sum - s.lossKes)).toBeLessThanOrEqual(1e-6 * Math.max(1, s.lossKes));
    }
    expect(financialChecks(drained, all).filter((c) => c.status === "fail")).toEqual([]);
    expect(financialChecks(drained, results.depth_only).filter((c) => c.status === "fail")).toEqual([]);

    const at100 = (r: ModelResult) => r.standardLosses.find((l) => l.returnPeriod === 100)?.lossKes ?? null;
    console.log(
      [
        "Nairobi portfolio, drainage on, reference assumptions (ground-up):",
        `  Depth only:       1-in-100 ${kes(at100(results.depth_only))}, average annual loss ${kes(results.depth_only.aalKes)}`,
        `  All loss drivers: 1-in-100 ${kes(at100(all))}, average annual loss ${kes(all.aalKes)}`,
      ].join("\n"),
    );
  });

  it("Depth only reproduces the engine's point pricing for a typed offer", async () => {
    const run = await read("two-storey masonry shop in Kibera worth KES 8 million");
    const { focus, all } = expectPointPricing(run, "typed text");
    // With all loss drivers the same offer never prices lower.
    all.price.total.curve.forEach((c, k) => expect(c.groundUpKes).toBeGreaterThanOrEqual(focus.price.total.curve[k].groundUpKes));
  });

  const memos = existsSync(TEST_DATA) ? readdirSync(TEST_DATA).filter((f) => f.toLowerCase().endsWith(".docx")) : [];
  const nairobiFile = memos.find((f) => f.toUpperCase().includes("NAIROBI"));
  const nzoiaFile = memos.find((f) => f.toUpperCase().includes("NZOIA"));

  describe.skipIf(!nairobiFile || !nzoiaFile)("the two test offers, read by the rules", () => {
    let nairobi: ExtractionRun;
    let nzoia: ExtractionRun;

    beforeAll(async () => {
      nairobi = await read(await docxToText(readFileSync(join(TEST_DATA, nairobiFile!))));
      nzoia = await read(await docxToText(readFileSync(join(TEST_DATA, nzoiaFile!))));
    }, 120_000);

    it("Depth only reproduces the engine's point pricing for the Nairobi offer", () => {
      expectPointPricing(nairobi, "nairobi offer");
    });

    it("the Nairobi offer has a loss above zero from Drain overload and from Basement ingress, and every driver line names a source", () => {
      const focus = priced(focusOf(nairobi, "nairobi offer", ALL));
      const d = focus.drivers;
      expect(focus.mode).toBe(ALL);
      expect(d.mode).toBe(ALL);
      expect(d.perReturnPeriod.some((r) => r.groundUpKes.overload > 0)).toBe(true);
      expect(d.perReturnPeriod.some((r) => r.groundUpKes.basement > 0)).toBe(true);
      expect(d.aal.groundUpKes.overload).toBeGreaterThan(0);
      expect(d.aal.groundUpKes.basement).toBeGreaterThan(0);
      expect(focus.price.total.aalGroundUpKes).toBeGreaterThan(0);
      expect(focus.price.total.loss100GroundUpKes ?? 0).toBeGreaterThan(0);

      // Six lines, by their exact names, each with at least one source that says what it is.
      // Checked one plain value at a time, so a failure cannot print a word of the document.
      const oneLine = (text: string) => text.replace(/\s+/g, " ");
      expect(d.lines.map((l) => l.label).join("|")).toBe(DRIVER_IDS.map((id) => DRIVER_LABELS[id]).join("|"));
      for (const line of d.lines) {
        expect(line.text.trim() !== "").toBe(true);
        expect(line.sources.length > 0).toBe(true);
        for (const s of line.sources) {
          expect(s.what.trim() !== "").toBe(true);
          if (s.kind === "offer") expect(s.quote.trim() !== "" && oneLine(nairobi.documentText).includes(oneLine(s.quote))).toBe(true);
          if (s.kind === "assumption") expect(s.keys.every((k) => JUDGEMENT_KEYS.includes(k))).toBe(true);
        }
      }
      expect(d.lines.find((l) => l.id === "overload")?.on).toBe(true);
      expect(d.lines.find((l) => l.id === "basement")?.on).toBe(true);
      // An on driver that rests on an assumption names the figures, so the screen can badge and link each one.
      // Ponding is the exception: its depth per return period belongs to the drainage layer, not to the judgement figures.
      for (const line of d.lines.filter((l) => l.on && l.id !== "ponding")) for (const s of line.sources) if (s.kind === "assumption") expect(s.keys.length > 0).toBe(true);
      // Who set each figure is known for every assumption: here the offer or the reference set, as no agents ran and nothing was typed.
      for (const key of JUDGEMENT_KEYS) expect(["offer", "reference"]).toContain(focus.judgement.setBy[key]);
      // What the offer does not state is asked of the broker.
      expect(focus.questions.length).toBeGreaterThan(0);
      expect(focus.questions.every((q) => q.question.trim() !== "" && q.why.trim() !== "")).toBe(true);
      // The offer is set against the portfolio measured the same way.
      expect(focus.price.portfolio.without.aalKes).toBe(results.all_drivers.aalKes);
    });

    it("the Nzoia offer stops at the exact sentence, with no figures, in both modes", () => {
      for (const mode of [ALL, DEPTH]) {
        const focus = focusOf(nzoia, "nzoia offer", mode);
        expect(focus.status).toBe("outside");
        expect(focus.outside).toBe(true);
        expect(focus.outsideMessage).toBe("Outside the hazard maps loaded: flood cannot be priced here");
        expect(OUTSIDE_MAPS_MESSAGE).toBe("Outside the hazard maps loaded: flood cannot be priced here");
        expect(focus.statusLine).toBe("Outside the hazard maps loaded: flood cannot be priced here.");
        expect(isPriced(focus)).toBe(false);
        expect(focus.drivers).toBeNull();
        expect(focus.price).toBeNull();
        expect(focus.summary).toMatchObject({ loss100Kes: null, aalKes: null, outside: true });
      }
    });
  });
});
