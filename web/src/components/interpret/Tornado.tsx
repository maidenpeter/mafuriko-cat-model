"use client";

/**
 * The sensitivity tornado: each assumption swung on its own across its stated range, one row per
 * assumption, the one that moves the answer most first. Two panels share the rows, one for the change
 * in the ground-up 1-in-100 loss and one for the change in the ground-up average annual loss, each on
 * its own axis, because one is the loss of a single flood and the other a yearly average. A bar runs
 * from the answer with the assumption at the bottom of its range to the answer with it at the top,
 * through the figure in force at zero, and its ends carry the values used. The two measures are told
 * apart by hatching as well as colour. Drawn by hand in SVG like the other charts, inside a ChartFrame.
 *
 * How to use it:
 *   const target = useMemo(() => offerTarget(focus, session.dataset), [focus, session.dataset]);   or { kind: "portfolio", dataset }
 *   const base = useMemo(() => ({ params: active.params, judgement: judgement.assumed }), [active.params, judgement]);
 *   <Tornado target={target} base={base} mode={mode} subject="this offer" sources={[...]} />
 *
 * The library's tornado() is synchronous and memoised on the target, so the rows are worked out in a
 * useMemo: two runs of the model per row the first time, nothing after. useTornado gives the same rows
 * to a screen that needs them beside the chart; TornadoTable draws rows as a table, for the Audit step.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { signedKes, signedTicks, swingValueText, TORNADO_HEAD, tornadoCells } from "@/lib/dashboard";
import { notLiveWhy, tornado, TORNADO_TITLE, tornadoMethodLine, tornadoPlan, type Assumptions, type Target, type TornadoRow } from "@/lib/interpret";
import { kes1, wrapLabel } from "@/lib/labels";
import type { LossMode } from "@/lib/model/drivers";
import { useTextScale } from "@/lib/useDisplay";
import { TornadoWords } from "./Words";
import { ChartFrame, HatchPattern, type ChartSource, type LegendItem } from "../charts/ChartFrame";
import { Fold } from "../ui";

type Measure = "loss100" | "aal";

interface Panel {
  id: Measure;
  /** The legend entry. */
  label: string;
  /** The axis title, with units. */
  axis: string;
  color: string;
  hatch: boolean;
}

const PANELS: Panel[] = [
  { id: "loss100", label: "Change in the 1-in-100 loss", axis: "Change in the ground-up 1-in-100 loss (KES)", color: "var(--series-1)", hatch: false },
  { id: "aal", label: "Change in the average annual loss", axis: "Change in the ground-up average annual loss (KES)", color: "var(--series-2)", hatch: true },
];

const LEGEND: LegendItem[] = PANELS.map((p) => ({ label: p.label, color: p.color, mark: p.hatch ? "hatch" : "bar" }));

/** The answer's move at one end of a swing, on one measure. null where a 1-in-100 flood is not modelled. */
const changeAt = (row: TornadoRow, side: "low" | "high", measure: Measure): number | null => (measure === "loss100" ? row[side].loss100ChangeKes : row[side].aalChangeKes);
const answerAt = (row: TornadoRow, side: "low" | "high", measure: Measure): number | null => (measure === "loss100" ? row[side].loss100Kes : row[side].aalKes);

/** The rows of the tornado for a target under the base assumptions, worked out once per target, base and mode. */
export function useTornado(target: Target | null, base: Assumptions | null, mode: LossMode): TornadoRow[] {
  return useMemo(() => (target && base ? tornado(target, base, { mode }) : []), [target, base, mode]);
}

interface Props {
  target: Target;
  base: Assumptions;
  mode: LossMode;
  /** Whose answer, for the subtitle: "this offer", "the portfolio". */
  subject: string;
  /** Where the figures come from: the maps, the portfolio, the assumptions in force. The swung ranges are added here. */
  sources: ChartSource[];
  className?: string;
}

export function Tornado({ target, base, mode, subject, sources, className = "" }: Props) {
  const rows = useTornado(target, base, mode);
  const leftOut = useMemo(() => tornadoPlan(target, base, { mode }).leftOut, [target, base, mode]);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const scale = useTextScale();
  // React ids can hold characters that are not safe inside url(#...).
  const hatch = `tornado-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    if (!wrap.current) return;
    // The chart is as wide as its card, so it never pushes the page sideways. The floor only covers a card too narrow to draw in.
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const allSources: ChartSource[] = [...sources, { kind: "assumption", text: "The swung ranges are the ranges the agents are allowed; every other assumption stays as it is in force" }];
  const frame = (children: ReactNode, after: ReactNode = null) => (
    <section className={`min-w-0 rounded-2xl border border-line bg-surface p-5 ${className}`}>
      <ChartFrame
        bare
        title={TORNADO_TITLE}
        subtitle={`One row per assumption behind ${subject}'s ground-up loss, the one that moves it most first. A bar runs from the answer with the assumption at the bottom of its allowed range to the answer with it at the top; zero is the answer in force, and the values used are written at the ends.`}
        legend={rows.length > 0 ? LEGEND : undefined}
        sources={allSources}
      >
        {children}
      </ChartFrame>
      {after}
    </section>
  );

  if (rows.length === 0) return frame(<p className="text-sm leading-relaxed text-ink-2">{notLiveWhy(target, mode)}</p>);

  // Where a 1-in-100 flood is more frequent than anything modelled there is no 1-in-100 panel to draw.
  const panels = PANELS.filter((p) => p.id === "aal" || rows.some((r) => r.swing.loss100Kes !== null));

  // SVG labels and the room around the plot are sized in pixels, so both are multiplied up to follow the text size.
  const fontSize = 12 * scale;
  const charWidth = fontSize * 0.58;
  const lineHeight = fontSize * 1.3;
  const gap = 10 * scale;
  const barHeight = 13 * scale;
  const iconRoom = 16 * scale;

  // The label column takes what its longest label needs, up to a third of the chart. A label that does not fit wraps, then is cut short with its full wording in a title.
  const longest = Math.max(...rows.map((r) => r.label.length));
  const labelWidth = Math.min(longest * charWidth + gap + iconRoom, width * 0.34);
  const maxChars = Math.max(8, Math.floor((labelWidth - gap - iconRoom) / charWidth));
  const text = rows.map((r) => ({ lines: wrapLabel(r.label, maxChars, 2), base: `In force ${swingValueText(r.unit, r.baseValue, true)}` }));
  const heights = text.map((t) => Math.max(barHeight + 12 * scale, (t.lines.length + 1) * lineHeight + 8 * scale));
  const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0));
  const rowsHeight = heights.reduce((a, b) => a + b, 0);

  // The two panels sit side by side where there is room, otherwise one under the other with the labels repeated.
  const stacked = width < 760 && panels.length > 1;
  const panelGap = 28 * scale;
  const panelWidth = stacked || panels.length === 1 ? width - labelWidth : (width - labelWidth - panelGap) / 2;
  const ends = rows.map((r) => ({ low: swingValueText(r.unit, r.lowValue, true), high: swingValueText(r.unit, r.highValue, true) }));
  // Each panel keeps room at both sides for the values written past the ends of its widest bars.
  const endWidth = Math.max(...ends.flatMap((e) => [e.low.length, e.high.length])) * charWidth + 8 * scale;
  const plotWidth = Math.max(40, panelWidth - 2 * endWidth);
  const headHeight = 2 * lineHeight + 6 * scale;
  const axisHeight = 24 * scale;
  const blockHeight = headHeight + rowsHeight + axisHeight;
  const svgHeight = stacked ? panels.length * blockHeight + (panels.length - 1) * panelGap : blockHeight;

  const scales = panels.map((p) => {
    const values = rows.flatMap((r) => [changeAt(r, "low", p.id), changeAt(r, "high", p.id)]).filter((v): v is number => v !== null);
    const ticks = signedTicks(Math.min(0, ...values), Math.max(0, ...values));
    const min = ticks[0];
    const max = ticks[ticks.length - 1];
    const sx = (v: number) => ((v - min) / (max - min || 1)) * plotWidth;
    // On a narrow panel the tick labels would run into each other. A label that does not fit is left out; its grid line stays.
    const labelled: number[] = [];
    let edge = -Infinity;
    for (const t of ticks) {
      const half = (kes1(t).length * charWidth) / 2;
      if (sx(t) - half < edge) continue;
      labelled.push(t);
      edge = sx(t) + half + fontSize / 2;
    }
    return { ...p, ticks, labelled, sx };
  });

  const money = (v: number | null) => (v === null ? "not modelled" : kes1(v));
  const describe = (r: TornadoRow, i: number) =>
    `${r.label}: in force ${swingValueText(r.unit, r.baseValue)}, swung from ${ends[i].low} to ${ends[i].high}. 1-in-100 loss ${money(answerAt(r, "low", "loss100"))} to ${money(answerAt(r, "high", "loss100"))}; average annual loss ${money(answerAt(r, "low", "aal"))} to ${money(answerAt(r, "high", "aal"))}${r.note ? `. ${r.note}` : ""}`;
  const hovered = active !== null && active < rows.length ? rows[active] : null;

  const chart = (
    <div ref={wrap} className="w-full">
      <div className="relative">
        <svg width={width} height={svgHeight} role="img" aria-label={`${TORNADO_TITLE}. ${rows.map(describe).join(". ")}`} className="block" onPointerLeave={() => setActive(null)}>
          <defs>
            <HatchPattern id={hatch} color={PANELS[1].color} size={6 * scale} />
          </defs>
          {scales.map((p, k) => {
            const ox = labelWidth + (stacked ? 0 : k * (panelWidth + panelGap)) + endWidth;
            const oy = stacked ? k * (blockHeight + panelGap) : 0;
            const top = oy + headHeight;
            const withLabels = stacked || k === 0;
            const axisLines = wrapLabel(p.axis, Math.max(8, Math.floor(panelWidth / charWidth)), 2);
            return (
              <g key={p.id}>
                <text x={ox - endWidth + panelWidth / 2} textAnchor="middle" fontSize={fontSize} fill="var(--ink-2)">
                  {axisLines.map((line, n) => (
                    <tspan key={n} x={ox - endWidth + panelWidth / 2} y={oy + (n + 0.9) * lineHeight}>{line}</tspan>
                  ))}
                </text>
                {p.ticks.map((t) => (
                  <g key={t} transform={`translate(${ox + p.sx(t)},${top})`}>
                    <line y1={0} y2={rowsHeight} stroke={t === 0 ? "var(--axis)" : "var(--line)"} strokeWidth={t === 0 ? 1.5 : 1} />
                    <line y1={rowsHeight} y2={rowsHeight + 5} stroke="var(--axis)" />
                    {p.labelled.includes(t) && <text y={rowsHeight + 18 * scale} textAnchor="middle" fontSize={fontSize} fill="var(--muted)" className="tabular">{kes1(t)}</text>}
                  </g>
                ))}
                {rows.map((r, i) => {
                  const y = top + tops[i];
                  const h = heights[i];
                  const mid = y + h / 2;
                  const lowC = changeAt(r, "low", p.id);
                  const highC = changeAt(r, "high", p.id);
                  const drawn = lowC !== null && highC !== null;
                  const x1 = ox + p.sx(drawn ? Math.min(lowC, highC) : 0);
                  const x2 = drawn ? ox + p.sx(Math.max(lowC, highC)) : x1;
                  // The low value's end is the left end unless the low value raises the answer more than the high one.
                  const lowLeft = !drawn || lowC <= highC;
                  const leftText = lowLeft ? ends[i].low : ends[i].high;
                  const rightText = lowLeft ? ends[i].high : ends[i].low;
                  const lines = text[i].lines;
                  const first = mid - (lines.length * lineHeight) / 2;
                  return (
                    <g
                      key={r.id}
                      tabIndex={0}
                      role="img"
                      aria-label={describe(r, i)}
                      onPointerEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      onBlur={() => setActive((a) => (a === i ? null : a))}
                    >
                      {/* The band is the hover and focus target for the whole row of this panel, label included. */}
                      <rect x={withLabels ? 0 : ox - endWidth} y={y} width={withLabels ? labelWidth + panelWidth : panelWidth} height={h} fill={active === i ? "var(--surface-2)" : "transparent"} />
                      {withLabels && (
                        <>
                          <text x={labelWidth - gap} textAnchor="end" fontSize={fontSize}>
                            {/* A label cut short keeps its full wording in a title. */}
                            {lines.join(" ") !== r.label.trim().replace(/\s+/g, " ") && <title>{r.label}</title>}
                            {lines.map((line, n) => (
                              <tspan key={n} x={labelWidth - gap} y={first + n * lineHeight} dy="0.32em" fill="var(--ink)">{line}</tspan>
                            ))}
                            <tspan x={labelWidth - gap} y={first + lines.length * lineHeight} dy="0.32em" fill="var(--muted)" className="tabular">{text[i].base}</tspan>
                          </text>
                          {r.note && (
                            <g>
                              <title>{r.note}</title>
                              <circle cx={7 * scale} cy={mid} r={6 * scale} fill="var(--surface-2)" stroke="var(--axis)" strokeWidth={1} />
                              <text x={7 * scale} y={mid} dy="0.34em" textAnchor="middle" fontSize={fontSize * 0.85} fontWeight={600} fill="var(--ink-2)">i</text>
                            </g>
                          )}
                        </>
                      )}
                      {drawn ? (
                        <>
                          {/* A swing of nothing still shows a hairline at zero, so the row does not read as empty. */}
                          <rect x={x1} y={mid - barHeight / 2} width={Math.max(x2 - x1, 2)} height={barHeight} rx={2} fill={p.hatch ? `url(#${hatch})` : p.color} stroke={p.hatch ? p.color : "none"} strokeWidth={p.hatch ? 1.25 : 0} />
                          <text x={x1 - 4 * scale} y={mid} dy="0.32em" textAnchor="end" fontSize={fontSize} fill="var(--ink-2)" className="tabular">{leftText}</text>
                          <text x={Math.max(x2, x1 + 2) + 4 * scale} y={mid} dy="0.32em" textAnchor="start" fontSize={fontSize} fill="var(--ink-2)" className="tabular">{rightText}</text>
                        </>
                      ) : (
                        <text x={x1 + 4 * scale} y={mid} dy="0.32em" fontSize={fontSize} fill="var(--muted)">not modelled</text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>

        {hovered && active !== null && (
          // Rows in the top half show the tooltip under them, the rest above, so it stays inside the chart.
          // 18.5rem is the tooltip's width (w-72) plus a small gap, so it stops short of the right edge at every text size.
          <div
            className="pointer-events-none absolute z-10 w-72 max-w-full rounded-xl border border-line bg-surface p-3 text-sm shadow-lg"
            style={{
              left: `clamp(0px, ${(labelWidth + 8).toFixed(1)}px, calc(100% - 18.5rem))`,
              ...(active < rows.length / 2 ? { top: headHeight + tops[active] + heights[active] } : { bottom: svgHeight - (headHeight + tops[active]) }),
            }}
          >
            <div className="wrap-anywhere font-semibold text-ink">{hovered.label}</div>
            <div className="text-ink-2">In force: {swingValueText(hovered.unit, hovered.baseValue)}</div>
            {panels.map((p) => (
              <div key={p.id} className="mt-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">{p.label}</div>
                {(["low", "high"] as const).map((side) => (
                  <div key={side} className="flex items-baseline justify-between gap-3 py-0.5 text-ink-2">
                    <span className="min-w-0">At {ends[active][side]}</span>
                    <span className="tabular whitespace-nowrap font-medium text-ink">
                      {money(answerAt(hovered, side, p.id))} <span className="font-normal text-ink-2">({signedKes(changeAt(hovered, side, p.id))})</span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {hovered.note && <div className="mt-1 border-t border-line pt-1 wrap-anywhere text-ink-2">{hovered.note}</div>}
          </div>
        )}
      </div>
    </div>
  );

  // What was left out and why, grouped by the reason so each is said once.
  const reasons = [...new Set(leftOut.map((x) => x.why))];

  return frame(
    <>
      <TornadoWords rows={rows} subject={subject} />
      {chart}
    </>,
    <>
      <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">{tornadoMethodLine(rows)}</p>
      {reasons.map((why) => (
        <p key={why} className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">
          Not swung: {leftOut.filter((x) => x.why === why).map((x) => x.label).join("; ")}. {why}
        </p>
      ))}
      <Fold summary="The same figures as a table" className="mt-2">
        <TornadoTable rows={rows} />
      </Fold>
    </>,
  );
}

/** The tornado's rows as a table: the assumption, the values used, and the change in each figure from the low value to the high one. */
export function TornadoTable({ rows, caption, className = "" }: { rows: readonly TornadoRow[]; caption?: ReactNode; className?: string }) {
  const cells = tornadoCells(rows);
  if (cells.length === 0) return null;
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full min-w-[54rem] text-sm">
        {caption && <caption className="pb-2 text-left text-sm font-medium text-ink">{caption}</caption>}
        <thead className="text-xs text-muted">
          <tr>
            {TORNADO_HEAD.map((h, i) => (
              <th key={h} scope="col" className={`pb-2 font-medium ${i > 0 ? "pl-3" : ""} ${i >= 4 ? "text-right" : "text-left"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {cells.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="py-1.5 text-left align-top font-normal text-ink">
                {c.assumption}
                {c.note && <span className="block max-w-md text-xs leading-relaxed text-muted">{c.note}</span>}
              </th>
              <td className="tabular py-1.5 pl-3 align-top text-ink-2">{c.inForce}</td>
              <td className="tabular py-1.5 pl-3 align-top text-ink-2">{c.low}</td>
              <td className="tabular py-1.5 pl-3 align-top text-ink-2">{c.high}</td>
              <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right align-top font-semibold text-ink">{c.change100}</td>
              <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right align-top font-semibold text-ink">{c.changeAal}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
