import { kes1, perMille, PLACEHOLDER_RATE_LINE } from "@/lib/labels";
import { isPriced, type OfferFocus, type PricedFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import type { Active } from "@/lib/session";
import { InsuredValueFlag } from "../ui";
import { GUTTER } from "./layout";

interface Figure {
  label: string;
  value: string;
  /** The one figure of the row an underwriter looks for first. */
  strong?: boolean;
  /** A total of the portfolio's insured values: it carries the insured value flag. */
  insuredTotal?: boolean;
  /** A caution held on the figure, shown on hover and read by a screen reader, marked with the Assumption glyph. */
  note?: string;
}

/**
 * One figure. Side by side, a rule stands between two figures. The first has none while the label sits
 * on the line above, and takes one where the label stands beside it on the same row.
 */
const CELL =
  "min-w-0 border-line @3xl:border-l @3xl:pl-3 @3xl:first:border-l-0 @3xl:first:pl-0 @5xl:first:border-l @5xl:first:pl-3 @7xl:pl-5 @7xl:first:pl-5";

interface Props {
  /** The priced offer while the View switch is on Offer, and on a step without the switch: the row then shows its figures. null shows the portfolio's. */
  focus: PricedFocus | null;
  /** The offer whatever the view, priced or not. One that cannot be priced is named in a short chip. null when no offer has been read. */
  offerFocus: OfferFocus | null;
  /** The assumptions in force and the portfolio's result under them. */
  active: Active;
  /** How many buildings the portfolio holds. */
  buildings: number;
  /** The exposure file's insured values over their documented formula (session.report.tivRatio?.median): the total insured value carries the flag when they differ. */
  tivRatio?: number | null;
}

/**
 * The third row of the header: whose figures these are, then the four an underwriter looks for
 * first, kept in view on every step. They follow the switches in the control bar above, so the row
 * does not say again which settings are in force.
 */
export function FiguresRow({ focus, offerFocus, active, buildings, tivRatio }: Props) {
  const whose = focus ? "Offer" : "Portfolio";
  const name = focus ? (focus.line.insured ?? focus.building.name) : plural(buildings, "building");
  const figures = focus ? offerFigures(focus) : portfolioFigures(active);
  const waiting = focus ? null : notPriced(offerFocus);
  return (
    <div className="@container border-b border-line bg-plane/95 backdrop-blur">
      {/* Measured against the row in rem, so a larger text size keeps the smaller layout until the next one fits:
          the label over a two-by-two grid on a phone, the label over the four figures on a tablet, then one row. */}
      <div className={`${GUTTER} flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5 @7xl:gap-x-5`}>
        <p className="min-w-0 basis-full truncate text-sm text-ink-2 @5xl:max-w-72 @5xl:basis-auto" title={`${whose}: ${name}`}>
          {whose}: <strong className="font-semibold text-ink">{name}</strong>
        </p>
        <dl className="grid min-w-0 basis-full grid-cols-2 gap-x-3 gap-y-1.5 @3xl:flex @5xl:basis-auto @7xl:gap-x-5">
          {figures.map((x) => (
            <div key={x.label} className={CELL} title={x.note}>
              <dt className="text-xs text-muted">
                {x.label}
                {x.note && <span aria-hidden className="ml-1">△</span>}
                {x.note && <span className="sr-only">. {x.note}</span>}
              </dt>
              <dd className={`tabular text-base font-semibold ${x.strong ? "text-brand" : "text-ink"}`}>
                {x.value}
                {x.insuredTotal && <InsuredValueFlag ratio={tivRatio} inline className="ml-1.5 align-baseline" />}
              </dd>
            </div>
          ))}
        </dl>
        {waiting && <span className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-ink-2 @5xl:ml-auto">{waiting}</span>}
      </div>
    </div>
  );
}

/**
 * The offer's figures under the mode of the "Losses from" switch. Gross is after the policy deductible
 * and limit. With all loss drivers the rate is the flood premium's: modelled loss, uncertainty loading
 * and capital load, or the minimum rate where that is larger. With Depth only it is the pure rate.
 */
function offerFigures(focus: PricedFocus): Figure[] {
  const { total } = focus.price;
  const { premium } = focus.drivers;
  const rateLabel = focus.mode === "depth_only" ? "Pure flood rate" : premium.setBy === "minimum rate" ? "Flood rate, the minimum rate" : "Flood rate";
  return [
    { label: "Sum insured", value: kes1(total.tivKes) },
    { label: "1-in-100 gross loss", value: total.loss100GrossKes !== null ? kes1(total.loss100GrossKes) : "not modelled" },
    { label: "Average annual loss, gross", value: kes1(total.aalGrossKes) },
    { label: rateLabel, value: perMille(premium.floodRatePerMille), strong: true, note: focus.mode === "depth_only" ? undefined : PLACEHOLDER_RATE_LINE },
  ];
}

/** The portfolio's figures. The losses are ground-up: before any insurance terms. */
function portfolioFigures(active: Active): Figure[] {
  const r = active.result;
  const at = (returnPeriod: number) => {
    const loss = r.standardLosses.find((l) => l.returnPeriod === returnPeriod)?.lossKes;
    return loss != null ? kes1(loss) : "not modelled";
  };
  return [
    { label: "Total insured value", value: kes1(r.totalTivKes), insuredTotal: true },
    { label: "1-in-100 ground-up loss", value: at(100), strong: true },
    { label: "1-in-250 ground-up loss", value: at(250) },
    { label: "Average annual loss, ground-up", value: kes1(r.aalKes) },
  ];
}

/** The few words for an offer that is loaded and cannot be priced. null when there is no offer, it is priced, or it is still being placed on the map. */
function notPriced(offer: OfferFocus | null): string | null {
  if (!offer || isPriced(offer) || offer.status === "locating") return null;
  return offer.status === "outside" ? "Offer outside the hazard maps: not priced" : "Offer waiting for values";
}
