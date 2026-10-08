import { fmtKes, fmtPct } from "../format";
import type { TermsResult } from "../model/terms";
import type { Check } from "./index";

/**
 * Checks on the insurance terms, recomputed from the layer figures themselves:
 * each layer can only take loss away, and what every party takes must add back up.
 */
export function termsChecks(t: TermsResult): Check[] {
  const group = "financial" as const;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  const rows = t.scenarios;
  const worst = rows[rows.length - 1];
  const out: Check[] = [];

  const grossOk = rows.every((r) => r.grossKes <= r.groundUpKes + 1e-6 && r.grossKes >= -1e-6);
  out.push({
    group, id: "gross-le-ground-up", title: "Gross loss is never above ground-up loss", status: grossOk ? "pass" : "fail",
    detail: worst ? `Rarest event: ground-up ${fmtKes(worst.groundUpKes)}, gross ${fmtKes(worst.grossKes)} after deductibles of ${fmtKes(worst.deductiblesKes)}.` : "No scenarios to check.",
  });

  const netOk = rows.every((r) => r.netKes <= r.grossKes + 1e-6 && r.netKes >= -1e-6);
  out.push({
    group, id: "net-le-gross", title: "Net loss is never above gross loss", status: netOk ? "pass" : "fail",
    detail: worst ? `Rarest event: gross ${fmtKes(worst.grossKes)}, net ${fmtKes(worst.netKes)}.` : "No scenarios to check.",
  });

  const policyOk = rows.every((r) => close(r.groundUpKes - r.deductiblesKes - r.overLimitKes, r.grossKes));
  const reinsuranceOk = rows.every(
    (r) => close(r.grossKes - r.quotaShareKes - r.xolKes, r.netKes) && close(r.quotaShareKes, t.terms.quotaShareCeded * r.grossKes) && r.xolKes >= -1e-6 && r.xolKes <= t.xol.limitKes + 1e-6,
  );
  out.push({
    group, id: "recoveries-reconcile", title: "Deductibles and recoveries add back up to the ground-up loss", status: policyOk && reinsuranceOk ? "pass" : "fail",
    detail: policyOk && reinsuranceOk
      ? `In all ${rows.length} events: ground-up less deductibles and amounts over limit equals gross; gross less the ${fmtPct(t.terms.quotaShareCeded, 0)} quota share and the excess of loss recovery equals net; no recovery exceeds the layer of ${fmtKes(t.xol.limitKes)}.`
      : "The layers do not reconcile in at least one event.",
  });

  const aalOk = t.aal.netKes <= t.aal.grossKes + 1e-6 && t.aal.grossKes <= t.aal.groundUpKes + 1e-6;
  out.push({
    group, id: "aal-order", title: "Average annual loss falls from ground-up to gross to net", status: aalOk ? "pass" : "fail",
    detail: `Ground-up ${fmtKes(t.aal.groundUpKes)}, gross ${fmtKes(t.aal.grossKes)}, net ${fmtKes(t.aal.netKes)}.`,
  });
  return out;
}
