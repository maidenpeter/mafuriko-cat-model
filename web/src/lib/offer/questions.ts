import { fmtNum } from "../format";
import { rpWithChance, shareText as share } from "../labels";
import { basementFact, statedValues } from "./drivers";
import { BASEMENT_LADDER, REFERENCE_JUDGEMENT } from "./judgement";
import type { BrokerAssumption, BrokerQuestion, BrokerQuestions, Quoted } from "./types";
import { usableValue } from "./verify";

/**
 * What to ask the broker. The loss drivers beyond flood depth (see judgement.ts) need facts a
 * placement memo often leaves out: how deep the basements are, what is kept in them, what storm
 * the drains are designed for, whether lost rent is insured. Where the document does not state
 * one, nothing is guessed: the price uses a marked assumption, and the value is listed here as a
 * question, with one sentence on why the answer matters.
 *
 * The questions come in a fixed order, the answer that could move the price most first:
 *   1. what stops any price at all       the position, the insured value, the construction class
 *   2. the terms                         the flood deductible and the flood limit
 *   3. what switches a loss driver       whether there are basements, the value below ground, the
 *      on or sets its size               drain design, business interruption cover, a year's rent
 *   4. what the assumptions are argued   barriers, non-return valves, the sump pumps, the depth of
 *      from                              the basements, the equipment below ground
 *   5. context                           what the building is used for, the split of the insured
 *                                        value (each part that is missing), the premium
 *
 * A value counts as stated when anything was read for it or typed into it, whether or not its
 * check has passed: an unverified value is the underwriter's to settle on screen, not the
 * broker's to supply again (with all loss drivers the price waits for it: see waitingValues).
 * Whether there is a basement is decided once, by basementFact in drivers.ts, so a question never
 * says a loss is left out while the driver prices it: questions about a basement are not asked of
 * a building the document says has none and places nothing below ground. A year's rent is not
 * asked for when business interruption is excluded.
 *
 * Each question also says what the model uses until it is answered (`assumes`): the judgement
 * figures that stand in and one plain sentence, or null where nothing is assumed. This is the one
 * place that pairs a question with its assumption; a screen shows it and keeps no mapping of its own.
 */

/** Every question that can be asked, in the order they are listed. */
export const BROKER_QUESTION_IDS = [
  "coordinates",
  "tivKes",
  "housingClass",
  "floodDeductible",
  "floodLimitKes",
  "basements",
  "valueBelowGroundKes",
  "drainDesignRp",
  "biCovered",
  "annualRentKes",
  "floodBarriers",
  "nonReturnValves",
  "sumpPumpCapacity",
  "sumpPumpBackup",
  "basementDepthM",
  "equipmentBelowGround",
  "occupancy",
  "valueSplit",
  "premiumKes",
] as const;
export type BrokerQuestionId = (typeof BROKER_QUESTION_IDS)[number];

/** Nothing was read for the value and nothing was typed. A value absent from terms built by hand is not stated either. */
const notStated = (quoted: Quoted<unknown> | undefined): boolean => quoted === undefined || quoted.status === "missing";

export const brokerQuestions: BrokerQuestions = (extraction, judgement = REFERENCE_JUDGEMENT) => {
  const { rows, terms } = extraction;
  const building = rows.length > 1 ? "each insured building" : "the insured building";
  const asked = new Map<BrokerQuestionId, Omit<BrokerQuestion, "id">>();
  const ask = (id: BrokerQuestionId, question: string, why: string, assumes: BrokerAssumption | null = null) => asked.set(id, { question, why, assumes });
  /** A judgement figure, or several, stands in. */
  const figure = (text: string, ...keys: BrokerAssumption["keys"]): BrokerAssumption => ({ keys, text });
  /** An assumption kept elsewhere stands in: the example terms, the centre of a named area. */
  const elsewhere = (text: string): BrokerAssumption => ({ keys: [], text });

  // --- What stops any price at all
  if (rows.some((row) => notStated(row.lat) || notStated(row.lon))) {
    ask(
      "coordinates",
      `What are the GPS coordinates of ${building}?`,
      notStated(terms.placeName)
        ? "Flood depth is read from the hazard maps at the building's position, so without it nothing can be priced."
        : "Until its position is given the building is placed at the centre of the named area, and flood depth changes within a few hundred metres.",
      notStated(terms.placeName) ? null : elsewhere("The centre of the named area stands in for the building's position."),
    );
  }
  if (rows.some((row) => notStated(row.tivKes) && (notStated(row.floorAreaM2) || notStated(row.costPerM2Kes)))) {
    ask("tivKes", `What is the total insured value of ${building}, in KES?`, "Every loss is a share of the insured value, so without it no loss can be worked out.");
  }
  if (rows.some((row) => notStated(row.housingClass))) {
    ask(
      "housingClass",
      `How is ${building} constructed: a reinforced concrete frame, stone or block masonry, timber or mixed materials, or iron sheet?`,
      "The damage curve is chosen by the construction class, so without it no loss can be worked out.",
    );
  }

  // --- The terms
  if (notStated(terms.floodDeductiblePct) && notStated(terms.floodDeductibleMinKes)) {
    ask(
      "floodDeductible",
      "What flood deductible is asked for: the percentage of each loss, and the minimum amount in KES?",
      "The example deductible is used until the offer states one, and the deductible decides how much of each flood loss the policy pays.",
      elsewhere("The example deductible of the Insurance terms panel."),
    );
  }
  if (notStated(terms.floodLimitKes)) {
    ask(
      "floodLimitKes",
      "What is the most the policy is to pay for one flood, in KES?",
      "The example limit is used until the offer states one, and the limit caps what is paid in the rarest floods.",
      elsewhere("The example limit of the Insurance terms panel."),
    );
  }

  // --- What switches a loss driver on, or sets its size
  // One reading of whether there is a basement, the same one the Basement ingress driver uses. A building
  // the document says has none, and places nothing below ground in, is asked nothing about one.
  const basement = basementFact(statedValues(extraction));
  const noBasement = basement.present === false;
  // What stands in for the things a basement question asks about.
  const belowGroundAssumed = figure(`${share(judgement.belowGroundShare)} of the insured value is taken to be below ground.`, "belowGroundShare");
  const thresholdAssumed = figure(`A basement is taken to flood once surface water at the site reaches ${fmtNum(judgement.ingressThresholdM, 2)} m.`, "ingressThresholdM");
  const ladderAssumed = figure(
    `A flooded basement is taken to lose ${BASEMENT_LADDER.map((key) => share(judgement[key])).join(", ")} of the value below ground, from the most frequent flood modelled to the rarest.`,
    ...BASEMENT_LADDER,
  );
  if (notStated(terms.basements)) {
    if (basement.present === true) {
      // The document places something below ground, so the driver is already on: only the count is missing.
      ask(
        "basements",
        "How many basement levels does the building have?",
        "Basement ingress is already priced from what the document places below ground. The number of levels shows how much of the building water can reach.",
        elsewhere("Basement ingress is priced: the document places equipment, plant or value below ground."),
      );
    } else {
      ask("basements", "How many basement levels does the building have?", "Basement ingress is priced only for a building that has basements, so the answer decides whether that loss is counted at all.");
    }
  }
  if (!noBasement && notStated(terms.valueBelowGroundKes)) {
    ask(
      "valueBelowGroundKes",
      "What is the insured value of the machinery and contents kept in the basements or below ground, in KES?",
      `The model assumes ${share(judgement.belowGroundShare)} of the insured value until told otherwise, and the loss from basement ingress is a share of that figure.`,
      belowGroundAssumed,
    );
  }
  if (notStated(terms.drainDesignRp)) {
    ask(
      "drainDesignRp",
      "What is the design return period of the site's storm drains?",
      `The model assumes ${rpWithChance(judgement.drainDesignRp)} until told otherwise, and that decides from which flood the site is treated as wet.`,
      figure(`The drains are taken as designed for a ${rpWithChance(judgement.drainDesignRp)} event.`, "drainDesignRp"),
    );
  }
  if (notStated(terms.biCovered)) {
    ask("biCovered", "Is business interruption or loss of rent to be insured for flood?", "Lost rent or revenue is priced only when the offer says it is covered, so until then it is left out of the price.");
  }
  if (usableValue(terms.biCovered) !== "excluded" && notStated(terms.annualRentKes)) {
    ask(
      "annualRentKes",
      "What is the building's rent or revenue for one year, in KES?",
      `When business interruption is covered, the model assumes a year's rent of ${share(judgement.annualRentShare)} of the insured value until told otherwise.`,
      figure(`A year's rent or revenue of ${share(judgement.annualRentShare)} of the insured value, used only when business interruption is covered.`, "annualRentShare"),
    );
  }

  // --- What the assumptions are argued from
  if (!noBasement) {
    if (notStated(terms.floodBarriers)) {
      ask("floodBarriers", "Are flood barriers or flood gates fitted at the basement ramps and other openings?", "Barriers raise the surface water it takes before a basement floods, which is what the ingress threshold is set from.", thresholdAssumed);
    }
    if (notStated(terms.nonReturnValves)) {
      ask("nonReturnValves", "Are non-return valves fitted on the drains that serve the basements?", "Without them, overloaded drains can push water back into a basement while the street outside is still dry.", thresholdAssumed);
    }
    if (notStated(terms.sumpPumpCapacity)) {
      ask("sumpPumpCapacity", "What is the capacity of the basement sump pumps?", "Pumps that keep up with the water limit the damage in a basement, which is what the basement damage ratios are set from.", ladderAssumed);
    }
    if (notStated(terms.sumpPumpBackup)) {
      ask("sumpPumpBackup", "Do the sump pumps have backup power?", "Pumps without backup power stop when the mains fail in a storm, which is when a basement floods.", ladderAssumed);
    }
    if (notStated(terms.basementDepthM)) {
      ask("basementDepthM", "How far is the lowest basement floor below ground level, in metres?", "A deeper basement holds more water and takes longer to pump out, which is what the basement damage ratios are set from.", ladderAssumed);
    }
    if (!(extraction.equipmentBelowGround ?? []).some(({ item }) => !notStated(item))) {
      ask(
        "equipmentBelowGround",
        "Which equipment is kept in the basements or below ground: generators, switchgear, pumps, tanks, lift motors, server rooms?",
        "Equipment below ground is the first thing a flooded basement damages, and it is what the value below ground is made of.",
        // The assumed share stands in only while the value below ground is not usable itself.
        usableValue(terms.valueBelowGroundKes ?? { value: null, quote: "", status: "missing", reason: null }) === null ? belowGroundAssumed : null,
      );
    }
  }

  // --- Context
  if (notStated(terms.occupancy)) {
    ask(
      "occupancy",
      "What is the building used for: homes, offices or shops, industry, or a mix?",
      "The damage curve was built for homes, so the use shows how far it fits this building. It does not change the modelled price.",
    );
  }
  // Each part of the split that is missing is asked for, by name: a part the document states is not asked for again.
  const missingParts = [
    notStated(terms.valueBuildingKes) && "the building",
    notStated(terms.valueMachineryKes) && "its plant and machinery",
    notStated(terms.valueContentsKes) && "its contents",
  ].filter((part): part is string => typeof part === "string");
  if (missingParts.length > 0) {
    const listed = missingParts.length === 3 ? `${missingParts[0]}, ${missingParts[1]}, and ${missingParts[2]}` : missingParts.join(" and ");
    ask(
      "valueSplit",
      missingParts.length === 3 ? `How is the insured value split between ${listed}, in KES?` : `How much of the insured value is for ${listed}, in KES?`,
      "The split shows how much of the value water can reach, and whether the building is insured for less than it would cost to rebuild.",
    );
  }
  if (notStated(terms.premiumKes)) {
    ask("premiumKes", "What is the policy's current annual premium for all risks, in KES?", "It does not change the modelled price: it is shown beside the modelled flood rate so the two can be compared.");
  }

  return BROKER_QUESTION_IDS.flatMap((id) => {
    const question = asked.get(id);
    return question ? [{ id, ...question }] : [];
  });
};
