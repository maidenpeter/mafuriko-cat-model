import type { HousingClass } from "../model/types";
import { inKenya, parseCoordinates } from "./coords";
import { emptyRow, emptyTerms, NOTE_LABELS, statedValue, unreadValue } from "./extraction";
import { MONEY_SCALES as SCALES } from "./shared";
import type { DeductibleBasis, ExtractByRules, FloodCover, NoteKind, Occupancy, OfferNote } from "./types";

/**
 * Reading an offer with fixed rules and no model: what is used when no key is set or the
 * call fails. The rules look for labelled lines and for a handful of plain phrases, and keep
 * the line or sentence each value came from, so the same checks run on them as on the model's
 * reply. They read one building per document. A memo that describes several gets one row,
 * and the underwriter adds the rest.
 *
 * The rules never guess: a field they cannot find is left missing.
 */

// ---------------------------------------------------------------------------------------------
// The text as lines and sentences
// ---------------------------------------------------------------------------------------------

interface Line {
  /** The whole line, trimmed. This is what a value's quote is. */
  text: string;
  /** The words before the first colon, without a leading bullet. null when the line has no label. */
  label: string | null;
  /** What follows the label. "" when the line has none or the label stands alone. */
  value: string;
  /** The nearest label above that stood alone on its line: the section this line sits in. */
  heading: string;
}

function linesOf(documentText: string): Line[] {
  const lines: Line[] = [];
  let heading = "";
  for (const raw of documentText.split(/\r?\n/)) {
    const text = raw.trim();
    if (!text) {
      // A blank line closes the section.
      heading = "";
      continue;
    }
    const m =/^(?:[-•*▪●◦]\s*)?([A-Za-z][^:]{1,60}):\s*(.*)$/.exec(text);
    const label = m ? m[1].trim() : null;
    const value = m ? m[2].trim() : "";
    lines.push({ text, label, value, heading });
    if (label && !value) heading = label;
  }
  return lines;
}

/** A dot after one of these does not end a sentence. */
const ABBREVIATION = /(?:^|[\s(])(?:approx|min|max|est|incl|excl|no|ref|vs|ca|c|st|rd|ltd|co|inc|e\.g|i\.e)\.$/i;

/**
 * The text as sentences. Memos are hard-wrapped, so a line that does not end a sentence is
 * joined to a following line that starts in lower case. A blank line always ends a sentence.
 * Each sentence is still found in the document once line breaks count as spaces.
 */
function sentencesOf(documentText: string): string[] {
  const blocks: string[] = [];
  let open = false;
  for (const raw of documentText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      open = false;
      continue;
    }
    if (open && !/[.:;!?]$/.test(blocks[blocks.length - 1]) && /^[a-z]/.test(line)) blocks[blocks.length - 1] += ` ${line}`;
    else blocks.push(line);
    open = true;
  }
  const sentences: string[] = [];
  for (const block of blocks) {
    let start = 0;
    const ends = /[.!?]\s+(?=["'(\[]?[A-Z])/g;
    for (let m = ends.exec(block); m; m = ends.exec(block)) {
      const sentence = block.slice(start, m.index + 1);
      if (ABBREVIATION.test(sentence)) continue;
      sentences.push(sentence.trim());
      start = m.index + m[0].length;
    }
    if (block.slice(start).trim()) sentences.push(block.slice(start).trim());
  }
  return sentences;
}

/** Lines whose label, taken whole, matches. Only those with something after the colon. */
const labelled = (lines: Line[], label: RegExp) => lines.filter((l) => l.label !== null && l.value && label.test(l.label));

// ---------------------------------------------------------------------------------------------
// Amounts and words
// ---------------------------------------------------------------------------------------------

const DIGITS = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const SCALE = String.raw`(?:\s*(billion|million|thousand|bn|mn|m|b|k)\b)?`;
/** "KES 4,250,000,000", "KES 8 million", "KSh 12.5M". The scale letter must end a word, so "KES 2,500,000 minimum" is not millions. */
const KES_AMOUNT = String.raw`(?:KES|KSHS?)\.?\s*${DIGITS}${SCALE}`;

interface Amount {
  kes: number;
  /** Where it starts and ends in the text searched. */
  index: number;
  end: number;
}

const toNumber = (digits: string, scale?: string) => {
  const n = Number(digits.replace(/,/g, ""));
  // Rounded so that 12.35 million is 12350000 and not a hair above it.
  return scale ? Math.round(n * SCALES[scale.toLowerCase()]) : n;
};

/** Every KES amount in the text, in order. */
function amountsIn(text: string): Amount[] {
  const found: Amount[] = [];
  const pattern = new RegExp(KES_AMOUNT, "gi");
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) found.push({ kes: toNumber(m[1], m[2]), index: m.index, end: m.index + m[0].length });
  return found;
}

/** The first amount that starts after the word, else the last one before it. */
function amountBeside(text: string, word: RegExp): Amount | null {
  const at = word.exec(text);
  if (!at) return null;
  const amounts = amountsIn(text);
  return amounts.find((a) => a.index >= at.index) ?? amounts.filter((a) => a.end <= at.index).pop() ?? null;
}

/**
 * Construction wording to the four starter-kit classes. Order matters: a reinforced concrete
 * frame with masonry infill is concrete, and masonry walls under an iron sheet roof are masonry.
 */
const CLASS_WORDS: [HousingClass, RegExp][] = [
  ["concrete_rcc", /\b(?:concrete_rcc|r\.?c\.?c|reinforced[\s-]+concrete|concrete[\s-]+frame[ds]?|r\.?c\.?\s+frame[ds]?)\b/i],
  ["permanent_masonry", /\b(?:permanent_masonry|masonry|stone|bricks?|brickwork|blockwork|(?:concrete|cement|hollow)\s+blocks?)\b/i],
  ["semi_permanent", /\b(?:semi[\s_-]*permanent|timber|wood(?:en)?|mud|wattle|mixed\s+(?:construction|materials?))\b/i],
  ["informal_iron_sheet", /\b(?:informal_iron_sheet|(?:corrugated\s+)?iron[\s-]+sheets?|mabati|tin\s+sheets?|shack|informal)\b/i],
];
const classOf = (text: string): HousingClass | null => CLASS_WORDS.find(([, words]) => words.test(text))?.[0] ?? null;

const INDUSTRIAL = /\b(?:industrial|factory|manufactur\w*|mill(?:s|ing)?|processing|warehouse|godown|silos?|workshop|plant)\b/i;
const COMMERCIAL = /\b(?:commercial|offices?|retail|shops?|stores?|mall|hotel|bank|restaurant|supermarket|kiosk)\b/i;
const RESIDENTIAL = /\b(?:residential|apartments?|flats?|dwellings?|houses?|homes?|maisonettes?|bungalows?)\b/i;

function occupancyOf(text: string): Occupancy | null {
  const residential = RESIDENTIAL.test(text);
  const business = COMMERCIAL.test(text) || INDUSTRIAL.test(text);
  if (/\bmixed[\s-]+use\b/i.test(text) || (residential && business)) return "mixed";
  if (INDUSTRIAL.test(text)) return "industrial";
  if (COMMERCIAL.test(text)) return "commercial";
  return residential ? "residential" : null;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, single: 1, two: 2, double: 2, three: 3, triple: 3, four: 4, five: 5, six: 6 };
const COUNT = String.raw`(\d{1,2}|one|two|three|four|five|six|single|double|triple)`;
const countOf = (written: string) => NUMBER_WORDS[written.toLowerCase()] ?? Number(written);

/** A statement that something did not happen, or is not there, is never read as the thing itself. */
const NEGATED = /\b(?:no|none|nil|never|not|without|zero)\b/i;

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

const LABELS = {
  coordinates: /^(?:GPS(?:\s+CO-?ORDINATES?)?|(?:SITE\s+|LOCATION\s+|GEO(?:GRAPHIC)?\s+)?CO-?ORDINATES?|LAT(?:ITUDE)?\s*(?:\/|,|AND|&)\s*LONG?(?:ITUDE)?)$/i,
  floorArea: /^(?:(?:GROSS|TOTAL)\s+FLOOR\s+AREA\b.*|GFA|FLOOR\s+AREA|(?:GROSS|TOTAL)\s+BUILT[\s-]+UP\s+AREA)$/i,
  classification: /^(?:CONSTRUCTION\s+(?:CLASSIFICATION|CLASS|TYPE)\b.*|TYPE\s+OF\s+CONSTRUCTION|BUILDING\s+CLASS|STRUCTURE\s+TYPE)$/i,
  construction: /^CONSTRUCTION$/i,
  insuredValue: /^(?:(?:TOTAL\s+)?(?:INSURED|INSURABLE)\s+VALUES?\b.*|(?:TOTAL\s+)?SUMS?\s+INSURED\b.*|(?:TOTAL\s+)?TIV\b.*|TOTAL\s+DECLARED\s+VALUES?)$/i,
  name: /^(?:CLIENT|INSURED|NAME\s+OF\s+(?:THE\s+)?INSURED|INSURED\s+NAME|PROPERTY(?:\s+NAME)?|RISK\s+NAME|BUILDING(?:\s+NAME)?)$/i,
  address: /^(?:(?:STREET|SITE|PHYSICAL|FACILITY|PROPERTY|RISK)\s+ADDRESS|ADDRESS|LOCATION|SITUATION|SITE|AREA|ESTATE|WARD|NEIGHBOURHOOD)$/i,
  occupancy: /^(?:OCCUPANCY(?:\s+TYPE)?|TYPE\s+OF\s+OCCUPANCY|CLASS\s+OF\s+BUSINESS|PRINCIPAL\s+ACTIVITY|BUSINESS\s+ACTIVITY|NATURE\s+OF\s+BUSINESS|(?:BUILDING\s+)?USE)$/i,
  period: /^(?:TERM|POLICY\s+(?:PERIOD|TERM)|PERIOD(?:\s+OF\s+(?:INSURANCE|COVER))?|(?:INSURANCE|COVER)\s+PERIOD)$/i,
  floodView: /^(?:(?:OVERALL\s+)?FLOOD\s+RISK(?:\s+(?:RATING|PROFILE|ASSESSMENT|GRADE|OPINION))?|BROKER(?:'S)?\s+(?:VIEW|OPINION|COMMENTS?|ASSESSMENT))$/i,
  generalView: /^(?:OVERALL\s+RISK\s+(?:PROFILE|RATING)|RECOMMENDATION)$/i,
};

const AREA_UNIT = String.raw`(?:m²|m2\b|sqm\b|sq\.?\s*m\b|square\s+met(?:re|er)s?\b)`;
const PLANT = /\b(?:generators?|gensets?|switchgear|switch\s?rooms?|transformers?|pumps?|plant\s?rooms?|electrical|UPS|servers?|chillers?|boilers?|lift\s+motors?|control\s+panels?|BMS|substation|fuel\s+tanks?|data\s+cent(?:re|er))\b/i;
const DRAIN_STATE = /\b(?:condition|blocked|silt(?:ed|ing)?|clogged|maintained|maintenance|clean(?:ed|ing)?|cleared|capacity|inadequate|adequate|poor|good|overflow\w*|back(?:s|ed|ing)?\s+up|insufficient|sufficient|undersized)\b/i;
const RIVER_NAME = String.raw`((?:[A-Z][A-Za-z'’-]+\s+){1,3}River|River\s+[A-Z][A-Za-z'’-]+)`;
const DISTANCE = String.raw`(\d+(?:\.\d+)?)\s*(km|kilomet(?:re|er)s?|m|met(?:re|er)s?)\b`;
/** Capitalised words that sit in front of a river's name without being part of it. */
const NOT_A_RIVER_NAME = /^(?:(?:The|Nearest|Closest|Distance|Adjacent|Near|To|From|Of|Along|And)\s+)+/;

/** How many notes of one kind the rules keep. A long memo repeats itself. */
const MOST_NOTES: Record<NoteKind, number> = { basement_plant: 4, past_flood: 8, drainage_condition: 3, broker_view: 2 };

export const extractByRules: ExtractByRules = (documentText, knownPlaces = []) => {
  const lines = linesOf(documentText);
  const sentences = sentencesOf(documentText);
  // A few typed lines are read more freely than a memo, where a stray word is not a statement about the risk.
  const typed = lines.length <= 6 && documentText.length <= 800;

  const row = emptyRow("rules");
  const terms = emptyTerms();

  // --- Coordinates: the labelled line only. A memo also gives positions for plant and landmarks.
  const gps = labelled(lines, LABELS.coordinates);
  const located = gps.find((l) => parseCoordinates(l.text));
  if (located) {
    const reading = parseCoordinates(located.text)!;
    row.lat = statedValue(reading.lat, located.text);
    row.lon = statedValue(reading.lon, located.text);
  } else if (gps.length) {
    row.lat = unreadValue(gps[0].text, "The coordinates on this line could not be read.");
    row.lon = unreadValue(gps[0].text, "The coordinates on this line could not be read.");
  } else if (typed) {
    for (const sentence of sentences) {
      const reading = parseCoordinates(sentence);
      // Two bare numbers in a typed sentence are taken as a position only when they fall in Kenya or are written as one.
      if (!reading || !(inKenya(reading.lat, reading.lon) || /°|\b(?:gps|co-?ordinates?|lat(?:itude)?)\b/i.test(sentence))) continue;
      row.lat = statedValue(reading.lat, sentence);
      row.lon = statedValue(reading.lon, sentence);
      break;
    }
  }

  // --- Name
  const named = labelled(lines, LABELS.name)[0];
  if (named) row.name = statedValue(named.value, named.text);

  // --- Floor area
  const areaPattern = new RegExp(`${DIGITS}\\s*${AREA_UNIT}`, "i");
  const areaLine = labelled(lines, LABELS.floorArea).find((l) => areaPattern.test(l.value));
  if (areaLine) row.floorAreaM2 = statedValue(toNumber(areaPattern.exec(areaLine.value)![1]), areaLine.text);
  else if (typed) {
    const sentence = sentences.find((s) => areaPattern.test(s));
    if (sentence) row.floorAreaM2 = statedValue(toNumber(areaPattern.exec(sentence)![1]), sentence);
  }

  // --- Cost per m²: an amount "per m²", and in a memo only where the sentence is about the cost of building.
  const perM2 = new RegExp(`${KES_AMOUNT}\\s*(?:per|\\/|a|each)\\s*${AREA_UNIT}`, "i");
  const costSentence = sentences.find((s) => perM2.test(s) && (typed || /\b(?:rebuild\w*|reinstatement|replacement|construction\s+cost|building\s+cost|cost\s+per|value\s+per)\b/i.test(s)));
  if (costSentence) {
    const m = perM2.exec(costSentence)!;
    row.costPerM2Kes = statedValue(toNumber(m[1], m[2]), costSentence);
  }

  // --- Housing class: the classification line, else a lone "Construction:" line, else the wording of a typed sentence.
  const plainConstruction = labelled(lines, LABELS.construction);
  const classLine =
    labelled(lines, LABELS.classification).find((l) => classOf(l.value)) ??
    // Several "Construction:" lines mean several buildings, and the rules cannot tell which is which.
    (plainConstruction.length === 1 && classOf(plainConstruction[0].value) ? plainConstruction[0] : undefined);
  if (classLine) row.housingClass = statedValue(classOf(classLine.value)!, classLine.text);
  else if (typed && plainConstruction.length < 2) {
    const sentence = sentences.find((s) => classOf(s));
    if (sentence) row.housingClass = statedValue(classOf(sentence)!, sentence);
  }

  // --- Insured value: a labelled line, else an amount straight after "TIV" or "sum insured", else "worth KES ..." when typed.
  const valueLine = labelled(lines, LABELS.insuredValue).find((l) => amountsIn(l.value).length);
  const afterTiv = new RegExp(String.raw`\b(?:TIV|total\s+insured\s+value|(?:total\s+)?sum\s+insured|insured\s+value)\b\s*(?:of|is|at|:|=)?\s*\(?\s*${KES_AMOUNT}`, "i");
  const worth = new RegExp(String.raw`\b(?:worth|valued\s+at|value\s+of|insured\s+for|sum\s+insured\s+of)\s+(?:(?:about|approximately|approx\.?|roughly|around|some)\s+)?${KES_AMOUNT}`, "i");
  if (valueLine) row.tivKes = statedValue(amountsIn(valueLine.value)[0].kes, valueLine.text);
  else {
    for (const sentence of sentences) {
      const m = afterTiv.exec(sentence) ?? (typed ? worth.exec(sentence) : null);
      if (!m) continue;
      // "50% of TIV (KES ...)" may be giving the share, not the whole value.
      const share = /(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:the\s+)?$/.exec(sentence.slice(0, m.index));
      if (share && Number(share[1]) !== 100) continue;
      row.tivKes = statedValue(toNumber(m[1], m[2]), sentence);
      break;
    }
    if (row.tivKes.value === null && typed) {
      // One amount in a typed description, with nothing saying it is anything else, is the value.
      const plain = sentences.flatMap((s) => (/\b(?:deductible|excess|limit)\b/i.test(s) || perM2.test(s) ? [] : amountsIn(s).map((a) => ({ a, s }))));
      if (plain.length === 1) row.tivKes = statedValue(plain[0].a.kes, plain[0].s);
    }
  }

  // --- Basements: a count in figures first, since a figure can be checked against its quote.
  const basementFigures = [
    new RegExp(String.raw`\b(\d{1,2})\s*\(\s*basements?\s*\)`, "i"),
    new RegExp(String.raw`\b(\d{1,2})[\s-]+(?:levels?|floors?|storeys?)\s+(?:of\s+)?basements?\b`, "i"),
    new RegExp(String.raw`\b(\d{1,2})[\s-]+basements?\s+(?:\w+\s+)?(?:levels?|floors?|storeys?)\b`, "i"),
    new RegExp(String.raw`\b(\d{1,2})\s+basements\b`, "i"),
  ];
  const basementWords = [
    new RegExp(String.raw`\b${COUNT}[\s-]+(?:levels?|floors?|storeys?)\s+(?:of\s+)?basements?\b`, "i"),
    new RegExp(String.raw`\b${COUNT}[\s-]+basements?\s+(?:\w+\s+)?(?:levels?|floors?|storeys?)\b`, "i"),
    new RegExp(String.raw`\b${COUNT}\s+basements\b`, "i"),
  ];
  const noBasement = /\b(?:no|without(?:\s+a)?|nil)\s+basements?\b(?!\s+(?:flood|water|plant|leak|damage|seepage|ingress|pump))/i;
  for (const pattern of [...basementFigures, ...basementWords]) {
    const line = lines.find((l) => pattern.test(l.text));
    if (!line) continue;
    terms.basements = statedValue(countOf(pattern.exec(line.text)![1]), line.text);
    break;
  }
  if (terms.basements.value === null) {
    const line = lines.find((l) => noBasement.test(l.text));
    if (line) terms.basements = statedValue(0, line.text);
  }

  // --- Occupancy
  const used = labelled(lines, LABELS.occupancy).find((l) => occupancyOf(l.value));
  if (used) terms.occupancy = statedValue(occupancyOf(used.value)!, used.text);
  else if (typed) {
    const sentence = sentences.find((s) => occupancyOf(s));
    if (sentence) terms.occupancy = statedValue(occupancyOf(sentence)!, sentence);
  }

  // --- Flood deductible: the first sentence that names a deductible with a figure, one about flood before any other.
  const deductibleWord = /\b(?:deductibles?|excess)\b/i;
  const withDeductible = sentences.filter((s) => deductibleWord.test(s) && !/\b(?:in\s+excess\s+of|excess\s+of\s+loss)\b/i.test(s) && (/\d\s*%/.test(s) || amountsIn(s).length > 0));
  const deductible = withDeductible.find((s) => /\bflood/i.test(s)) ?? withDeductible[0];
  if (deductible) {
    const at = deductibleWord.exec(deductible)!.index;
    // A percentage counts only when it stands close to the word, on either side.
    const percents: { pct: number; index: number }[] = [];
    const percent = /(\d+(?:\.\d+)?)\s*%/g;
    for (let m = percent.exec(deductible); m; m = percent.exec(deductible)) percents.push({ pct: Number(m[1]), index: m.index });
    const pct = percents.find((p) => Math.abs(p.index - at) <= 60);
    if (pct) terms.floodDeductiblePct = statedValue(pct.pct, deductible);
    const minimum = new RegExp(String.raw`${KES_AMOUNT}\s*(?:minimum|min\b)|\bminimum\s+(?:of\s+)?${KES_AMOUNT}`, "i").exec(deductible);
    const amount = minimum ? toNumber(minimum[1] ?? minimum[3], minimum[2] ?? minimum[4]) : amountBeside(deductible, deductibleWord)?.kes;
    if (amount !== undefined) terms.floodDeductibleMinKes = statedValue(amount, deductible);
    const basis: DeductibleBasis | null = /%\s*of\s+(?:the\s+)?(?:total\s+)?(?:sum\s+insured|TIV|TSI|insured\s+value)/i.test(deductible)
      ? "percent_of_sum_insured"
      : /%\s*of\s+(?:each(?:\s+and\s+every)?|the|any(?:\s+one)?|every)\s+(?:flood\s+)?(?:loss|claim)/i.test(deductible)
        ? "percent_of_loss"
        : null;
    if (basis && pct) terms.floodDeductibleBasis = statedValue(basis, deductible);
  }

  // --- Flood limit: an amount after the word "limit", in a sentence about flood. A typed line need not say flood twice.
  const limitWord = /\b(?:sub-?\s?)?limit\b/i;
  for (const sentence of sentences) {
    if (!limitWord.test(sentence) || !(typed || /\bflood/i.test(sentence))) continue;
    const at = limitWord.exec(sentence)!.index;
    const amount = amountsIn(sentence).find((a) => a.index >= at);
    if (!amount) continue;
    // "Limit of 50% of the insured value (KES ...)" gives the value, not the limit.
    const between = sentence.slice(at, amount.index);
    const share = /(\d+(?:\.\d+)?)\s*%/.exec(between);
    if ((share && Number(share[1]) !== 100) || /\b(?:half|third|quarter|percent|per\s+cent)\b/i.test(between)) continue;
    terms.floodLimitKes = statedValue(amount.kes, sentence);
    break;
  }

  // --- Policy period
  // A memo often gives the period of the policy now in force as well. The terms asked for come last.
  const periods = labelled(lines, LABELS.period);
  const term = periods.filter((l) => !/\b(?:current|expiring|existing|previous|prior)\b/i.test(l.heading)).pop() ?? periods[0];
  if (term) terms.policyPeriod = statedValue(term.value, term.text);
  else {
    const DATE = String.raw`\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+\s+\d{4}`;
    const range = new RegExp(String.raw`\b(?:period|term|cover(?:age)?|policy)\b[^.]{0,40}?\b(${DATE}\s*(?:to|until|through|-)\s*${DATE})`, "i");
    const sentence = sentences.find((s) => range.test(s));
    if (sentence) terms.policyPeriod = statedValue(range.exec(sentence)![1], sentence);
  }

  // --- Flood cover: a request for it outranks a line that says the current policy leaves it out.
  const asked = [
    /\bflood\s+(?:cover(?:age)?|extension|insurance)\b[^.]{0,80}?\b(?:requested|sought|required|needed|to\s+be\s+(?:added|included|quoted))\b/i,
    /\b(?:request(?:s|ed|ing)?|seek(?:s|ing)?|sought|requir(?:es|ed|ing)|quot(?:e|ation)\s+for|add(?:ing)?|to\s+include|including|incl\.?|inclusive\s+of)\s+(?:\w+\s+){0,3}?flood\b/i,
  ];
  const left = [
    /\b(?:excluding|excludes?|excluded|excl\.?|exclusion\s+of|without|no)\s+(?:\w+\s+){0,2}?flood\b/i,
    /\bflood\b[^.]{0,30}\b(?:excluded|not\s+(?:covered|required|requested|insured))\b/i,
  ];
  // A request worded as a refusal ("flood cover is not requested") is not a request.
  const asksFor = (sentence: string) =>
    asked.some((pattern) => {
      const m = pattern.exec(sentence);
      return m !== null && !NEGATED.test(m[0]);
    });
  const coveredIn = sentences.find(asksFor);
  const excludedIn = coveredIn ? undefined : sentences.find((s) => left.some((pattern) => pattern.test(s)));
  if (coveredIn) terms.floodCover = statedValue<FloodCover>("covered", coveredIn);
  else if (excludedIn) terms.floodCover = statedValue<FloodCover>("excluded", excludedIn);

  // --- Place name: a known ward or flood area, on an address line of a memo or anywhere in a typed description.
  const places = [...knownPlaces].filter((p) => p.trim().length > 2).sort((a, b) => b.length - a.length);
  const placeIn = (text: string) => {
    for (const caseFree of [false, true]) {
      let best: { place: string; led: boolean } | null = null;
      for (const place of places) {
        const pattern = new RegExp(String.raw`(^|[^\w'’])${escapeForPattern(place.trim()).replace(/['’]/g, "['’]?")}(?![\w'’])`, caseFree ? "i" : "");
        const m = pattern.exec(text);
        if (!m) continue;
        // "in Kibera" is a firmer statement of where than a name that only appears somewhere.
        const led = /\b(?:in|at|near|of)\s+$/i.test(text.slice(0, m.index + m[1].length));
        // Names are tried longest first, so of two that are equally firm the longer one stays.
        // The name is kept as the document spells it, so it can be found again in its quote.
        if (!best || (led && !best.led)) best = { place: m[0].slice(m[1].length), led };
      }
      if (best) return best.place;
    }
    return null;
  };
  const placeLine = labelled(lines, LABELS.address).find((l) => placeIn(l.value));
  if (placeLine) terms.placeName = statedValue(placeIn(placeLine.value)!, placeLine.text);
  else if (typed) {
    const known = sentences.find((s) => placeIn(s));
    const written = /\b(?:in|at|near)\s+((?:[A-Z][\w'’-]+)(?:\s+[A-Z][\w'’-]+){0,2})/;
    const sentence = known ?? sentences.find((s) => written.test(s));
    if (known) terms.placeName = statedValue(placeIn(known)!, known);
    // With no list of places to go by, a capitalised name after "in" is offered for the locator to accept or refuse.
    else if (sentence) terms.placeName = statedValue(written.exec(sentence)![1], sentence);
  }

  // --- River: a named river with a distance on the same line, else just the first named river.
  const riverThenDistance = new RegExp(String.raw`${RIVER_NAME}([^\d\n]{0,60}?)${DISTANCE}(.{0,12})`);
  const distanceThenRiver = new RegExp(String.raw`${DISTANCE}\s+(?:[a-z-]+\s+){0,4}?(?:from|of|to)\s+(?:the\s+)?((?:[A-Z][A-Za-z'’-]+\s+){1,3}[Rr]iver|River\s+[A-Z][A-Za-z'’-]+)`);
  // A height of water beside a river's name is not how far away the river is.
  const WATER_LEVEL = /\b(?:level|peak\w*|depth|deep|rose|height|stage|gauge|bank|burst|overflow\w*|flood\w*|above|asl|high|wide)\b/i;
  const metres = (written: string, unit: string) => (/^k/i.test(unit) ? Math.round(Number(written) * 1000) : Number(written));
  const riverName = (written: string) => written.replace(NOT_A_RIVER_NAME, "").replace(/\s+/g, " ").trim();
  for (const line of lines) {
    const a = riverThenDistance.exec(line.text);
    const b = a ? null : distanceThenRiver.exec(line.text);
    if (a && (WATER_LEVEL.test(a[2]) || WATER_LEVEL.test(a[5]))) continue;
    const [name, distance, unit] = a ? [a[1], a[3], a[4]] : b ? [b[3], b[1], b[2]] : [];
    if (!name || !riverName(name)) continue;
    terms.riverName = statedValue(riverName(name), line.text);
    terms.riverDistanceM = statedValue(metres(distance!, unit!), line.text);
    break;
  }
  if (terms.riverName.value === null) {
    const named = new RegExp(RIVER_NAME);
    const line = lines.find((l) => named.test(l.text) && riverName(named.exec(l.text)![1]));
    if (line) terms.riverName = statedValue(riverName(named.exec(line.text)![1]), line.text);
  }

  // --- Notes
  const notes: OfferNote[] = [];
  const note = (kind: NoteKind, quote: string) => {
    if (notes.filter((n) => n.kind === kind).length >= MOST_NOTES[kind] || notes.some((n) => n.kind === kind && n.quote === quote)) return;
    notes.push({ kind, ...statedValue(NOTE_LABELS[kind], quote) });
  };

  const YEAR = String.raw`\b(?:19|20)\d{2}\b`;
  const FLOODED = String.raw`\b(?:flood(?:s|ed|ing)?|inundat(?:ed|ion)|water\s+damage)\b`;
  const pastFlood = [
    new RegExp(String.raw`^\W*FLOOD\s+EVENT\b.*${YEAR}`, "i"),
    new RegExp(String.raw`${YEAR}[^.]{0,20}${FLOODED}[^.]{0,40}(?:${KES_AMOUNT}|\b(?:loss(?:es)?|claims?|damage|event)\b)`, "i"),
    new RegExp(String.raw`${FLOODED}[^.]{0,60}\b(?:in|during|of|since)\s+(?:\w+\s+)?${YEAR}`, "i"),
    new RegExp(String.raw`\b(?:\d+|two|three|four|five|several|multiple|repeated)\s+(?:\w+\s+){0,2}?floods?\b[^.]{0,30}\b(?:in|over)\s+(?:the\s+)?(?:last\s+|past\s+)?\d+\s+years\b`, "i"),
    new RegExp(String.raw`\b(?:flood|water\s+damage|inundation)\s+(?:loss(?:es)?|claims?|damage)\b[^.]{0,40}${KES_AMOUNT}`, "i"),
    /\b(?:was|were|been|got)\s+flooded\b|\bflooded\s+(?:once|twice|before|\d+\s+times)\b/i,
  ];
  for (const line of lines) {
    // Only an event that happened is a note. "The site has never flooded" is not.
    if (pastFlood.some((p) => p.test(line.text)) && !NEGATED.test(line.text.slice(0, line.text.search(/flood|inundat|water\s+damage/i)))) note("past_flood", line.text);

    if (/\bbasements?\b/i.test(line.text) && !NEGATED.test(line.text) && (PLANT.test(line.text) || PLANT.test(line.heading))) note("basement_plant", line.text);

    const aboutDrains = /\bdrain/i.test(line.heading) ? line.label === null || line.value !== "" : /\bdrain/i.test(line.text);
    if (aboutDrains && DRAIN_STATE.test(line.text)) note("drainage_condition", line.text);

    if (line.label && line.value && (LABELS.floodView.test(line.label) || (LABELS.generalView.test(line.label) && /\bflood/i.test(line.value)))) note("broker_view", line.text);
  }

  return { rows: [row], terms, notes };
};
