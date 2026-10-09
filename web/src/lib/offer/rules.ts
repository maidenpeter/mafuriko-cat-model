import type { HousingClass } from "../model/types";
import { inKenya, parseCoordinates } from "./coords";
import { emptyRow, emptyTerms, missingValue, NOTE_LABELS, statedValue, uniqueEquipment, uniqueLosses, unreadValue } from "./extraction";
import { MONEY_SCALES as SCALES } from "./shared";
import type { BiCover, DeductibleBasis, EquipmentItem, ExtractByRules, FloodCover, FloodLoss, NoteKind, Occupancy, OfferNote, Presence, Quoted, YesNo } from "./types";

/**
 * Reading an offer with fixed rules and no model: what is used when no key is set or the
 * call fails. The rules look for labelled lines and for a handful of plain phrases, and keep
 * the line or sentence each value came from, so the same checks run on them as on the model's
 * reply. They read one building per document. A memo that describes several gets one row,
 * and the underwriter adds the rest. They also read the document's own flood loss history:
 * the years it covers and each flood or water damage loss in it, never a fire or a theft.
 * And they read what the loss drivers beyond flood depth need, where the document states it
 * in a regular way: the depth of the basements, the equipment kept below ground, the storm
 * the drains are designed for, the sump pumps, flood barriers and non-return valves, the
 * split of the insured value, a year's rent, business interruption cover and the premium.
 *
 * The rules never guess: a field they cannot find is left missing, and so is one that two
 * statements give differently. Nothing is added up, multiplied or worked out.
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
  /** True when a blank line, or the start of the text, comes straight before it. */
  first: boolean;
}

function linesOf(documentText: string): Line[] {
  const lines: Line[] = [];
  let heading = "";
  let first = true;
  for (const raw of documentText.split(/\r?\n/)) {
    const text = raw.trim();
    if (!text) {
      // A blank line closes the section.
      heading = "";
      first = true;
      continue;
    }
    const m =/^(?:[-•*▪●◦]\s*)?([A-Za-z][^:]{1,60}):\s*(.*)$/.exec(text);
    const label = m ? m[1].trim() : null;
    const value = m ? m[2].trim() : "";
    lines.push({ text, label, value, heading, first });
    first = false;
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
  return blocks.flatMap(sentencesIn);
}

/** One block of text, already on one line, as its sentences. */
function sentencesIn(block: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const ends = /[.!?]\s+(?=["'(\[]?[A-Z])/g;
  for (let m = ends.exec(block); m; m = ends.exec(block)) {
    const sentence = block.slice(start, m.index + 1);
    if (ABBREVIATION.test(sentence)) continue;
    sentences.push(sentence.trim());
    start = m.index + m[0].length;
  }
  if (block.slice(start).trim()) sentences.push(block.slice(start).trim());
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
// The loss history
// ---------------------------------------------------------------------------------------------

const YEAR_AT = String.raw`\b((?:19|20)\d{2})\b`;
const MONTH = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?,?`;
const LOSS_NOUN = String.raw`(?:LOSS|EVENT|CLAIM|INCIDENT)`;

/** A loss with a number of its own: "LOSS #2: 2019, March", "FLOOD EVENT #1 (April 2018):", "Event 3 (2020): KES 1,250,000". */
const NUMBERED_LOSS = new RegExp(String.raw`^\W*(?:[A-Za-z]+\s+){0,2}?${LOSS_NOUN}\s*(?:#|NO\.?\s*|NUMBER\s*)?\d{1,2}\b.{0,30}?${YEAR_AT}`, "i");
/** A loss on a line that opens with its date: "4. 2020 Flood: KES 1,250,000 paid", "April 2018: storm water in the basement", "Loss in 2021: burst pipe". */
const DATED_LOSS = new RegExp(String.raw`^\W*(?:\d{1,2}[.)]\s+)?(?:${LOSS_NOUN}\s+(?:in\s+|of\s+)?)?\(?(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:${MONTH}\s+)?${YEAR_AT}(?!\s*[-/]\s*\d)`, "i");

/** Flood and water from outside: a river or storm water, water in a basement, drains that block or overflow. Water from inside the building is taken out by internalWater. */
const WATER_LOSS = /\b(?:flood(?:s|ed|ing)?|inundat(?:ed|ion)|water|stormwater|burst\s+(?:\w+\s+)?(?:pipes?|mains?)|pipes?\s+burst|overflow\w*|seepage|sewer\w*\s+back\w*|blocked\s+(?:\w+\s+)?drain\w*)\b/i;
/** The other perils a loss history lists. A loss that names one is not read, even when water came into it. */
const OTHER_PERIL = /\b(?:fire|arson|theft|burglary|break[\s-]?in|robbery|stolen|machinery|breakdown|riot|vandalism|malicious|explosion|lightning|collision|vehicle|earthquake|wind(?:storm)?|hail|subsidence)\b/i;
/**
 * Water that came from inside the building: condensation, air conditioning, a leak, a burst pipe,
 * plumbing, a sprinkler or a tank. It is water damage, but it is not a flood, so it is not flood history.
 */
const INTERNAL_WATER = /\b(?:condensat\w*|air[\s-]?condition\w*|HVAC|leak(?:s|ed|ing|age)?|burst\s+(?:\w+\s+)?(?:pipes?|mains?)|pipes?\s+burst|plumbing|sprinklers?|water\s+(?:heater|tank)|geyser|cistern)\b/i;
/** "AC" and "A/C" in capitals only: in lower case they are parts of other words and abbreviations. */
const AIR_CON = /\bA\/?C\b/;
/** A flood proper: water from outside. A loss that names one is flood history even when a pipe also gave way. */
const FLOOD_PROPER = /\b(?:flood(?:s|ed|ing)?|inundat(?:ed|ion)|storm\s?water|river|rain(?:s|fall|water)?|surface\s+water|run-?off|sewer\w*)\b/i;
/** The words say the water came from inside the building, and name no flood. */
export const internalWater = (texts: string[]): boolean => texts.some((t) => INTERNAL_WATER.test(t) || AIR_CON.test(t)) && !texts.some((t) => FLOOD_PROPER.test(t));
const LOSS_WORD = /\b(?:loss(?:es)?|claims?|damage[ds]?|paid|settled|incurred|events?|incidents?)\b/i;
/** The lines of a loss that say what happened. */
const CAUSE_LABEL = /^(?:description|cause|peril|type|nature|event|details?|trigger|circumstances|what\s+happened)\b/i;
/** The line of a loss that gives its amount: "Amount paid", "Total claim", "Settled". A plain "Total" is the second choice. */
const AMOUNT_LABEL = /\b(?:claim(?:ed)?|paid|settled|settlement|amount|incurred)\b/i;
const TOTAL_LABEL = /^total\b/i;
/** A figure for several losses together, or for something that is not a loss. Never one loss's amount. */
const AGGREGATE_LABEL = /\b(?:years|yrs|losses|claims|events|average|annual|premium|frequency|ratio|deductible|excess|limit|sums?\s+insured|insured\s+values?|insurable|declared|TIV)\b/i;
/** The most lines one numbered loss is given. Text with no blank lines must not hand a loss the rest of the document. */
const MOST_LOSS_LINES = 40;
/** An amount that follows one of these words is the loss, not the value of what was damaged. */
const CLAIMED = /\b(?:claim(?:ed)?|paid|settled|loss|total)\b[^\d]{0,25}$/i;

/**
 * The loss figure among some amounts, with the text they stand in. A claim that moved, "KES
 * 2,400,000 (reduced from KES 2.6M to KES 2,150,000 after adjustment)", ended at the figure
 * after "to", which is the one a summary of the same losses gives. Otherwise an amount straight
 * after a loss word, else the first one.
 */
function lossFigure(text: string, amounts: Amount[]): Amount | null {
  if (!amounts.length) return null;
  const moved = new RegExp(String.raw`\bfrom\s+${KES_AMOUNT}\s+to\s+(${KES_AMOUNT})`, "i").exec(text);
  const settled = moved ? amounts.find((a) => a.index === moved.index + moved[0].length - moved[3].length) : undefined;
  return settled ?? amounts.find((a) => CLAIMED.test(text.slice(0, a.index))) ?? amounts[0];
}

/** The text names flood or water damage, and does not say there was none. A loss number ("No. 2") is not a "no". */
function saysWater(text: string): boolean {
  const said = text.replace(/\bno\.?\s*(?=\d)/gi, "");
  const at = WATER_LOSS.exec(said);
  return at !== null && !NEGATED.test(said.slice(0, at.index));
}

/** A section heading as memos write them: a label alone on its line, or a line in capitals. Words in brackets may be in lower case. */
const isHeading = (line: Line) => (line.label !== null && !line.value) || (/[A-Z]{3}/.test(line.text) && !/[a-z]{2}/.test(line.text.replace(/\([^)]*\)/g, "")) && amountsIn(line.text).length === 0);

/**
 * Every past flood or water damage loss the text lists, with its year and, where one is
 * written, its amount. Two shapes are read:
 *   a numbered loss   a line such as "LOSS #2: 2019, March" or "FLOOD EVENT #1 (April 2018):",
 *                     with the lines under it up to the next blank line. What happened is taken
 *                     from its description and cause lines, the amount from its amount or total line.
 *   a dated line      a line that opens with the year, such as "4. 2020 Flood: KES 1,250,000 paid".
 * A loss is kept only when its own words, or the heading it stands under, name flood or water
 * damage and name no other peril. A loss whose own words put the water inside the building
 * (condensation, a leak, a burst pipe) and name no flood is not flood history and is left out. The amount is the one written for the loss as a whole. Parts
 * are never added up, so a loss with no such figure keeps its year and a missing amount.
 */
function floodLossesIn(lines: Line[]): FloodLoss[] {
  const losses: FloodLoss[] = [];
  // The section the line sits in. Unlike a line's heading it runs on past blank lines, to the next heading.
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const numbered = NUMBERED_LOSS.exec(line.text);
    const found = numbered ?? DATED_LOSS.exec(line.text);
    if (!found) {
      if (isHeading(line)) section = line.text;
      continue;
    }
    const header = line.text;
    const afterYear = found.index + found[0].length;
    const onHeader = lossFigure(header, amountsIn(header).filter((a) => a.index >= afterYear));

    // A numbered loss with no amount on its own line owns the lines under it.
    const body: Line[] = [];
    if (numbered && !onHeader) for (let j = i + 1; j < lines.length && body.length < MOST_LOSS_LINES && !lines[j].first && !NUMBERED_LOSS.test(lines[j].text); j++) body.push(lines[j]);
    // Those lines are part of this loss, not losses of their own.
    i += body.length;

    const around = [line.heading, section];
    // A dated line is a loss only where losses are being listed.
    if (!numbered && ![header, ...around].some((text) => LOSS_WORD.test(text))) continue;

    const causes = body.filter((l) => l.label !== null && CAUSE_LABEL.test(l.label));
    const told = (causes.length ? causes : body).map((l) => l.text);
    let water: boolean;
    if (OTHER_PERIL.test(header)) water = false;
    else if (internalWater([header, ...told])) water = false;
    else if (saysWater(header)) water = true;
    else {
      if (told.some((text) => OTHER_PERIL.test(text))) water = false;
      else water = told.some(saysWater) || around.some((text) => saysWater(text) && !OTHER_PERIL.test(text));
    }
    if (!water) continue;

    let amountKes: FloodLoss["amountKes"] = missingValue();
    if (onHeader) amountKes = statedValue(onHeader.kes, header);
    else {
      const stated = body.filter((l) => l.label !== null && !AGGREGATE_LABEL.test(l.label) && amountsIn(l.value).length > 0);
      const amountLine = stated.find((l) => AMOUNT_LABEL.test(l.label!)) ?? stated.find((l) => TOTAL_LABEL.test(l.label!));
      if (amountLine) amountKes = statedValue(lossFigure(amountLine.text, amountsIn(amountLine.text))!.kes, amountLine.text);
    }
    losses.push({ year: statedValue(Number(found[1]), header), amountKes });
  }
  return losses;
}

/** Something that happened, as a typed sentence puts it. "Flood cover" and "flood limit" are terms, not events. */
const WATER_EVENT = String.raw`\b(?:flooded|flooding|floods?(?!\s+(?:cover|limit|sub-?limit|deductible|excess|risk|insurance|extension|zone|plain|maps?|defen[cs]es?|protection))|inundat(?:ed|ion)|water\s+damage|storm\s?water|burst\s+(?:\w+\s+)?(?:pipes?|mains?))\b`;

/**
 * In a few typed lines: "flooded in 2018 with a loss of KES 1.2 million". The sentence must
 * hold one year, standing beside the event, and the amount is read only beside a loss word,
 * so the insured value in the same sentence is never taken for the loss.
 */
function typedFloodLosses(sentences: string[]): FloodLoss[] {
  const happened = new RegExp(String.raw`${WATER_EVENT}[^.;]{0,40}?\b(?:in|during|of)\s+(?:${MONTH}\s+)?${YEAR_AT}|${YEAR_AT}[^.;]{0,20}?${WATER_EVENT}`, "i");
  const lossAmount = new RegExp(String.raw`\b(?:loss(?:es)?|claims?|damage|paid|settled|cost(?:ing)?)\b[^.;\d]{0,25}?${KES_AMOUNT}|${KES_AMOUNT}\s+(?:loss|claim|(?:in\s+|of\s+)?damage|paid)\b`, "i");
  const losses: FloodLoss[] = [];
  for (const sentence of sentences) {
    const years = sentence.match(new RegExp(YEAR_AT, "g")) ?? [];
    const when = happened.exec(sentence);
    if (years.length !== 1 || !when || OTHER_PERIL.test(sentence) || internalWater([sentence])) continue;
    // "Has not flooded since 2018" reports no loss. Only the clause the event stands in is asked.
    if (NEGATED.test(sentence.slice(0, when.index).split(/[,;:]/).pop()!)) continue;
    const m = lossAmount.exec(sentence);
    losses.push({ year: statedValue(Number(years[0]), sentence), amountKes: m ? statedValue(toNumber(m[1] ?? m[3], m[2] ?? m[4]), sentence) : missingValue() });
  }
  return losses;
}

const SPAN_YEARS = /(?:^|[^\d.,+-])(\d{1,3})\s*(?:years|yrs)\b(?!\s+(?:old|ago))/i;
/** "11-year loss history", "10 years of claims history". */
const HISTORY_SPAN = /(?:^|[^\d.,])(\d{1,3})[\s-]*years?\s+(?:of\s+)?(?:loss|claims?|flood)\s+(?:history|experience|record)\b/i;
const HISTORY_WORDS = /\b(?:loss(?:es)?|claims?|flood(?:ing|s)?)\s+(?:history|experience|record)\b|\b(?:history|record)\s+of\s+(?:\w+\s+)?(?:loss(?:es)?|claims?|flood)/i;
const LOSS_CONTEXT = /\b(?:loss(?:es)?|claims?|events?|incidents?)\b/i;

/**
 * The number of years the loss history covers, where the text writes one: a loss or claims
 * history line first ("LOSS HISTORY (11 YEARS: 2014-2024)"), else any line about losses that
 * gives a span ("3 events in 11 years"). A range of dates alone is not read: nothing is worked out.
 * "25-year" is a return period and "12 years old" an age; neither is a history.
 */
function historyYearsIn(lines: Line[]): Quoted<number> {
  const span = (text: string) => {
    const n = Number((HISTORY_SPAN.exec(text) ?? SPAN_YEARS.exec(text))?.[1] ?? 0);
    return n > 0 ? n : null;
  };
  const stating = lines.filter((l) => span(l.text) !== null);
  const line = stating.find((l) => HISTORY_WORDS.test(l.text)) ?? stating.find((l) => LOSS_CONTEXT.test(l.text) || LOSS_CONTEXT.test(l.heading));
  return line ? statedValue(span(line.text)!, line.text) : missingValue();
}

// ---------------------------------------------------------------------------------------------
// What the loss drivers beyond flood depth read
// ---------------------------------------------------------------------------------------------

/** One sentence, or one line of a list, with where it stands in the document. */
interface Statement {
  /** The sentence on one line. This is what a value's quote is. */
  text: string;
  /** The heading of the list it stands in: the nearest label alone on its line above it, up to a blank line. */
  heading: string;
  /** The section it stands in: the nearest heading above it, running on past blank lines. */
  section: string;
}

/** The section each line stands in. A heading is its own section. */
function sectionsOf(lines: Line[]): string[] {
  let section = "";
  return lines.map((line) => {
    if (isHeading(line)) section = line.text;
    return section;
  });
}

/** The text as sentences, joined over hard line breaks the way sentencesOf joins them, each with its heading and its section. */
function statementsOf(lines: Line[], sections: string[]): Statement[] {
  const blocks: Statement[] = [];
  lines.forEach((line, i) => {
    const last = blocks[blocks.length - 1];
    if (last && !line.first && !/[.:;!?]$/.test(last.text) && /^[a-z]/.test(line.text)) last.text += ` ${line.text}`;
    else blocks.push({ text: line.text, heading: line.heading, section: sections[i] });
  });
  return blocks.flatMap((block) => sentencesIn(block.text).map((text) => ({ ...block, text })));
}

/** The one value several statements agree on. null when none states it. Not stated when they differ: the rules cannot tell which is meant. */
function agreed<T>(found: Quoted<T>[]): Quoted<T> | null {
  if (!found.length) return null;
  return found.every((f) => f.value === found[0].value) ? found[0] : missingValue();
}

const BELOW_GROUND = /\b(?:sub-?basements?|basements?|below[\s-]+ground|below[\s-]+grade|underground)\b/i;
/**
 * Where past losses are told. A value or a cover is never read from there. "Loss of rent" and
 * "material damage" are covers, "loss prevention" is protection and an "event limit" is a term:
 * none of them is the telling of a loss.
 */
const LOSS_TELLING = /\b(?:loss(?:es)?(?!\s+(?:of\s+(?:rent|rental|revenue|profits?|income|earnings)|prevention|control|mitigation|limits?))|claims?|(?<!\b(?:material|property|physical)\s)damage[ds]?|events?(?!\s+limits?)|incidents?)\b/i;
const toldAsLoss = (s: { heading: string; section: string }) => LOSS_TELLING.test(s.heading) || LOSS_TELLING.test(s.section);
/** The policy now in force, where a memo also gives the terms asked for. */
const CURRENT_POLICY = /\b(?:current|expiring|existing|previous|prior|in\s+force)\b/i;
const isQuestion = (text: string) => /\?\s*$/.test(text);

/**
 * A word that denies what follows it: "no flood barriers", "not fitted with flood barriers",
 * "excluding flood and business interruption". At most three words may stand between, with no
 * comma, so "excluding flood, including business interruption" denies nothing, and neither does
 * "no losses since the flood barriers were fitted".
 */
const governs = (words: string) => new RegExp(String.raw`\b(?:${words})\s+(?:(?!(?:since|after|following|once|until|when|because|as|but)\b)[\w'’-]+\s+){0,3}$`, "i");
const DENIED = governs(String.raw`no|not|without|lacks?|lacking|never|nil|absence\s+of`);
const LEFT_OUT = governs(String.raw`excluding|excludes?|excluded|excl\.?|no|not|without|nil|declined`);
/** Straight after the thing: "Flood barriers: none", "the valves have not been fitted". */
const DENIED_AFTER = /^(?:\s*[:(,-]\s*(?:no|none|nil|absent|not)\b|[^.;]{0,45}?\b(?:not\s+(?:yet\s+)?(?:installed|fitted|present|provided|in\s+place|available|connected)|(?:have|has|had)\s+not\s+(?:yet\s+)?been|(?:are|is|were|was)\s+not|absent|unavailable)\b)/i;

// --- The depth of the basements ---

const METRES = String.raw`(?<![\d.,])(\d{1,2}(?:\.\d+)?)\s*(?:m|metres?|meters?)\b(?!\s*(?:²|2\b|\^2|sq\b))`;
const DEPTH_FORMS = [
  new RegExp(String.raw`${METRES}\s*(?:below\s+(?:the\s+)?(?:ground|grade|street|road|surface|pavement)(?:\s+level)?|deep\b|in\s+depth|bgl\b)`, "gi"),
  new RegExp(String.raw`\b(?:depth|deep(?:est)?)\b[^\d.;]{0,30}?${METRES}`, "gi"),
  // A level written as a negative height: "B2 at -7.5 m". A dash with a space after it is a bullet or a pause, not a minus.
  new RegExp(String.raw`(?:^|[\s(])(?:-|minus\s+)${METRES}`, "gi"),
];
/** A depth of water, which is not how deep the basement is. */
const WATER_DEPTH = /\b(?:flood(?:ed|ing|s)?|inundat\w*|ingress|submerged|ponding|rose|reached|stood|water\s+(?:level|depth|mark)|of\s+water)\b/i;
/** The height of one level, which is not the depth of them all. Nothing is multiplied. */
const PER_LEVEL = /\b(?:each|per\s+(?:level|floor|storey)|floor[\s-]to[\s-]floor|ceiling|headroom|clearance|clear\s+height|high)\b/i;
const DEPTH_RANGE = { min: 1, max: 60 } as const;

/** How far the lowest basement floor is below ground, from the first statement about a basement that gives a depth. */
function basementDepthIn(statements: Statement[]): Quoted<number> {
  for (const s of statements) {
    if (!BELOW_GROUND.test(s.text) || WATER_DEPTH.test(s.text) || PER_LEVEL.test(s.text)) continue;
    const depths = DEPTH_FORMS.flatMap((form) => [...s.text.matchAll(form)].map((m) => Number(m[1]))).filter((d) => d >= DEPTH_RANGE.min && d <= DEPTH_RANGE.max);
    // Several depths in one statement are the levels: the lowest floor is the deepest of them.
    if (depths.length) return statedValue(Math.max(...depths), s.text);
  }
  return missingValue();
}

// --- Equipment below ground ---

const EQUIPMENT_LEAD = String.raw`(?:(?:standby|back-?up|emergency|diesel|main|primary|fire|sump|sewage|water|booster|sprinkler|hydrant|transfer|fuel|storage|LV|MV|HV|low[\s-]voltage|medium[\s-]voltage|high[\s-]voltage|electrical|domestic|chilled[\s-]water|submersible|de-?watering|drainage)\s+)`;
const EQUIPMENT_KIND = String.raw`(?:generators?|gen-?sets?|switchgear|switch\s?rooms?|switchboards?|transformers?|substations?|pump\s?(?:sets?|rooms?|stations?)|pumps?|tanks?|lift\s+(?:motors?|machinery|machine\s+rooms?|equipment)|elevator\s+(?:motors?|machinery)|server\s+rooms?|servers?|data\s+cent(?:re|er)s?|UPS(?:\s+(?:units?|rooms?|systems?))?|chillers?|boilers?|control\s+(?:panels?|rooms?)|distribution\s+boards?|BMS|plant\s?rooms?|batter(?:y|ies)\s+(?:rooms?|banks?)|compressors?|air\s+handling\s+units?|meter\s+rooms?|electrical\s+(?:rooms?|panels?|intake))`;
const EQUIPMENT = new RegExp(String.raw`(?<![\w-])(${EQUIPMENT_LEAD}{0,2}${EQUIPMENT_KIND})(?![\w-])`, "gi");
/** Equipment that was below ground once, or that the statement puts somewhere else. */
const MOVED = /\b(?:relocat\w*|moved|removed|no\s+longer|formerly|previously|used\s+to|raised|elevated|decommissioned)\b/i;
/** The telling of a past flood says where equipment stood then, which may not be where it stands now. */
const HAPPENED = /\b(?:damaged?|destroyed|flooded|flooding|submerged|inundated|claims?|loss(?:es)?)\b/i;
const ABOVE_GROUND = /\b(?:roof(?:top)?|above[\s-]+ground|podium|penthouse)\b/i;
const SHORT_NAMES = new Set(["UPS", "BMS", "LV", "MV", "HV"]);

/** The item as the document names it, in sentence case: "STANDBY GENERATOR" and "standby generator" are both "Standby generator". */
function itemName(written: string): string {
  const tidy = written.replace(/\s+/g, " ").trim();
  const cased = /[a-z]/.test(tidy) ? tidy : tidy.replace(/[A-Za-z]+/g, (word) => (SHORT_NAMES.has(word) ? word : word.toLowerCase()));
  return cased.charAt(0).toUpperCase() + cased.slice(1);
}

/**
 * Each item of equipment a statement places in a basement or below ground: named in the same
 * clause as the basement, named in the heading of a line that says where it is housed, or listed
 * under a heading about the basement. A statement that denies it, says the item was moved, or
 * tells of a past loss places nothing.
 */
function equipmentIn(statements: Statement[]): EquipmentItem[] {
  const items: EquipmentItem[] = [];
  const named = (text: string) => [...text.matchAll(EQUIPMENT)].map((m) => itemName(m[1]));
  for (const s of statements) {
    if (MOVED.test(s.text) || HAPPENED.test(s.text) || toldAsLoss(s) || isQuestion(s.text)) continue;
    const here = BELOW_GROUND.exec(s.text);
    let names: string[] = [];
    if (here) {
      if (NEGATED.test(s.text.slice(0, here.index))) continue;
      // "Generators are in basement 2; the chillers are on the roof" places the generators only.
      const clauses = s.text.split(/;|\b(?:while|whereas|but)\b/i).filter((clause) => BELOW_GROUND.test(clause) && !ABOVE_GROUND.test(clause));
      names = clauses.flatMap(named);
      if (!names.length && clauses.length) names = named(s.heading);
    } else if (BELOW_GROUND.test(s.heading) && !/^\W*(?:no|none|nil)\b/i.test(s.text) && !ABOVE_GROUND.test(s.text)) {
      names = named(s.text);
    }
    for (const name of names) items.push({ item: statedValue(name, s.text) });
  }
  return uniqueEquipment(items);
}

// --- The storm the drains are designed for ---

const DRAIN = /\b(?:drains?|drainage|storm\s?water|storm\s+sewers?|culverts?|sewers?|gutters?|outfalls?|soakaways?)\b/i;
const DESIGNED = String.raw`\b(?:design(?:ed)?|sized|engineered|specified|capacity|standard)\b`;
/** "1-in-50", "1:50 year", "50-year". "12 years old" and "8 years ago" are ages. */
const RETURN_PERIOD = String.raw`(?:(?<![\d.,])1[\s-]*(?:in|[:/])[\s-]*(\d{1,4})(?![\d]|[.,]\d)|(?<![\d.,:/])(\d{1,4})[\s-]*(?:years?|yrs?)\b(?!\s+(?:old|ago)))`;
const DESIGN_FORMS = [new RegExp(String.raw`${DESIGNED}([^.;\d]{0,60}?)${RETURN_PERIOD}`, "i"), new RegExp(String.raw`${RETURN_PERIOD}([^.;\d]{0,25}?)\b(?:design|standard|capacity)\b`, "i")];
/** Between the design word and the figure, these make it something else: a design life, or the storm that beat the design. */
const NOT_THE_DESIGN = /\b(?:life(?:span|time)?|warranty|guarantee|lease|exceed\w*|overwhelm\w*|overtopp\w*|surcharg\w*|flood\w*|events?|rainfall|by)\b/i;
const MOST_DESIGN_YEARS = 1000;

/**
 * The return period the site's drains are designed for, from a statement about drains that
 * says so: "designed for a 1-in-50 year storm", "25-year design standard". The return period of
 * a flood that happened is not a design. Two statements that give different designs leave it
 * not stated.
 */
function drainDesignIn(statements: Statement[]): Quoted<number> {
  const found: Quoted<number>[] = [];
  for (const s of statements) {
    if ((!DRAIN.test(s.text) && !DRAIN.test(s.heading)) || isQuestion(s.text)) continue;
    for (const [i, form] of DESIGN_FORMS.entries()) {
      const m = form.exec(s.text);
      if (!m) continue;
      const between = i === 0 ? m[1] : m[3];
      const years = Number(i === 0 ? (m[2] ?? m[3]) : (m[1] ?? m[2]));
      if (NOT_THE_DESIGN.test(between) || years < 1 || years > MOST_DESIGN_YEARS) continue;
      found.push(statedValue(years, s.text));
      break;
    }
  }
  return agreed(found) ?? missingValue();
}

// --- Sump pumps ---

const SUMP = /\b(?:sump|de-?watering|submersible)\b/i;
const FLOW_UNIT = String.raw`(?:l\s?\/\s?s(?:ec)?\b|lps\b|l\s?\/\s?min\b|lpm\b|l\s?\/\s?h(?:r|our)?\b|lit(?:re|er)s?\s*(?:per|\/|a)\s*(?:second|sec|minute|min|hour|hr)\b|m(?:3|³)\s?\/\s?(?:h(?:r|our)?|s(?:ec)?|min)\b|cubic\s+met(?:re|er)s?\s+(?:per|an?)\s+(?:hour|second|minute)\b|gpm\b|gallons?\s+per\s+(?:minute|hour)\b)`;
const POWER_UNIT = String.raw`(?:kW\b|hp\b|horsepower\b)`;
/** "2 x 15 l/s", "500 litres per minute", "30 m³/h each". A flow first; a motor rating only when no flow is given. */
const capacityIn = (unit: string) => new RegExp(String.raw`(?:(?<![\d.,])\d{1,2}\s*(?:x|×|no\.?|nos\.?)\s*)?(?<![\d.,])\d[\d,]*(?:\.\d+)?\s*${unit}(?:\s+each\b)?`, "i");
const CAPACITY_FORMS = [capacityIn(FLOW_UNIT), capacityIn(POWER_UNIT)];

const BACKUP_SOURCE = String.raw`(?:the\s+|a\s+)?(?:(?:standby|back-?up|emergency|diesel|building(?:'s|’s)?)\s+){0,2}(?:generators?|gen-?sets?|UPS|essential\s+(?:supply|power|circuit|board)|emergency\s+(?:supply|power))`;
const BACKUP_POWER = new RegExp(
  [
    String.raw`\bback-?\s?up\s+(?:power|supply|supplies|generators?|electricity|batter(?:y|ies))\b`,
    String.raw`\b(?:power|battery|generator)\s+back-?\s?up\b`,
    String.raw`\b(?:connected|wired|linked|fed|supplied|powered|backed(?:\s+up)?|runs?|running|operat\w+)\s+(?:\w+\s+){0,2}?(?:to|on|by|from|off)\s+${BACKUP_SOURCE}\b`,
    String.raw`\bon\s+(?:the\s+)?essential\s+(?:supply|power|circuit|board)\b`,
    String.raw`\bdual\s+(?:power\s+)?(?:supply|feed)\b`,
    String.raw`\b(?:UPS|battery|generator)[\s-]backed\b`,
  ].join("|"),
  "i",
);

/** Whether a statement about the sump pumps says they have backup power. null when it does not say. */
function backupIn(text: string): YesNo | null {
  if (/\bmains(?:\s+(?:power|supply|electricity))?\s+only\b/i.test(text)) return "no";
  const m = BACKUP_POWER.exec(text);
  if (!m) return null;
  return DENIED.test(text.slice(0, m.index)) || DENIED_AFTER.test(text.slice(m.index + m[0].length)) ? "no" : "yes";
}

/** Another kind of pump named under a heading about the sump pumps. Its figures are not theirs. */
const OTHER_PUMP = /\b(?:fire|sprinkler|hydrant|booster|domestic|jockey|transfer|fuel|water\s+supply)\b/i;

/**
 * The sump pumps' capacity, in the document's own words, and whether they have backup power:
 * each from the first statement that says, among those that name the sump pumps or stand under
 * a heading that does.
 */
function sumpPumpsIn(statements: Statement[]): { capacity: Quoted<string>; backup: Quoted<YesNo> } {
  let capacity: Quoted<string> = missingValue();
  let backup: Quoted<YesNo> = missingValue();
  for (const s of statements) {
    if (isQuestion(s.text)) continue;
    if (!SUMP.test(s.text) && (!(SUMP.test(s.heading) || SUMP.test(s.section)) || OTHER_PUMP.test(s.text))) continue;
    if (capacity.value === null) {
      const m = CAPACITY_FORMS.map((form) => form.exec(s.text)).find(Boolean);
      if (m) capacity = statedValue(m[0].replace(/\s+/g, " ").trim(), s.text);
    }
    if (backup.value === null) {
      const has = backupIn(s.text);
      if (has) backup = statedValue(has, s.text);
    }
  }
  return { capacity, backup };
}

// --- Flood barriers and non-return valves ---

const BARRIER = /\b(?:flood\s+(?:barriers?|gates?|boards?|doors?|shields?|walls?|bunds?|defen[cs]es?)|demountable\s+(?:flood\s+)?barriers?|stop\s?logs?)\b/i;
const VALVE = /\b(?:non[\s-]?return\s+valves?|NRVs?|back[\s-]?(?:flow|water)\s+(?:valves?|preventers?|prevention)|anti[\s-]?flood\s+valves?|flap\s+valves?|check\s+valves?)\b/i;
/** Something talked about but not there yet, or not known. The rules cannot be sure, so it is left not stated. */
const NOT_SETTLED = /\b(?:recommend\w*|propos\w*|plan(?:s|ned)?|consider\w*|budget\w*|to\s+be|will\s+be|should|awaiting|pending|quot(?:e[ds]?|ation)|under\s+review|require[sd]?|requirements?|subject\s+to|condition(?:al)?|advis\w*|suggest\w*|unknown|unclear|unconfirmed|tbc|whether)\b/i;

/** Whether the document says the thing is fitted or says there is none. Statements that disagree leave it not stated. */
function presenceIn(statements: Statement[], thing: RegExp): Quoted<Presence> {
  const found: Quoted<Presence>[] = [];
  for (const s of statements) {
    const m = thing.exec(s.text);
    if (!m || isQuestion(s.text)) continue;
    if (DENIED.test(s.text.slice(0, m.index)) || DENIED_AFTER.test(s.text.slice(m.index + m[0].length))) found.push(statedValue<Presence>("absent", s.text));
    else if (!NOT_SETTLED.test(s.text)) found.push(statedValue<Presence>("present", s.text));
  }
  return agreed(found) ?? missingValue();
}

// --- The value split ---

/** A label with what stands in brackets left off: "Buildings (reinstatement value)" is "Buildings". */
const bareLabel = (label: string) => label.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
const VALUE_WORDS = String.raw`(?:\s+(?:values?|sums?\s+insured))?`;
const VALUE_LABELS = {
  building: new RegExp(String.raw`^(?:(?:main\s+)?buildings?(?:\s+(?:structures?|works|only))?(?:\s*(?:and|&|,)\s*(?:fixtures|fittings|improvements|services|structures?|civil\s+works|foundations|external\s+works)[\w\s,&]*)?|structures?|civil\s+works)${VALUE_WORDS}$`, "i"),
  machinery: new RegExp(String.raw`^(?:(?:fixed\s+)?(?:plant|machinery|equipment|M\s?&\s?E)(?:\s*(?:and|&|,|\/)\s*(?:plant|machinery|equipment))*|mechanical\s+(?:and|&)\s+electrical(?:\s+(?:plant|services|equipment|installations?))?)${VALUE_WORDS}$`, "i"),
  contents: new RegExp(String.raw`^(?:(?:general\s+)?contents?(?:\s*(?:and|&|,)\s*(?:stocks?|fixtures|fittings|furniture|equipment))*|(?:furniture|fixtures)(?:\s*(?:and|&|,)\s*(?:fittings|fixtures|furniture|equipment))*)${VALUE_WORDS}$`, "i"),
  stock: new RegExp(String.raw`^(?:stocks?(?:\s+(?:in\s+trade|and\s+(?:materials|inventory|contents)))?|inventory|raw\s+materials?(?:\s+and\s+finished\s+goods)?|finished\s+goods)${VALUE_WORDS}$`, "i"),
};

/**
 * One part of the insured value, from a line labelled with that part alone and a KES amount:
 * "Buildings: KES 3,400,000,000". Never from the telling of a past loss. null when no line
 * gives it; not stated when lines give different amounts, as for several buildings.
 */
function valuePartIn(lines: Line[], sections: string[], label: RegExp): Quoted<number> | null {
  const found = lines.flatMap((line, i) => {
    if (line.label === null || !label.test(bareLabel(line.label)) || LOSS_TELLING.test(`${line.heading} ${sections[i]}`)) return [];
    const [amount] = amountsIn(line.value);
    return amount ? [statedValue(amount.kes, line.text)] : [];
  });
  return agreed(found);
}

const VALUED = String.raw`\b(?:valued\s+at|worth|value\s+of|values?\s+(?:is|are|totals?|totalling|amounts?\s+to)|replacement\s+(?:cost|value)(?:\s+of)?|insured\s+(?:for|at)|sums?\s+insured(?:\s+of)?|value[ds]?)\b`;
const PLANT_OR_CONTENTS = /\b(?:plant|machinery|equipment|contents|M\s?&\s?E|generators?|switchgear|installations?|assets?|stocks?|services)\b/i;
/** Amounts that are not the value of what is kept below ground. */
const NOT_A_VALUE = /\b(?:loss(?:es)?|claims?|damage[ds]?|destroyed|paid|settled|flooded|flooding|events?|incidents?|repair(?:s|ed)?|limits?|deductibles?|excess|premiums?|TIV|total\s+(?:insured\s+value|sums?\s+insured))\b/i;

/**
 * The value of the machinery and contents the document says are below ground, where one
 * statement names the basement, what is kept there and its value. An amount as large as the
 * whole insured value is the building's, not the basement's, and is not read.
 */
function valueBelowGroundIn(statements: Statement[], tivKes: number | null): Quoted<number> {
  const found: Quoted<number>[] = [];
  for (const s of statements) {
    if (!BELOW_GROUND.test(s.text) || !PLANT_OR_CONTENTS.test(s.text) || NOT_A_VALUE.test(s.text) || toldAsLoss(s) || isQuestion(s.text)) continue;
    const amount = amountBeside(s.text, new RegExp(VALUED, "i"));
    if (!amount || amount.kes <= 0 || (tivKes !== null && amount.kes >= tivKes)) continue;
    found.push(statedValue(amount.kes, s.text));
  }
  return agreed(found) ?? missingValue();
}

// --- Rent or revenue for one year ---

const RENT = /\b(?:gross\s+)?rent(?:al)?s?(?:\s+(?:income|roll|revenue|receipts))?\b/i;
const REVENUE = /\b(?:revenue|turnover|gross\s+(?:profit|income|earnings))\b/i;
const YEARLY = /(?:\bannual(?:ly|ised|ized)?\b|\bper\s+annum\b|\bp\.\s?a\.|\bpa\b|\bper\s+year\b|\ba\s+year\b|\byearly\b|\beach\s+year\b|\b12[\s-]months?\b|\btwelve[\s-]months?\b)/i;
/** A figure for a month, a quarter or a square metre is never multiplied up. */
const NOT_YEARLY = /(?:\bmonthly\b|\bper\s+month\b|\ba\s+month\b|\beach\s+month\b|\bp\.\s?m\.|\bquarter(?:ly)?\b|\bweek(?:ly)?\b|\bdaily\b|\bper\s+day\b|(?:\bper\s+|\/\s?)(?:m²|m2\b|sq\b|square\b))/i;
const NOT_RENT = /\b(?:premiums?|deductibles?|excess|limits?|sub-?limits?|claims?|paid|settled|increase[ds]?|growth|arrears)\b/i;

/** A year's rent, else a year's revenue, where a statement gives the figure as a yearly one. */
function annualRentIn(statements: Statement[]): Quoted<number> {
  const yearly = (word: RegExp) =>
    agreed(
      statements.flatMap((s) => {
        if (!word.test(s.text) || !YEARLY.test(s.text) || NOT_YEARLY.test(s.text) || NOT_RENT.test(s.text) || toldAsLoss(s) || isQuestion(s.text)) return [];
        const amount = amountBeside(s.text, word);
        return amount ? [statedValue(amount.kes, s.text)] : [];
      }),
    );
  return yearly(RENT) ?? yearly(REVENUE) ?? missingValue();
}

// --- Business interruption cover ---

const BI_WORDS = /\b(?:business\s+interruption|loss\s+of\s+(?:rent(?:al)?(?:\s+income)?|revenue|profits?|income|earnings)|consequential\s+loss(?:es)?|rent(?:al)?\s+guarantee)\b/i;
/** The letters alone, in capitals: "BI". */
const BI_LETTERS = /\bBI\b/;
const BI_LEFT_OUT_AFTER = /^[^.;]{0,45}?\b(?:excluded|not\s+(?:covered|included|insured|required|requested|sought|applicable|purchased|taken)|none|nil|n\/a|no\s+cover)\b/i;
const BI_COVER_WORDS = /\b(?:cover(?:ed|age|s)?|insured|included?|including|incl\.?|inclusive|extensions?|requested|sought|required|indemnity|sums?\s+insured|section|material\s+damage|property\s+damage|all\s+risks)\b/i;
/** An interruption that happened is part of a loss, not a statement about the cover. */
const BI_HAPPENED = /\b(?:claim(?:s|ed)?|paid|settled|incurred|suffered|downtime|outage|closed|closure)\b/i;

/**
 * Whether the offer asks for business interruption or loss of rent to be insured. "Covered"
 * needs a statement that names it with a word of cover or a sum insured; "excluded" one that
 * leaves it out. Where the two disagree, the terms asked for outrank the policy now in force,
 * and if they still disagree it is left not stated.
 */
function biCoverIn(statements: Statement[]): Quoted<BiCover> {
  const covered: Statement[] = [];
  const excluded: Statement[] = [];
  for (const s of statements) {
    const m = BI_WORDS.exec(s.text) ?? BI_LETTERS.exec(s.text);
    if (!m || toldAsLoss(s) || isQuestion(s.text)) continue;
    const before = s.text.slice(0, m.index);
    const after = s.text.slice(m.index + m[0].length);
    if (LEFT_OUT.test(before) || BI_LEFT_OUT_AFTER.test(after)) excluded.push(s);
    else if (!BI_HAPPENED.test(`${before} ${after}`) && (BI_COVER_WORDS.test(`${before} ${after}`) || amountsIn(s.text).length > 0)) covered.push(s);
  }
  const asked = (list: Statement[]) => list.filter((s) => !CURRENT_POLICY.test(`${s.heading} ${s.section} ${s.text}`));
  const [yes, no] = covered.length && excluded.length ? [asked(covered), asked(excluded)] : [covered, excluded];
  if (yes.length && !no.length) return statedValue<BiCover>("covered", yes[0].text);
  if (no.length && !yes.length) return statedValue<BiCover>("excluded", no[0].text);
  return missingValue();
}

// --- The annual premium ---

/** A premium that is not the policy's annual premium for all risks. */
const NOT_THE_PREMIUM = /\b(?:flood|additional|extra|reinstatement|deposit|adjust\w*|minimum|returns?|refund\w*|loading|discount|savings?|instal?ments?|monthly|quarterly|earned|cumulative|per\s+mille)\b/i;
/** A premium over several years is not one year's. */
const MANY_YEARS = /(?<![\d.,])\d{1,2}[\s-]*(?:years|yrs)\b/i;
const PROPOSED = /\b(?:propos\w*|target\w*|indicat\w*|quot\w*|renewal|requested|sought|expected|budget\w*|estimated?)\b/i;

/**
 * The offer's annual premium: a KES amount straight after the word "premium", or straight
 * before it. The premium now paid is taken before a proposed one. Different amounts that
 * cannot be told apart leave it not stated.
 */
function premiumIn(statements: Statement[]): Quoted<number> {
  const current: Quoted<number>[] = [];
  const proposed: Quoted<number>[] = [];
  for (const s of statements) {
    const word = /\bpremiums?\b/i.exec(s.text);
    if (!word || toldAsLoss(s) || isQuestion(s.text) || MANY_YEARS.test(s.text)) continue;
    const end = word.index + word[0].length;
    const amounts = amountsIn(s.text);
    // "Annual premium: KES 12,500,000", "premium of approximately KES 12.5 million", "KES 12.5 million annual premium".
    const amount = amounts.find((a) => a.index >= end && a.index - end <= 40 && !/\d/.test(s.text.slice(end, a.index))) ?? amounts.find((a) => a.end <= word.index && /^\s*(?:(?:annual|gross|total|current|expiring)\s+)*$/i.test(s.text.slice(a.end, word.index)));
    if (!amount) continue;
    const about = s.text.slice(0, Math.max(end, amount.index));
    if (NOT_THE_PREMIUM.test(about)) continue;
    (PROPOSED.test(`${s.heading} ${about}`) && !CURRENT_POLICY.test(about) ? proposed : current).push(statedValue(amount.kes, s.text));
  }
  return agreed(current) ?? agreed(proposed) ?? missingValue();
}

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
      const plain = sentences.flatMap((s) => (/\b(?:deductible|excess|limit|rent(?:al)?s?|revenue|turnover|premiums?)\b/i.test(s) || perM2.test(s) ? [] : amountsIn(s).map((a) => ({ a, s }))));
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

  // --- Loss history: the years it covers, and each flood or water damage loss listed in it, once.
  terms.floodHistoryYears = historyYearsIn(lines);
  const floodLosses = uniqueLosses([...floodLossesIn(lines), ...(typed ? typedFloodLosses(sentences) : [])]);

  // --- What the loss drivers need: each from a statement that says it, never from what is usual.
  const sections = sectionsOf(lines);
  const statements = statementsOf(lines, sections);
  terms.basementDepthM = basementDepthIn(statements);
  terms.drainDesignRp = drainDesignIn(statements);
  const pumps = sumpPumpsIn(statements);
  terms.sumpPumpCapacity = pumps.capacity;
  terms.sumpPumpBackup = pumps.backup;
  terms.floodBarriers = presenceIn(statements, BARRIER);
  terms.nonReturnValves = presenceIn(statements, VALVE);
  terms.valueBuildingKes = valuePartIn(lines, sections, VALUE_LABELS.building) ?? missingValue();
  terms.valueMachineryKes = valuePartIn(lines, sections, VALUE_LABELS.machinery) ?? missingValue();
  // Stock stands in for contents only when the document gives no contents figure. The two are never added.
  terms.valueContentsKes = valuePartIn(lines, sections, VALUE_LABELS.contents) ?? valuePartIn(lines, sections, VALUE_LABELS.stock) ?? missingValue();
  terms.valueBelowGroundKes = valueBelowGroundIn(statements, row.tivKes.value);
  terms.annualRentKes = annualRentIn(statements);
  terms.biCovered = biCoverIn(statements);
  terms.premiumKes = premiumIn(statements);
  const equipmentBelowGround = equipmentIn(statements);

  return { rows: [row], terms, notes, floodLosses, equipmentBelowGround };
};
