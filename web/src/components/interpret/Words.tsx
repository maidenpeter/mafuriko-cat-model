"use client";

/**
 * The two charts said in plain sentences, shown above each chart so that the answer can be read
 * without reading the bars:
 *
 *   ShapleyWords   what the agents' assumptions did to the loss in all, then one line for each group:
 *                  which figures moved, from what to what, and what that did. A group that lowers the
 *                  loss is named as such, so a bar to the left of zero is not taken for a fault.
 *   TornadoWords   the three assumptions the answer is most sensitive to, each with its allowed range
 *                  and how far the loss moves across it.
 *
 * Every figure is read from the result the chart draws: nothing is worked out again here.
 */

import { signedKes, type Measure } from "@/lib/dashboard";
import { PARAM_LABELS } from "@/lib/export";
import { fmtNum } from "@/lib/format";
import { flattenAssumptions, type Assumptions, type ShapleyResult, type TornadoRow } from "@/lib/interpret";
import { kes1 } from "@/lib/labels";
import { JUDGEMENT_LABELS, type OfferJudgement } from "@/lib/offer/judgement";

/** The name a reader knows a flat assumption by: "offer.uncertaintyLoading" is a judgement figure, anything else a model parameter. */
function nameOf(key: string): string {
  if (key.startsWith("offer.")) return JUDGEMENT_LABELS[key.slice("offer.".length) as keyof OfferJudgement] ?? key;
  return PARAM_LABELS[key] ?? key;
}

/** A value as written beside its name: whole numbers as they are, fractions to at most three places. */
const valueText = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "not set" : fmtNum(v, Number.isInteger(v) ? 0 : Math.abs(v) < 1 ? 3 : 2).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));

const MEASURE_WORDS: Record<Measure, string> = { aal: "ground-up average annual loss", loss100: "ground-up 1-in-100 loss" };
/** A figure named as a share is written as a percentage: 0.15 reads 15%. */
const shown = (key: string, v: number | undefined) => (v !== undefined && Number.isFinite(v) && /(share/.test(nameOf(key)) ? `${fmtNum(v * 100, Number.isInteger(Math.round(v * 1000) / 10) ? 0 : 1)}%` : valueText(v));
/** The name without its unit in brackets, which the percentage already says. */
const shortName = (key: string) => nameOf(key).replace(/s*(share[^)]*)s*$/, "");
const LIST = "mt-2 space-y-1.5 text-sm leading-relaxed text-ink-2";
const BOX = "mb-4 max-w-4xl rounded-xl border border-line bg-surface-2 px-4 py-3";

export function ShapleyWords({ result, measure, reference, agreed, subject }: { result: ShapleyResult; measure: Measure; reference: Assumptions; agreed: Assumptions; subject: string }) {
  const before = measure === "aal" ? result.reference.aalKes : result.reference.loss100Kes;
  const after = measure === "aal" ? result.agreed.aalKes : result.agreed.loss100Kes;
  const total = measure === "aal" ? result.totalAalKes : result.totalLoss100Kes;
  if (before === null || after === null || total === null) return null;
  const was = flattenAssumptions(reference);
  const now = flattenAssumptions(agreed);
  const groups = result.groups.map((g) => ({ g, value: measure === "aal" ? g.aalKes : g.loss100Kes })).filter((x): x is { g: ShapleyResult["groups"][number]; value: number } => x.value !== null);
  const lowers = groups.some((x) => x.value < -0.5);
  const raises = groups.some((x) => x.value > 0.5);
  return (
    <div className={BOX}>
      <p className="text-sm leading-relaxed text-ink">
        <strong className="font-semibold">In plain words.</strong> On the reference assumptions the {MEASURE_WORDS[measure]} of {subject} is {kes1(before)}. With the assumptions the agents agreed it is {kes1(after)}:{" "}
        {Math.abs(total) < 0.5 ? "no change" : `${kes1(Math.abs(total))} ${total > 0 ? "higher" : "lower"}`}. {groups.length === 0 ? "Nothing the agents changed reaches this figure." : "That change is made of these parts:"}
      </p>
      {groups.length > 0 && (
        <ul className={LIST}>
          {groups.map(({ g, value }) => {
            const moved = g.keysChanged.slice(0, 3).map((k) => `${shortName(k)}, from ${shown(k, was[k])} to ${shown(k, now[k])}`);
            const more = g.keysChanged.length - moved.length;
            return (
              <li key={g.id}>
                <strong className="font-semibold text-ink">{g.label}: {Math.abs(value) < 0.5 ? "no change" : `${value > 0 ? "adds" : "takes off"} ${kes1(Math.abs(value))}`}.</strong>{" "}
                The agents moved {moved.join("; ")}{more > 0 ? `; and ${more} more` : ""}. {value < -0.5 ? "These changes make the loss smaller, so this part is negative." : value > 0.5 ? "These changes make the loss larger." : ""}
              </li>
            );
          })}
        </ul>
      )}
      {lowers && raises && (
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          A negative part is not an error. The agents moved some assumptions towards a smaller loss and others towards a larger one; the parts are added with their signs, and together they give the whole change of {signedKes(total)}.
        </p>
      )}
    </div>
  );
}

export function TornadoWords({ rows, subject }: { rows: readonly TornadoRow[]; subject: string }) {
  const top = rows.filter((r) => (r.swing.loss100Kes ?? r.swing.aalKes) > 0.5).slice(0, 3);
  if (top.length === 0) return null;
  return (
    <div className={BOX}>
      <p className="text-sm leading-relaxed text-ink">
        <strong className="font-semibold">In plain words.</strong> Each assumption was moved on its own from the lowest value it is allowed to the highest, with everything else left as it is, and the loss of {subject} was worked out again each time. The answer depends most on these:
      </p>
      <ol className={`${LIST} list-decimal pl-5`}>
        {top.map((r) => (
          <li key={r.id}>
            <strong className="font-semibold text-ink">{r.label}</strong> (in force {r.baseText}; allowed {r.lowText} to {r.highText}): across that range the 1-in-100 loss moves by {r.swing.loss100Kes === null ? "an amount not modelled" : kes1(r.swing.loss100Kes)} and the average annual loss by {kes1(r.swing.aalKes)}.
          </li>
        ))}
      </ol>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">
        How to read a bar: zero is the answer as it stands now. A bar reaching left of zero means the loss would be lower with that assumption at one end of its range, so a negative figure is a saving against today&apos;s answer, not an error. A long bar is an assumption worth checking; a short one hardly matters.
      </p>
    </div>
  );
}
