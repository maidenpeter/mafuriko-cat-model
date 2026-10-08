import { buildLedger, type Deliberation } from "./agents/orchestrate";
import { ROLE_LABELS, ROLES } from "./agents/schema";
import type { Check } from "./checks";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "./format";
import { hotspotHits } from "./model/hotspots";
import { REFERENCE_PARAMS } from "./model/params";
import { HOUSING_CLASSES, HOUSING_LABELS, SCORE_TIERS, type ModelParams } from "./model/types";
import { JRC_AFRICA_RESIDENTIAL } from "./model/vulnerability";
import { slim, type Active, type LogEntry, type Session } from "./session";

export const PARAM_LABELS: Record<string, string> = {
  depthScaleM: "Depth at score 1.0, widest tier (m)",
  ...Object.fromEntries(HOUSING_CLASSES.map((c) => [`fragility.${c}`, `Fragility: ${HOUSING_LABELS[c]}`])),
  ...Object.fromEntries(HOUSING_CLASSES.map((c) => [`cap.${c}`, `Damage cap: ${HOUSING_LABELS[c]}`])),
  ...Object.fromEntries(SCORE_TIERS.map((t) => [`returnPeriods.${t}`, `Return period: "${t}" tier (years)`])),
};

/** Parameters that have no effect on a depth dataset, where the data carries depths and return periods itself. */
export const unusedForDepth = (path: string) => path === "depthScaleM" || path.startsWith("returnPeriods.");

export const LIMITS = [
  "The hazard layer is a terrain-and-river proxy, not measured flooding. It cannot see drainage-driven flooding.",
  "Converting a susceptibility score to a depth is an assumption, not a measurement.",
  "The damage curve is a continental average (Africa, residential) adapted by judgement. No verified Kenya-specific curve exists.",
  "The return periods attached to the tiers are assumed.",
  "The portfolio is synthetic and randomly placed. It is not a real client's holdings.",
  "The scenarios are nested cuts of one map, not independent events.",
  "Average annual loss assumes no loss from events more frequent than the shortest return period, and a flat loss beyond the longest.",
];

/** The complete record of a run: inputs, assumptions, prompts, replies, results and checks. */
export function buildAudit(session: Session, active: Active, deliberation: Deliberation | null, checks: Check[], log: LogEntry[]) {
  return {
    generatedAt: new Date().toISOString(),
    notice: "Synthetic portfolio. Hazard is a proxy unless the dataset carries measured depths. Not a real client's holdings.",
    dataset: { name: session.dataset.name, hazardKind: session.dataset.hazardKind, scenarios: session.dataset.scenarios, buildings: session.dataset.buildings.length },
    ingest: session.report,
    assumptions: { source: active.source, applied: active.params, reference: REFERENCE_PARAMS, jrcCurve: JRC_AFRICA_RESIDENTIAL },
    results: {
      totalInsuredValueKes: active.result.totalTivKes,
      averageAnnualLossKes: active.result.aalKes,
      scenarios: active.result.scenarios,
      standardLosses: active.result.standardLosses,
      referenceScenarios: session.reference.scenarios.map((s) => ({ id: s.id, returnPeriod: s.returnPeriod, lossKes: s.lossKes })),
      buildings: active.result.buildings,
    },
    checks,
    agents: deliberation ? slim(deliberation) : null,
    limits: LIMITS,
    log,
  };
}

/** The short written note the hackathon asks for: data sources, assumptions, AI feature. */
export function buildNote(session: Session, active: Active, deliberation: Deliberation | null, checks: Check[]): string {
  const { dataset, report, reference } = session;
  const r = active.result;
  const p: ModelParams = active.params;
  const isScore = dataset.hazardKind === "score";
  const ledger = deliberation ? buildLedger(REFERENCE_PARAMS, deliberation).filter((row) => isScore || !unusedForDepth(row.path)) : [];
  const counts = { pass: checks.filter((c) => c.status === "pass").length, warn: checks.filter((c) => c.status === "warn").length, fail: checks.filter((c) => c.status === "fail").length };
  const rarest = r.scenarios[r.scenarios.length - 1];
  const refRarest = reference.scenarios[reference.scenarios.length - 1];

  const lines: string[] = [];
  lines.push(`# Mafuriko model note`, ``, `Dataset: **${dataset.name}** · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, ``);
  lines.push(`> The portfolio is synthetic. ${isScore ? "The hazard layer is a constructed proxy, not measured flood depth." : "The hazard layer is a published set of flood depth maps."} Nothing here describes a real client's holdings.`, ``);

  lines.push(`## 1. Data sources`, ``, `| File | Role | Real or synthetic |`, `|---|---|---|`);
  for (const f of report.files.filter((f) => f.used)) {
    lines.push(`| ${f.name} | ${f.note} | ${{ real: "Real data", proxy: "Derived proxy", synthetic: "Synthetic", none: "-" }[f.provenance]} |`);
  }
  lines.push(``, `Vulnerability reference: ${JRC_AFRICA_RESIDENTIAL.source}.`, ``);

  lines.push(`## 2. Assumptions`, ``);
  lines.push(`Assumptions in force: **${active.source === "ai" ? "agreed by the agent panel" : "reference values (no AI)"}**.`, ``);
  if (isScore) lines.push(`- Depth (m) = score × tier slope × ${fmtNum(p.depthScaleM)}. Each tier map is rescaled to run 0 to 1, so the tier slope (${r.scenarios.map((s) => `${s.id} ${fmtNum(s.tierSlope, 3)}`).join(", ")}) puts every tier back on the widest tier's scale and depth grows as the event gets rarer. The slopes are fitted from the maps. The score is a susceptibility proxy, so this conversion is assumed.`);
  if (dataset.drainage) {
    const dr = dataset.drainage;
    const withD = hotspotHits(dataset);
    const without = hotspotHits({ ...dataset, drainage: undefined });
    lines.push(
      `- Drainage-driven flooding: ponding of ${dataset.scenarios.map((sc, i) => `${fmtNum(dr.depthM[i])} m (${sc.id})`).join(", ")} within ${fmtNum(dr.reachM, 0)} m of OpenStreetMap drains, ditches and canals and inside informal settlements, fading to nothing at the edge of that reach. Each building takes the deeper of terrain depth and ponding. With it, ${withD.filter((h) => h.hit).length} of ${withD.length} county-named flood areas are flagged; terrain alone flags ${without.filter((h) => h.hit).length}. The reach and depths are assumptions.`,
    );
  }
  lines.push(`- Damage ratio = min( JRC curve( depth × fragility ), cap ), per construction class:`);
  for (const c of HOUSING_CLASSES) lines.push(`  - ${HOUSING_LABELS[c]}: fragility ${fmtNum(p.fragility[c])}, cap ${fmtNum(p.cap[c])}`);
  lines.push(`- Return periods: ${r.scenarios.map((s) => `${s.id} = ${s.returnPeriod} years`).join(", ")}${isScore ? " (assumed)" : " (from the data)"}.`);
  lines.push(`- Loss = damage ratio × insured value. Insured values are used as they appear in the file.`);
  if (report.tivRatio && Math.abs(report.tivRatio.median - 1) >= 0.05) {
    lines.push(`- **Data discrepancy:** insured values are ${fmtNum(report.tivRatio.median, 1)}× floor area × cost per m². The portfolio totals ${fmtKes(r.totalTivKes)}; the documented formula would give ${fmtKes(r.totalTivKes / report.tivRatio.median)}.`);
  }
  lines.push(``);

  lines.push(`## 3. Results`, ``, `| Return period | Scenario | Buildings affected | Loss | Share of insured value |`, `|---|---|---|---|---|`);
  for (const s of r.scenarios) lines.push(`| 1 in ${s.returnPeriod} | ${s.id} | ${fmtInt(s.affected)} of ${fmtInt(r.buildingCount)} | ${fmtKes(s.lossKes, 2)} | ${fmtPct(s.lossKes / r.totalTivKes, 2)} |`);
  lines.push(``, `Total insured value ${fmtKes(r.totalTivKes)} · average annual loss ${fmtKes(r.aalKes, 2)}.`, ``);

  lines.push(`## 4. AI feature`, ``);
  if (deliberation?.final) {
    lines.push(
      `Three agents ran in parallel (${deliberation.runs.optimist.model ?? "model"}): an Optimist and a Cautious voice each proposed a full set of assumptions with a reason per value, and a Critic challenged the data and the reference assumptions. Code ran the loss engine on both proposals. A Chair then settled the final set and answered each challenge. No agent produced a loss figure; all arithmetic is code.`,
      ``,
      `Effect on the output: the rarest scenario loss moved from ${fmtKes(refRarest.lossKes, 2)} on reference values to ${fmtKes(deliberation.final.result.scenarios[deliberation.final.result.scenarios.length - 1].lossKes, 2)} on the agreed values; average annual loss from ${fmtKes(reference.aalKes, 2)} to ${fmtKes(deliberation.final.result.aalKes, 2)}.`,
      ``,
    );
    const chair = deliberation.runs.chair.output;
    if (chair) lines.push(`Chair's summary: ${chair.summary}`, ``);
    lines.push(`| Parameter | Reference | Optimist | Cautious | Agreed | Reason |`, `|---|---|---|---|---|---|`);
    for (const row of ledger) lines.push(`| ${PARAM_LABELS[row.path]} | ${fmtNum(row.reference)} | ${row.optimist === null ? "-" : fmtNum(row.optimist)} | ${row.cautious === null ? "-" : fmtNum(row.cautious)} | ${fmtNum(row.final)} | ${row.reason.replaceAll("|", "/")} |`);
    lines.push(``);
    const critic = deliberation.runs.critic.output;
    if (critic && chair) {
      lines.push(`Critic's challenges and the Chair's answers:`, ``);
      for (const c of critic.challenges) {
        const a = chair.responses.find((x) => x.challengeId === c.id);
        lines.push(`- **${c.id} ${c.title}** (${c.severity}). ${c.detail} Answer: *${a ? `${a.verdict}: ${a.response}` : "not answered"}*`);
      }
      lines.push(``);
    }
    const failed = ROLES.filter((role) => deliberation.runs[role].status === "error");
    if (failed.length) lines.push(`Agents that did not return a valid reply: ${failed.map((f) => ROLE_LABELS[f]).join(", ")}.`, ``);
  } else {
    lines.push(`The agent panel was not run for this result. The figures above use reference values only, so the rarest scenario loss is ${fmtKes(rarest.lossKes, 2)}.`, ``);
  }

  lines.push(`## 5. Checks`, ``, `${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed.`, ``);
  for (const c of checks.filter((c) => c.status !== "pass")) lines.push(`- **${c.status === "warn" ? "Warning" : "Fail"}: ${c.title}.** ${c.detail}`);
  lines.push(``, `## 6. Limits`, ``);
  for (const l of LIMITS.filter((l) => isScore || !/score|tiers are assumed|proxy/.test(l))) lines.push(`- ${l}`);
  lines.push(``);
  return lines.join("\n");
}
