/**
 * Packs one run of the agents into web/public/agents, so it ships with the app and is replayed
 * when a browser holds no run of its own (see src/lib/agents/shipped.ts).
 *
 *   node scripts/pack-run.mjs <saved-run.json> --kind portfolio|offer [--offer-key <key>] [--drop-prompts] [--out <folder>]
 *
 * <saved-run.json> is a run as the app saves it, taken either way:
 *   - the value under the browser's storage key "mafuriko:run:<data set>:<buildings>:<total insured value>"
 *   - the file the Audit step downloads with "Save the agent run for replay"
 * Pack the run as the app saved it, not a file this script has already written.
 *
 *   --kind portfolio   a run made with no offer loaded
 *   --kind offer       a run made on a priced offer: its figures beyond flood depth ship with it
 *   --offer-key        the key of that offer. Left out, it is worked out from the brief saved in the run
 *   --drop-prompts     leaves out the text of the prompts sent and the sentences of the offer document
 *                      held in the saved brief. Kept: the replies, the tokens, the model, what the run
 *                      was made on and the parameters. For a run on a real offer.
 *   --out              where to write. web/public/agents when left out.
 *
 * The run is checked (every agent replied, the final parameters and the inputs are there), written
 * under a dated name and listed in index.json, replacing an older run of the same kind made on the
 * same inputs (and, for an offer run, on the same offer). Plain Node, nothing to install.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROLES = ["optimist", "cautious", "critic", "chair"];
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const TAKE_IT_AGAIN =
  'Take the run again from the app: after a live run, the value under the browser\'s storage key "mafuriko:run:...", or the file from "Save the agent run for replay" on the Audit step.';

function fail(message) {
  console.error(`pack-run: ${message}`);
  process.exit(1);
}

function readArgs(argv) {
  const args = { file: null, kind: null, offerKey: null, dropPrompts: false, out: fileURLToPath(new URL("../public/agents/", import.meta.url)) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) fail(`${a} needs a value.`);
      return argv[i];
    };
    if (a === "--kind") args.kind = value();
    else if (a === "--offer-key") args.offerKey = value();
    else if (a === "--out") args.out = resolve(value());
    else if (a === "--drop-prompts") args.dropPrompts = true;
    else if (a.startsWith("--")) fail(`Unknown option ${a}.`);
    else if (args.file === null) args.file = a;
    else fail(`Only one run file can be packed at a time; got "${args.file}" and "${a}".`);
  }
  if (args.file === null || (args.kind !== "portfolio" && args.kind !== "offer")) {
    fail("Usage: node scripts/pack-run.mjs <saved-run.json> --kind portfolio|offer [--offer-key <key>] [--drop-prompts] [--out <folder>]");
  }
  return args;
}

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const numbersOnly = (v) => isRecord(v) && Object.keys(v).length > 0 && Object.values(v).every(isNumber);

/** Every value of a reasoned set ({ value, reason, ... } at the leaves), flattened. */
function reasonedValues(set) {
  if (!isRecord(set)) return [];
  if ("value" in set) return [set.value];
  return Object.values(set).flatMap(reasonedValues);
}

/** FNV-1a over the text from one starting value, as eight hex digits. The same as in src/lib/agents/shipped.ts. */
function fnv(text, start) {
  let h = start;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The key of the offer the agents saw. The same facts in the same order as offerKey in src/lib/agents/shipped.ts; a test holds the two together. */
function offerKey(brief) {
  const whole = (v) => (v === null || v === undefined ? null : Math.round(v));
  const facts = JSON.stringify([
    brief.housingClass,
    brief.occupancy ?? null,
    whole(brief.insuredValueKes),
    whole(brief.floorAreaM2),
    brief.locationApproximate ?? false,
    brief.basements,
    brief.basementDepthM ?? null,
    brief.criticalPlantInBasement,
    brief.equipmentBelowGroundCount ?? 0,
    whole(brief.valueBelowGroundKes),
    brief.drainageCondition,
    brief.drainDesignRp ?? null,
    brief.sumpPumpCapacity ?? null,
    brief.sumpPumpBackup ?? null,
    brief.floodBarriers ?? null,
    brief.nonReturnValves ?? null,
    brief.biCovered ?? null,
    brief.floodLossCount,
    whole(brief.floodLossTotalKes),
    brief.floodHistoryYears,
    whole(brief.nearestRiverM),
    whole(brief.nearestDrainM),
    brief.quotes.map((q) => q.quote),
  ]);
  return fnv(facts, 0x811c9dc5) + fnv(facts, 0x9747b28c);
}

const sameInputs = (a, b) => a.dataset === b.dataset && a.buildings === b.buildings && Math.round(a.totalTivKes) === Math.round(b.totalTivKes) && a.reference === b.reference;

function readRun(path) {
  let run;
  try {
    run = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
    // A storage value copied out as a quoted string holds the run as text.
    if (typeof run === "string") run = JSON.parse(run);
  } catch (e) {
    fail(`${path} could not be read as JSON: ${e.message}`);
  }
  if (!isRecord(run) || !isRecord(run.runs)) fail(`${path} is not a saved run: it has no agent replies. ${TAKE_IT_AGAIN}`);
  return run;
}

/** Stops with a plain message unless the run has every reply, its final parameters and what it was made on. */
function check(run) {
  for (const role of ROLES) {
    const reply = run.runs[role];
    if (!isRecord(reply) || reply.status !== "done" || !isRecord(reply.output)) fail(`The ${role} gave no valid reply in this run, so it cannot ship. Run the agents again until all four reply.`);
  }
  const decided = reasonedValues(run.runs.chair.output.decision);
  if (decided.length === 0 || !decided.every(isNumber)) fail("The Chair's reply holds no complete decision.");
  const p = run.finalParams;
  if (!isRecord(p) || !isNumber(p.depthScaleM) || !numbersOnly(p.fragility) || !numbersOnly(p.cap) || !numbersOnly(p.returnPeriods)) {
    fail(`This run does not state its final parameters. ${TAKE_IT_AGAIN}`);
  }
  const made = run.inputs;
  if (!isRecord(made) || typeof made.dataset !== "string" || !isNumber(made.buildings) || !isNumber(made.totalTivKes) || typeof made.reference !== "string" || !/^[0-9a-f]{8}$/.test(made.reference)) {
    fail(`This run does not say what it was made on (the data set and the fingerprint of the reference result). ${TAKE_IT_AGAIN}`);
  }
  if (typeof run.fingerprint !== "string") fail("This run has no result fingerprint, so a replay could not be checked against it.");
  if (typeof run.startedAt !== "string" || Number.isNaN(new Date(run.startedAt).getTime())) fail("This run does not say when it was made.");
}

const args = readArgs(process.argv.slice(2));
const run = readRun(args.file);
check(run);

const inputs = { dataset: run.inputs.dataset, buildings: run.inputs.buildings, totalTivKes: Math.round(run.inputs.totalTivKes), reference: run.inputs.reference };
const savedAt = new Date(run.startedAt).toISOString();
const models = [...new Set(ROLES.map((role) => (typeof run.runs[role].model === "string" ? run.runs[role].model.trim() : "")).filter(Boolean))];
if (models.length === 0) fail("No reply in this run names the model that wrote it.");

let key = null;
if (args.kind === "portfolio") {
  if (run.offerJudgement) fail("This run was made with an offer loaded. Pack it with --kind offer, or run the agents again with no offer loaded.");
  if (args.offerKey !== null) fail("--offer-key is for --kind offer.");
} else {
  const argued = run.offerJudgement;
  if (!isRecord(argued) || !isRecord(argued.final)) fail("This run holds no agreed figures for an offer. Run the agents with the priced offer loaded, or pack it with --kind portfolio.");
  const brief = argued.brief;
  const worked = isRecord(brief) && Array.isArray(brief.quotes) ? offerKey(brief) : null;
  key = args.offerKey ?? worked;
  if (key === null) fail("This run does not hold the brief of the offer it was made on, so its key cannot be worked out. Pass --offer-key.");
  if (!/^[0-9a-f]{16}$/.test(key)) fail(`"${key}" is not an offer key: sixteen hex digits are expected.`);
  if (worked !== null && key !== worked) fail(`--offer-key ${key} is not the key of the offer saved in this run (${worked}). Leave --offer-key out to use that one.`);
}

if (args.dropPrompts) {
  for (const role of ROLES) delete run.runs[role].prompt;
  const brief = run.offerJudgement?.brief;
  if (isRecord(brief)) {
    // The document's own words go; the plain facts stay. The key above was taken before this.
    brief.quotes = [];
    brief.drainageCondition = null;
    brief.sumpPumpCapacity = null;
  }
}

mkdirSync(args.out, { recursive: true });
const indexPath = join(args.out, "index.json");
let index = { runs: [] };
if (existsSync(indexPath)) {
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    fail(`${indexPath} could not be read as JSON: ${e.message}`);
  }
  if (!isRecord(index) || !Array.isArray(index.runs)) fail(`${indexPath} is not an index of runs: { "runs": [...] } is expected.`);
}

const day = savedAt.slice(0, 10);
const file = args.kind === "offer" ? `offer-${day}-${key.slice(0, 8)}.json` : `portfolio-${day}.json`;
const entry = { file, kind: args.kind, savedAt, model: models.join(", "), inputs, ...(key !== null ? { offerKey: key } : {}) };

// An older run of the same kind on the same inputs (and the same offer) gives way to this one.
const replaces = (e) => isRecord(e) && e.kind === entry.kind && isRecord(e.inputs) && sameInputs(e.inputs, inputs) && (entry.kind === "portfolio" || e.offerKey === key);
const kept = index.runs.filter((e) => !replaces(e));
for (const old of index.runs.filter(replaces)) {
  const unused = typeof old.file === "string" && FILE_NAME.test(old.file) && old.file !== file && !kept.some((e) => isRecord(e) && e.file === old.file);
  if (unused) rmSync(join(args.out, old.file), { force: true });
}
const order = (e) => `${e.kind === "portfolio" ? 0 : 1}:${e.savedAt}:${e.file}`;
const runs = [...kept, entry].sort((a, b) => order(a).localeCompare(order(b)));

writeFileSync(join(args.out, file), `${JSON.stringify(run, null, 1)}\n`);
writeFileSync(indexPath, `${JSON.stringify({ runs }, null, 2)}\n`);

const used = (name) => ROLES.reduce((total, role) => total + (isNumber(run.runs[role].usage?.[name]) ? run.runs[role].usage[name] : 0), 0);
console.log(`Packed ${join(args.out, file)}`);
console.log(`  kind ${entry.kind}, made ${savedAt}, model ${entry.model}`);
console.log(`  inputs: ${inputs.dataset}, ${inputs.buildings} buildings, total insured value KES ${inputs.totalTivKes}, reference fingerprint ${inputs.reference}`);
if (key !== null) console.log(`  offer key ${key}`);
console.log(`  tokens in ${used("promptTokens")}, out ${used("outputTokens")}, thinking ${used("thinkingTokens")}; result fingerprint ${run.fingerprint}`);
console.log(`  prompts ${args.dropPrompts ? "left out" : "kept"}; index.json now lists ${runs.length} run(s)`);
