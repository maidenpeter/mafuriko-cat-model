import { describe, expect, it } from "vitest";
import { BASEMENT_LADDER, JUDGEMENT_KEYS, REFERENCE_JUDGEMENT } from "../src/lib/offer/judgement";
import { BROKER_QUESTION_IDS, brokerQuestions } from "../src/lib/offer/questions";
import { extractByRules } from "../src/lib/offer/rules";
import type { OfferExtraction, OfferRow, OfferTerms, Quoted } from "../src/lib/offer/types";
import { editValue, verifyExtraction } from "../src/lib/offer/verify";

// Every name, figure and sentence in this file is invented for the tests.

const stated = <T>(value: T, quote = "An invented sentence that states it."): Quoted<T> => ({ value, quote, status: "verified", reason: null });
const unsaid = <T>(): Quoted<T> => ({ value: null, quote: "", status: "missing", reason: null });

const row = (over: Partial<OfferRow> = {}): OfferRow => ({
  name: stated("Mwangaza Court"),
  lat: stated(-1.27),
  lon: stated(36.81),
  housingClass: stated("concrete_rcc"),
  floorAreaM2: unsaid(),
  costPerM2Kes: unsaid(),
  tivKes: stated(4_000_000_000),
  path: "rules",
  coordinates: null,
  ...over,
});

/** The values every offer carried before the loss drivers: all stated, so only the drivers' own questions are left. */
const coreTerms = (over: Partial<OfferTerms> = {}): OfferTerms => ({
  basements: stated(3),
  occupancy: stated("commercial"),
  floodDeductiblePct: stated(5),
  floodDeductibleMinKes: stated(2_000_000),
  floodDeductibleBasis: unsaid(),
  floodLimitKes: stated(900_000_000),
  policyPeriod: unsaid(),
  floodCover: stated("covered"),
  placeName: stated("Westlands"),
  riverName: unsaid(),
  riverDistanceM: unsaid(),
  ...over,
});

/** Everything the loss drivers read, stated. */
const driverTerms = (): Partial<OfferTerms> => ({
  basementDepthM: stated(9.5),
  drainDesignRp: stated(10),
  sumpPumpCapacity: stated("2 x 15 l/s"),
  sumpPumpBackup: stated("yes"),
  floodBarriers: stated("absent"),
  nonReturnValves: stated("present"),
  valueBuildingKes: stated(3_100_000_000),
  valueMachineryKes: stated(420_000_000),
  valueContentsKes: stated(180_000_000),
  valueBelowGroundKes: stated(260_000_000),
  annualRentKes: stated(300_000_000),
  biCovered: stated("covered"),
  premiumKes: stated(9_600_000),
});

const offer = (terms: OfferTerms, over: Partial<OfferExtraction> = {}): OfferExtraction => ({ rows: [row()], terms, notes: [], ...over });
const ids = (extraction: OfferExtraction) => brokerQuestions(extraction).map((q) => q.id);

const DRIVER_QUESTIONS = ["valueBelowGroundKes", "drainDesignRp", "biCovered", "annualRentKes", "floodBarriers", "nonReturnValves", "sumpPumpCapacity", "sumpPumpBackup", "basementDepthM", "equipmentBelowGround", "valueSplit", "premiumKes"];

describe("questions for the broker", () => {
  it("asks nothing when the document states everything", () => {
    const full = offer(coreTerms(driverTerms()), { equipmentBelowGround: [{ item: stated("Standby generators") }] });
    expect(brokerQuestions(full)).toEqual([]);
  });

  it("asks one question for each value the loss drivers need and the document does not state", () => {
    // Terms built by hand, with none of the drivers' values on them at all.
    expect(ids(offer(coreTerms()))).toEqual(DRIVER_QUESTIONS);
    // The same once the checks have filled them in as not stated.
    expect(ids(verifyExtraction(offer(coreTerms()), ""))).toEqual(DRIVER_QUESTIONS);
    for (const q of brokerQuestions(offer(coreTerms()))) {
      expect(q.question.endsWith("?"), q.id).toBe(true);
      // One sentence on why, and never a dash that a reader could take for a range.
      expect(q.why.endsWith("."), q.id).toBe(true);
      expect(`${q.question} ${q.why}`).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("stops asking for a value as soon as it is stated, one value at a time", () => {
    const given = driverTerms();
    const one: [keyof OfferTerms, string][] = [
      ["valueBelowGroundKes", "valueBelowGroundKes"],
      ["drainDesignRp", "drainDesignRp"],
      ["biCovered", "biCovered"],
      ["annualRentKes", "annualRentKes"],
      ["floodBarriers", "floodBarriers"],
      ["nonReturnValves", "nonReturnValves"],
      ["sumpPumpCapacity", "sumpPumpCapacity"],
      ["sumpPumpBackup", "sumpPumpBackup"],
      ["basementDepthM", "basementDepthM"],
      ["premiumKes", "premiumKes"],
    ];
    for (const [key, id] of one) {
      expect(ids(offer(coreTerms({ [key]: given[key] } as Partial<OfferTerms>))), key).toEqual(DRIVER_QUESTIONS.filter((q) => q !== id));
    }
    // The split is asked for until all three parts are stated, and names only the parts that are missing.
    const split = (terms: Partial<OfferTerms>) => brokerQuestions(offer(coreTerms(terms))).find((q) => q.id === "valueSplit")?.question;
    expect(split({})).toBe("How is the insured value split between the building, its plant and machinery, and its contents, in KES?");
    expect(split({ valueMachineryKes: given.valueMachineryKes })).toBe("How much of the insured value is for the building and its contents, in KES?");
    expect(split({ valueBuildingKes: given.valueBuildingKes, valueContentsKes: given.valueContentsKes })).toBe("How much of the insured value is for its plant and machinery, in KES?");
    expect(split({ valueBuildingKes: given.valueBuildingKes, valueMachineryKes: given.valueMachineryKes, valueContentsKes: given.valueContentsKes })).toBeUndefined();
    // One item is enough for the equipment not to be asked for.
    expect(ids(offer(coreTerms(), { equipmentBelowGround: [{ item: stated("Fire pumps") }] }))).not.toContain("equipmentBelowGround");
    // An item the underwriter cleared states nothing.
    expect(ids(offer(coreTerms(), { equipmentBelowGround: [{ item: unsaid() }] }))).toContain("equipmentBelowGround");
  });

  it("puts the answer that could move the price most first", () => {
    const bare: OfferExtraction = {
      rows: [row({ lat: unsaid(), lon: unsaid(), housingClass: unsaid(), tivKes: unsaid() })],
      terms: coreTerms({ basements: unsaid(), occupancy: unsaid(), floodDeductiblePct: unsaid(), floodDeductibleMinKes: unsaid(), floodLimitKes: unsaid(), placeName: unsaid() }),
      notes: [],
    };
    // Every question there is, in the one fixed order.
    expect(ids(bare)).toEqual([...BROKER_QUESTION_IDS]);
    expect(ids(bare).slice(0, 8)).toEqual(["coordinates", "tivKes", "housingClass", "floodDeductible", "floodLimitKes", "basements", "valueBelowGroundKes", "drainDesignRp"]);
    expect(new Set(ids(bare)).size).toBe(BROKER_QUESTION_IDS.length);
  });

  it("says what the model assumes until the answer comes, from the assumptions in force", () => {
    const byId = (extraction: OfferExtraction, judgement = REFERENCE_JUDGEMENT) => Object.fromEntries(brokerQuestions(extraction, judgement).map((q) => [q.id, q]));
    const reference = byId(offer(coreTerms()));
    expect(reference.drainDesignRp).toEqual({
      id: "drainDesignRp",
      question: "What is the design return period of the site's storm drains?",
      why: "The model assumes 1-in-25 (4% a year) until told otherwise, and that decides from which flood the site is treated as wet.",
      assumes: { keys: ["drainDesignRp"], text: "The drains are taken as designed for a 1-in-25 (4% a year) event." },
    });
    expect(reference.valueBelowGroundKes.why).toBe("The model assumes 8% of the insured value until told otherwise, and the loss from basement ingress is a share of that figure.");
    expect(reference.annualRentKes.why).toBe("When business interruption is covered, the model assumes a year's rent of 8% of the insured value until told otherwise.");

    // Figures set by the agents or typed on screen are the ones quoted.
    const moved = byId(offer(coreTerms()), { ...REFERENCE_JUDGEMENT, drainDesignRp: 10, belowGroundShare: 0.125, annualRentShare: 0.06 });
    expect(moved.drainDesignRp.why).toMatch(/^The model assumes 1-in-10 \(10% a year\) until told otherwise/);
    expect(moved.valueBelowGroundKes.why).toMatch(/^The model assumes 12\.5% of the insured value/);
    expect(moved.annualRentKes.why).toMatch(/a year's rent of 6% of the insured value/);
  });

  it("pairs each question with what stands in for its answer, or with nothing", () => {
    const byId = (extraction: OfferExtraction, judgement = REFERENCE_JUDGEMENT) => Object.fromEntries(brokerQuestions(extraction, judgement).map((q) => [q.id, q.assumes]));
    const bare = byId(offer(coreTerms({ basements: unsaid(), occupancy: unsaid(), floodDeductiblePct: unsaid(), floodDeductibleMinKes: unsaid(), floodLimitKes: unsaid(), placeName: unsaid() }), { rows: [row({ lat: unsaid(), lon: unsaid(), tivKes: unsaid(), housingClass: unsaid() })] }));
    expect(Object.keys(bare)).toEqual([...BROKER_QUESTION_IDS]);
    // Nothing is assumed where the building cannot be priced, a driver stays off, or the value is context.
    for (const id of ["coordinates", "tivKes", "housingClass", "basements", "biCovered", "occupancy", "valueSplit", "premiumKes"]) expect(bare[id], id).toBeNull();
    // The example terms stand in, and they are not judgement figures.
    expect(bare.floodDeductible).toEqual({ keys: [], text: "The example deductible of the Insurance terms panel." });
    expect(bare.floodLimitKes).toEqual({ keys: [], text: "The example limit of the Insurance terms panel." });
    // The judgement figures that stand in, by key, with the figure in force in the sentence.
    expect(bare.valueBelowGroundKes).toEqual({ keys: ["belowGroundShare"], text: "8% of the insured value is taken to be below ground." });
    expect(bare.equipmentBelowGround).toEqual(bare.valueBelowGroundKes);
    expect(bare.annualRentKes?.keys).toEqual(["annualRentShare"]);
    expect(bare.floodBarriers?.keys).toEqual(["ingressThresholdM"]);
    expect(bare.nonReturnValves).toEqual(bare.floodBarriers);
    for (const id of ["sumpPumpCapacity", "sumpPumpBackup", "basementDepthM"]) expect(bare[id]?.keys, id).toEqual(BASEMENT_LADDER);
    // Every key is a judgement figure, and every sentence ends as one.
    for (const assumes of Object.values(bare)) {
      if (!assumes) continue;
      for (const key of assumes.keys) expect(JUDGEMENT_KEYS).toContain(key);
      expect(assumes.text).toMatch(/\.$/);
    }
    // A named area stands in for coordinates that are not given.
    expect(byId(offer(coreTerms(), { rows: [row({ lat: unsaid(), lon: unsaid() })] })).coordinates).toEqual({ keys: [], text: "The centre of the named area stands in for the building's position." });
    // The figures in force are the ones quoted.
    const moved = byId(offer(coreTerms()), { ...REFERENCE_JUDGEMENT, drainDesignRp: 10, belowGroundShare: 0.125, ingressThresholdM: 0.3 });
    expect(moved.drainDesignRp?.text).toBe("The drains are taken as designed for a 1-in-10 (10% a year) event.");
    expect(moved.valueBelowGroundKes?.text).toBe("12.5% of the insured value is taken to be below ground.");
    expect(moved.floodBarriers?.text).toBe("A basement is taken to flood once surface water at the site reaches 0.3 m.");
    // With the value below ground stated, the equipment question has nothing standing in for it.
    expect(byId(offer(coreTerms({ valueBelowGroundKes: stated(90_000_000) }))).equipmentBelowGround).toBeNull();
  });

  it("asks nothing about a basement of a building the document says has none", () => {
    const none = ids(offer(coreTerms({ basements: stated(0) })));
    for (const id of ["basements", "valueBelowGroundKes", "floodBarriers", "nonReturnValves", "sumpPumpCapacity", "sumpPumpBackup", "basementDepthM", "equipmentBelowGround"]) expect(none, id).not.toContain(id);
    // The drains, the cover and the rest still matter to a building with no basement.
    expect(none).toEqual(["drainDesignRp", "biCovered", "annualRentKes", "valueSplit", "premiumKes"]);
    // With the number of levels not stated, that is the first of the drivers' questions and the rest follow.
    const unknown = ids(offer(coreTerms({ basements: unsaid() })));
    expect(unknown).toEqual(["basements", ...DRIVER_QUESTIONS]);
  });

  it("never says basement ingress is left out while the document places something below ground", () => {
    const basements = (extraction: OfferExtraction) => brokerQuestions(extraction).find((q) => q.id === "basements");
    // Nothing below ground and no count: the answer decides whether the loss is counted, and nothing stands in.
    const open = basements(offer(coreTerms({ basements: unsaid() })))!;
    expect(open.why).toContain("decides whether that loss is counted at all");
    expect(open.assumes).toBeNull();
    // Equipment below ground with no count of levels: the driver is on, so only the count is asked for.
    const priced = basements(offer(coreTerms({ basements: unsaid() }), { equipmentBelowGround: [{ item: stated("Standby generators") }] }))!;
    expect(priced.question).toBe("How many basement levels does the building have?");
    expect(priced.why).toContain("already priced");
    expect(priced.why).not.toContain("decides whether");
    expect(priced.assumes).toEqual({ keys: [], text: "Basement ingress is priced: the document places equipment, plant or value below ground." });
    // The same for a stated value below ground.
    expect(basements(offer(coreTerms({ basements: unsaid(), valueBelowGroundKes: stated(90_000_000) })))!.why).toContain("already priced");
  });

  it("asks for the value below ground when the document says no basements yet places equipment below ground", () => {
    // A buried tank, say: Basement ingress is on with an assumed share, so the assumption has its question.
    const asked = brokerQuestions(offer(coreTerms({ basements: stated(0) }), { equipmentBelowGround: [{ item: stated("Buried diesel tank") }] }));
    const below = asked.find((q) => q.id === "valueBelowGroundKes");
    expect(below?.assumes).toEqual({ keys: ["belowGroundShare"], text: "8% of the insured value is taken to be below ground." });
    // With nothing below ground, a stated zero still asks nothing about a basement.
    expect(ids(offer(coreTerms({ basements: stated(0) })))).not.toContain("valueBelowGroundKes");
  });

  it("asks what the building is used for when the document does not say", () => {
    const asked = brokerQuestions(offer(coreTerms({ occupancy: unsaid() })));
    const use = asked.find((q) => q.id === "occupancy");
    expect(use?.question).toBe("What is the building used for: homes, offices or shops, industry, or a mix?");
    expect(use?.assumes).toBeNull();
    expect(ids(offer(coreTerms()))).not.toContain("occupancy");
  });

  it("does not ask for a year's rent when business interruption is excluded", () => {
    expect(ids(offer(coreTerms({ biCovered: stated("excluded") })))).not.toContain("annualRentKes");
    expect(ids(offer(coreTerms({ biCovered: stated("covered") })))).toContain("annualRentKes");
    // Not stated either way, the rent is still worth asking for with the cover.
    expect(ids(offer(coreTerms()))).toEqual(expect.arrayContaining(["biCovered", "annualRentKes"]));
  });

  it("leaves a value that was read but not yet verified to the underwriter, and counts a typed one as stated", () => {
    const unverified: Quoted<number> = { value: 50, quote: "The drains were built for a big storm.", status: "unverified", reason: "The number 50 is not written in the quoted sentence." };
    expect(ids(offer(coreTerms({ drainDesignRp: unverified })))).not.toContain("drainDesignRp");
    const typed = editValue(offer(coreTerms()), { scope: "terms", key: "drainDesignRp" }, "1-in-50");
    expect(ids(typed)).not.toContain("drainDesignRp");
    // Cleared again, it is asked again.
    expect(ids(editValue(typed, { scope: "terms", key: "drainDesignRp" }, null))).toContain("drainDesignRp");
  });

  it("asks for the position, the value and the class only where a building lacks them", () => {
    const located = offer(coreTerms(driverTerms()), { equipmentBelowGround: [{ item: stated("Standby generators") }] });
    const with_ = (over: Partial<OfferRow>, terms: Partial<OfferTerms> = {}) => brokerQuestions({ ...located, rows: [row(over)], terms: { ...located.terms, ...terms } });

    const noPoint = with_({ lat: unsaid(), lon: unsaid() });
    expect(noPoint.map((q) => q.id)).toEqual(["coordinates"]);
    // With a place name the building is placed approximately; without one nothing can be priced.
    expect(noPoint[0].why).toMatch(/placed at the centre of the named area/);
    expect(with_({ lat: unsaid(), lon: unsaid() }, { placeName: unsaid() })[0].why).toMatch(/without it nothing can be priced/);

    // Floor area and cost per m² stand in for a missing insured value.
    expect(with_({ tivKes: unsaid() }).map((q) => q.id)).toEqual(["tivKes"]);
    expect(with_({ tivKes: unsaid(), floorAreaM2: stated(12_000), costPerM2Kes: stated(110_000) })).toEqual([]);
    expect(with_({ housingClass: unsaid() }).map((q) => q.id)).toEqual(["housingClass"]);

    // A deductible stated as an amount alone is a deductible; neither part stated is a question.
    expect(with_({}, { floodDeductiblePct: unsaid() })).toEqual([]);
    expect(with_({}, { floodDeductiblePct: unsaid(), floodDeductibleMinKes: unsaid() }).map((q) => q.id)).toEqual(["floodDeductible"]);
    expect(with_({}, { floodLimitKes: unsaid() }).map((q) => q.id)).toEqual(["floodLimitKes"]);

    // Several buildings are asked about together.
    const two = brokerQuestions({ ...located, rows: [row(), row({ lat: unsaid(), lon: unsaid() })] });
    expect(two[0].question).toBe("What are the GPS coordinates of each insured building?");
  });

  it("follows what the rules read from a document, end to end", () => {
    const text = `CLIENT: Mwangaza Court Limited
GPS COORDINATES: 1.2700°S, 36.8100°E
CONSTRUCTION CLASSIFICATION: Reinforced concrete frame
Storeys: 14 above ground and 3 basement levels
TOTAL SUM INSURED: KES 4,000,000,000
The storm drains are designed for a 1-in-10 year storm.
Flood cover is requested, with a flood deductible of 5% of each loss, minimum KES 2,000,000.
The flood limit asked for is KES 900,000,000 any one event.
Business interruption is excluded.`;
    const asked = ids(verifyExtraction(extractByRules(text), text));
    // The drain design and the cover are stated, so neither is asked; with the cover excluded the rent is not asked either.
    expect(asked).toEqual(["valueBelowGroundKes", "floodBarriers", "nonReturnValves", "sumpPumpCapacity", "sumpPumpBackup", "basementDepthM", "equipmentBelowGround", "occupancy", "valueSplit", "premiumKes"]);

    // A description with none of it asks for all of it, after what stops any price.
    const shop = "two-storey masonry shop in Kibera worth KES 8 million";
    expect(ids(verifyExtraction(extractByRules(shop, ["Kibera"]), shop))).toEqual(["coordinates", "floodDeductible", "floodLimitKes", "basements", ...DRIVER_QUESTIONS]);
  });
});
