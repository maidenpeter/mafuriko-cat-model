"use client";

/**
 * Exact Shapley attribution of what the agents changed: one bar per group of assumptions, the largest
 * share first, to the right of zero where the group adds to the loss and to the left where it takes
 * off, with the sign in words at the end of each bar; then the whole change as a hollow bar. A line
 * under the chart prints the shares added up beside the whole change, so the reader sees they are the
 * same figure. Drawn by hand in SVG like the other charts, inside a ChartFrame.
 *
 * How to use it (the sets are the ones the library documents):
 *   const target = useMemo(() => ({ kind: "portfolio", dataset }), [dataset]);
 *   const reference = useMemo(() => ({ params: REFERENCE_PARAMS, judgement: judgement.reference }), [judgement]);
 *   const agreed = useMemo(() => (final ? { params: final.params, judgement: judgement.assumed } : null), [final, judgement]);
 *   <Shapley target={target} reference={reference} agreed={agreed} mode={mode} subject="the portfolio" onOpenStep={onOpenStep} />
 *
 * The split runs through shapleyAsync in an effect, yielding to the page between model runs, with a
 * progress line while it works, cancelled when the inputs change or the chart leaves the screen. A
 * finished split is kept by its inputs, so the same inputs come back at once. `compact` draws the top
 * three groups, the rest as one bar and the whole change, with a pointer to the Agents step: the
 * Dashboard's form. useShapley is the hook on its own and ShapleyTable draws a result as a table, both
 * for the Audit step.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AGENTS_NOT_RUN, changeWords, MEASURE_LABELS, shapleyCells, shapleySumLine, shapleyTile, shapleyValue, signedKes, signedTicks, type Measure } from "@/lib/dashboard";
import { answerKey, shapleyAsync, SHAPLEY_TITLE, shapleyMethodLine, type Assumptions, type ShapleyResult, type Target } from "@/lib/interpret";
import { kes1, wrapLabel } from "@/lib/labels";
import type { LossMode } from "@/lib/model/drivers";
import type { StepId } from "@/lib/steps";
import { useTextScale } from "@/lib/useDisplay";
import { ShapleyWords } from "./Words";
import { ChartFrame, HatchPattern, type ChartSource, type LegendItem } from "../charts/ChartFrame";
import { Fold, Segmented, StatusIcon, StepLink } from "../ui";

/** Where the split stands: not asked for, running with its progress, finished, or failed. */
export type ShapleyState = { status: "none" } | { status: "running"; done: number; total: number } | { status: "done"; result: ShapleyResult } | { status: "error"; message: string };

// Finished splits by target, then by the two sets and the mode, so the same inputs come back without running again.
const finished = new WeakMap<Target, Map<string, ShapleyResult>>();

/**
 * The split for a target between the reference and the agreed set, run in the background. Any input
 * given as null gives "none". The sets are memoised by the caller; a change in them starts the split
 * again and cancels the one running.
 */
export function useShapley(target: Target | null, reference: Assumptions | null, agreed: Assumptions | null, mode: LossMode): ShapleyState {
  const key = target && reference && agreed ? `${answerKey(target, reference, mode)}|${answerKey(target, agreed, mode)}` : null;
  const known = target && key ? (finished.get(target)?.get(key) ?? null) : null;
  // Progress and the outcome are kept with the inputs they belong to, so a change of inputs never shows the old ones.
  const [progress, setProgress] = useState<{ key: string; done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<{ key: string; result: ShapleyResult | null; message: string | null } | null>(null);

  useEffect(() => {
    if (!target || !reference || !agreed || !key || known) return;
    const controller = new AbortController();
    shapleyAsync(target, reference, agreed, { mode, signal: controller.signal, onProgress: (done, total) => setProgress({ key, done, total }) })
      .then((result) => {
        let byKey = finished.get(target);
        if (!byKey) finished.set(target, (byKey = new Map()));
        byKey.set(key, result);
        setOutcome({ key, result, message: null });
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setOutcome({ key, result: null, message: error.message });
      });
    return () => controller.abort();
  }, [target, reference, agreed, mode, key, known]);

  if (!key) return { status: "none" };
  if (known) return { status: "done", result: known };
  if (outcome?.key === key) return outcome.result ? { status: "done", result: outcome.result } : { status: "error", message: outcome.message ?? "The split did not finish." };
  return { status: "running", done: progress?.key === key ? progress.done : 0, total: progress?.key === key ? progress.total : 0 };
}

/** The line shown while the split runs. */
export function ProgressLine({ state }: { state: Extract<ShapleyState, { status: "running" }> }) {
  return (
    <p className="flex items-center gap-2 text-sm leading-relaxed text-ink-2" aria-live="polite">
      <StatusIcon status="running" size={16} />
      <span>{state.total > 0 ? `Running ${state.done} of ${state.total} model runs` : "Starting the model runs"}</span>
    </p>
  );
}

interface Bar {
  id: string;
  label: string;
  /** A short second line under the label. */
  sub: string | null;
  value: number | null;
  kind: "share" | "others" | "total";
}

/** The bars in the order drawn: the groups largest first (or the tile's few), then the whole change. */
function barsOf(result: ShapleyResult, measure: Measure, compact: boolean): Bar[] {
  const total: Bar = { id: "total", label: "Whole change", sub: "agreed less reference", value: measure === "aal" ? result.totalAalKes : result.totalLoss100Kes, kind: "total" };
  if (compact) {
    const tile = shapleyTile(result, 3, measure);
    return [
      ...tile.shown.map((g): Bar => ({ id: g.id, label: g.label, sub: null, value: shapleyValue(g, measure), kind: "share" })),
      ...(tile.others ? [{ id: tile.others.id, label: tile.others.label, sub: null, value: shapleyValue(tile.others, measure), kind: "others" as const }] : []),
      total,
    ];
  }
  const size = (v: number | null) => Math.abs(v ?? 0);
  const ordered = [...result.groups].sort((a, b) => size(shapleyValue(b, measure)) - size(shapleyValue(a, measure)));
  return [...ordered.map((g): Bar => ({ id: g.id, label: g.label, sub: `${g.keysChanged.length} ${g.keysChanged.length === 1 ? "figure" : "figures"} moved`, value: shapleyValue(g, measure), kind: "share" })), total];
}

const ADDS = "var(--series-1)";
const TAKES_OFF = "var(--series-3)";
const LEGEND: LegendItem[] = [
  { label: "Adds to the loss", color: ADDS, mark: "bar" },
  { label: "Takes off the loss", color: TAKES_OFF, mark: "hatch" },
  { label: "Whole change", color: "var(--ink)", mark: "outline" },
];

interface Props {
  target: Target;
  reference: Assumptions;
  /** The set the agents settled. null until they have run: the chart then says so in one line. */
  agreed: Assumptions | null;
  mode: LossMode;
  /** Whose figures, for the subtitle: "this offer", "the portfolio". */
  subject: string;
  /** Where the figures come from beyond the two sets, for example the maps and the portfolio. */
  sources?: ChartSource[];
  /** The Dashboard's form: the top three groups, the rest as one bar, the whole change, and a pointer to the Agents step. */
  compact?: boolean;
  onOpenStep?: (id: StepId) => void;
  className?: string;
}

export function Shapley({ target, reference, agreed, mode, subject, sources = [], compact = false, onOpenStep, className = "" }: Props) {
  const state = useShapley(target, reference, agreed, mode);
  const [measure, setMeasure] = useState<Measure>("aal");
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const scale = useTextScale();
  const hatch = `shapley-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const result = state.status === "done" ? state.result : null;
  // The 1-in-100 loss can be shown only where a 1-in-100 flood is modelled under every combination.
  const shown: Measure = result && result.totalLoss100Kes === null ? "aal" : measure;
  const bars = result ? barsOf(result, shown, compact) : [];
  const allSources: ChartSource[] = [
    { kind: "ai", text: "The agreed set: the assumptions the agents chose, kept in range by code; every loss is computed by code" },
    { kind: "assumption", text: "The reference set, without the agents" },
    ...sources,
  ];

  const frame = (children: ReactNode, after: ReactNode = null) => (
    <section className={`min-w-0 ${compact ? "" : "rounded-2xl border border-line bg-surface p-5"} ${className}`}>
      <ChartFrame
        bare
        title={SHAPLEY_TITLE}
        subtitle={`Each bar is one group's exact share of what the agents changed in ${subject}'s ground-up ${MEASURE_LABELS[shown]}, largest first: to the right it adds to the loss, to the left it takes off. The last bar is the whole change, and the shares add up to it exactly.`}
        legend={bars.length > 0 ? LEGEND : undefined}
        sources={allSources}
        aside={
          !compact && result && result.totalLoss100Kes !== null ? (
            <Segmented<Measure>
              label="Which figure the shares are of"
              value={shown}
              onChange={setMeasure}
              options={[
                { value: "aal", label: "Average annual loss" },
                { value: "loss100", label: "1-in-100 loss" },
              ]}
            />
          ) : undefined
        }
      >
        {children}
      </ChartFrame>
      {after}
    </section>
  );

  if (!agreed || state.status === "none") return frame(<p className="text-sm leading-relaxed text-ink-2">{AGENTS_NOT_RUN}</p>);
  if (state.status === "running") return frame(<div ref={wrap}><ProgressLine state={state} /></div>);
  if (state.status === "error") return frame(<p className="text-sm leading-relaxed text-ink-2">The split could not be worked out. {state.message}</p>);
  if (!result) return null;

  const fontSize = 12 * scale;
  const charWidth = fontSize * 0.58;
  const lineHeight = fontSize * 1.3;
  const gap = 10 * scale;
  const barHeight = (compact ? 12 : 14) * scale;

  const longest = Math.max(...bars.map((b) => Math.max(b.label.length, b.sub?.length ?? 0)));
  const labelWidth = Math.min(longest * charWidth + gap, width * 0.36);
  const maxChars = Math.max(8, Math.floor((labelWidth - gap) / charWidth));
  const text = bars.map((b) => ({ lines: wrapLabel(b.label, maxChars, 2), sub: b.sub ? wrapLabel(b.sub, maxChars, 1)[0] : null }));
  const heights = text.map((t) => Math.max(barHeight + 12 * scale, (t.lines.length + (t.sub ? 1 : 0)) * lineHeight + 8 * scale));
  // The whole change stands apart from the shares: a gap and a rule before it.
  const breakAt = bars.findIndex((b) => b.kind === "total");
  const breakGap = 10 * scale;
  const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0) + (i >= breakAt ? breakGap : 0));
  const rowsHeight = heights.reduce((a, b) => a + b, 0) + breakGap;

  // The words at the end of a bar sit past the end on the bar's own side, so each side keeps room for the widest of them.
  const words = bars.map((b) => changeWords(b.value));
  const wordsWidth = Math.max(...words.map((w) => w.length)) * charWidth + 8 * scale;
  const values = bars.map((b) => b.value).filter((v): v is number => v !== null);
  const anyNegative = values.some((v) => v < 0);
  const anyPositive = values.some((v) => v >= 0);
  const left = anyNegative ? wordsWidth : 6 * scale;
  const right = anyPositive ? wordsWidth : 6 * scale;
  const plotWidth = Math.max(40, width - labelWidth - left - right);
  const ticks = signedTicks(Math.min(0, ...values), Math.max(0, ...values));
  const min = ticks[0];
  const max = ticks[ticks.length - 1];
  const sx = (v: number) => ((v - min) / (max - min || 1)) * plotWidth;
  const labelled: number[] = [];
  let edge = -Infinity;
  for (const t of ticks) {
    const half = (kes1(t).length * charWidth) / 2;
    if (sx(t) - half < edge) continue;
    labelled.push(t);
    edge = sx(t) + half + fontSize / 2;
  }
  const ox = labelWidth + left;
  const axisHeight = 24 * scale;
  const svgHeight = rowsHeight + axisHeight;

  const describe = (b: Bar, i: number) => `${b.label}${b.sub ? ` (${b.sub})` : ""}: ${words[i]} the ${MEASURE_LABELS[shown]}`;
  const hovered = active !== null && active < bars.length ? bars[active] : null;
  const cells = shapleyCells(result);
  const matches = shown === "aal" ? cells.matches.aal : cells.matches.loss100;

  const chart = (
    <div ref={wrap} className="w-full">
      <div className="relative">
        <svg width={width} height={svgHeight} role="img" aria-label={`${SHAPLEY_TITLE}. ${bars.map(describe).join(". ")}. ${shapleySumLine(result, shown)}`} className="block" onPointerLeave={() => setActive(null)}>
          <defs>
            <HatchPattern id={hatch} color={TAKES_OFF} size={6 * scale} />
          </defs>
          {ticks.map((t) => (
            <g key={t} transform={`translate(${ox + sx(t)},0)`}>
              <line y1={0} y2={rowsHeight} stroke={t === 0 ? "var(--axis)" : "var(--line)"} strokeWidth={t === 0 ? 1.5 : 1} />
              <line y1={rowsHeight} y2={rowsHeight + 5} stroke="var(--axis)" />
              {labelled.includes(t) && <text y={rowsHeight + 18 * scale} textAnchor="middle" fontSize={fontSize} fill="var(--muted)" className="tabular">{kes1(t)}</text>}
            </g>
          ))}
          {breakAt > 0 && <line x1={0} x2={width} y1={tops[breakAt] - breakGap / 2} y2={tops[breakAt] - breakGap / 2} stroke="var(--line)" strokeDasharray="3 3" />}
          {bars.map((b, i) => {
            const y = tops[i];
            const h = heights[i];
            const mid = y + h / 2;
            const v = b.value;
            const x1 = ox + sx(Math.min(0, v ?? 0));
            const x2 = ox + sx(Math.max(0, v ?? 0));
            const negative = v !== null && v < 0;
            const lines = text[i].lines;
            const count = lines.length + (text[i].sub ? 1 : 0);
            const first = mid - ((count - 1) * lineHeight) / 2;
            const fill = b.kind === "total" ? "var(--surface)" : b.kind === "others" ? "var(--muted)" : negative ? `url(#${hatch})` : ADDS;
            return (
              <g
                key={b.id}
                tabIndex={0}
                role="img"
                aria-label={describe(b, i)}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive((a) => (a === i ? null : a))}
              >
                <rect x={0} y={y} width={width} height={h} fill={active === i ? "var(--surface-2)" : "transparent"} />
                <text x={labelWidth - gap} textAnchor="end" fontSize={fontSize} fontWeight={b.kind === "total" ? 600 : 400}>
                  {lines.join(" ") !== b.label.trim().replace(/\s+/g, " ") && <title>{b.label}</title>}
                  {lines.map((line, n) => (
                    <tspan key={n} x={labelWidth - gap} y={first + n * lineHeight} dy="0.32em" fill="var(--ink)">{line}</tspan>
                  ))}
                  {text[i].sub && <tspan x={labelWidth - gap} y={first + lines.length * lineHeight} dy="0.32em" fill="var(--muted)" fontWeight={400}>{text[i].sub}</tspan>}
                </text>
                {v === null ? (
                  <text x={ox + sx(0) + 4 * scale} y={mid} dy="0.32em" fontSize={fontSize} fill="var(--muted)">not modelled</text>
                ) : (
                  <>
                    {/* A share of nothing still shows a hairline at zero, so the row does not read as empty. */}
                    <rect
                      x={x1}
                      y={mid - barHeight / 2}
                      width={Math.max(x2 - x1, 2)}
                      height={barHeight}
                      rx={2}
                      fill={fill}
                      stroke={b.kind === "total" ? "var(--ink)" : negative ? TAKES_OFF : "none"}
                      strokeWidth={b.kind === "total" ? 2 : negative ? 1.25 : 0}
                    />
                    <text
                      x={negative ? x1 - 4 * scale : Math.max(x2, x1 + 2) + 4 * scale}
                      y={mid}
                      dy="0.32em"
                      textAnchor={negative ? "end" : "start"}
                      fontSize={fontSize}
                      fontWeight={b.kind === "total" ? 600 : 400}
                      fill="var(--ink)"
                      className="tabular"
                    >
                      {words[i]}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>

        {hovered && active !== null && (
          // 15.625rem is the tooltip's width (w-60) plus a small gap, so it stops short of the right edge at every text size.
          <div
            className="pointer-events-none absolute z-10 w-60 max-w-full rounded-xl border border-line bg-surface p-3 text-sm shadow-lg"
            style={{ left: `clamp(0px, ${(labelWidth + 8).toFixed(1)}px, calc(100% - 15.625rem))`, ...(active < bars.length / 2 ? { top: tops[active] + heights[active] } : { bottom: svgHeight - tops[active] }) }}
          >
            <div className="mb-1.5 wrap-anywhere font-semibold text-ink">{hovered.label}</div>
            <div className="flex items-baseline justify-between gap-3 py-0.5 text-ink-2">
              <span>Average annual loss</span>
              <span className="tabular whitespace-nowrap font-medium text-ink">{signedKes(hovered.kind === "total" ? result.totalAalKes : bars.find((x) => x.id === hovered.id) && shown === "aal" ? hovered.value : valueOn(result, hovered, "aal"))}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-0.5 text-ink-2">
              <span>1-in-100 loss</span>
              <span className="tabular whitespace-nowrap font-medium text-ink">{signedKes(hovered.kind === "total" ? result.totalLoss100Kes : shown === "loss100" ? hovered.value : valueOn(result, hovered, "loss100"))}</span>
            </div>
            {hovered.sub && <div className="mt-1 border-t border-line pt-1 wrap-anywhere text-ink-2">{hovered.sub}</div>}
          </div>
        )}
      </div>
      {/* The axis title is page text, not SVG text, so it wraps under a narrow plot instead of being clipped. */}
      <div className="mt-1 text-center text-xs text-ink-2" style={{ paddingLeft: labelWidth, paddingRight: right }}>
        Share of the change in the ground-up {MEASURE_LABELS[shown]} (KES)
      </div>
      <p className="mt-3 flex max-w-3xl items-start gap-2 text-sm leading-relaxed text-ink">
        <span className="mt-0.5"><StatusIcon status={matches === false ? "warn" : "pass"} size={16} /></span>
        <span className="min-w-0">{shapleySumLine(result, shown)}</span>
      </p>
    </div>
  );

  return frame(
    <>
      {!compact && <ShapleyWords result={result} measure={shown} reference={reference} agreed={agreed} subject={subject} />}
      {chart}
    </>,
    <>
      <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">{shapleyMethodLine(result)}</p>
      {cells.dropped && <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">{cells.dropped}</p>}
      {compact ? (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Every group, with the method and the table, is in <StepLink to="agents" onOpenStep={onOpenStep} />.
        </p>
      ) : (
        <Fold summary="The same figures as a table" className="mt-2">
          <ShapleyTable result={result} />
        </Fold>
      )}
    </>,
  );
}

/** A bar's figure on the measure not on screen: its group's, or the sum of the groups folded into "others". */
function valueOn(result: ShapleyResult, bar: Bar, measure: Measure): number | null {
  if (bar.kind === "others") {
    const tile = shapleyTile(result, 3, measure === "aal" ? "loss100" : "aal");
    return tile.others ? shapleyValue(tile.others, measure) : null;
  }
  const group = result.groups.find((g) => g.id === bar.id);
  return group ? shapleyValue(group, measure) : null;
}

/** The split as a table: each group's share of both figures, then the shares added up beside the whole change. */
export function ShapleyTable({ result, caption, className = "" }: { result: ShapleyResult; caption?: ReactNode; className?: string }) {
  const cells = shapleyCells(result);
  return (
    <div className={className}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-sm">
          {caption && <caption className="pb-2 text-left text-sm font-medium text-ink">{caption}</caption>}
          <thead className="text-xs text-muted">
            <tr>
              {cells.head.map((h, i) => (
                <th key={h} scope="col" className={`pb-2 font-medium ${i > 0 ? "pl-3 text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {cells.rows.map((row) => (
              <tr key={row[0]}>
                <th scope="row" className="py-1.5 text-left font-normal text-ink">{row[0]}</th>
                <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right text-ink">{row[1]}</td>
                <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right text-ink">{row[2]}</td>
              </tr>
            ))}
            {[cells.sum, cells.total].map((row, i) => (
              <tr key={row[0]} className={i === 0 ? "border-t-2 border-axis" : ""}>
                <th scope="row" className="py-1.5 text-left font-semibold text-ink">{row[0]}</th>
                <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right font-semibold text-ink">{row[1]}</td>
                <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right font-semibold text-ink">{row[2]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 flex max-w-3xl items-start gap-2 text-xs leading-relaxed text-muted">
        <span className="mt-0.5"><StatusIcon status={cells.matches.aal ? "pass" : "warn"} size={14} /></span>
        <span className="min-w-0">
          {cells.matches.aal ? "The shares add up to the whole change." : "The shares do not add up to the whole change: a fault in the arithmetic to report."} {cells.dropped}
        </span>
      </p>
    </div>
  );
}
