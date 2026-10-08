"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { LOSS_MODE_LABELS } from "@/lib/labels";
import type { LossMode } from "@/lib/model/drivers";
import type { HazardKind } from "@/lib/model/types";
import { isPriced, type OfferFocus } from "@/lib/offer/focus";
import { Button, Tag } from "../ui";
import { GUTTER } from "./layout";

/** Which view every step shows: the priced offer's building, or the whole portfolio. */
export type ViewMode = "offer" | "portfolio";

/**
 * The bar's own surface, lighter than the navy bar above it in both themes: white in the light theme.
 * In the dark theme the card colours are as dark as the navy, so the bar takes the axis grey there.
 * The two dark selectors are the ones globals.css sets the dark colours under.
 */
const BAR_SURFACE = "bg-surface [:root[data-theme=dark]_&]:bg-axis [@media(prefers-color-scheme:dark)]:[:root:not([data-theme=light])_&]:bg-axis";

interface Props {
  /** True once the model has loaded. Before that there is nothing to switch, and the bar holds the model data alone. */
  loaded: boolean;
  /** True on the steps that differ between the offer and the portfolio (STEPS_WITH_VIEW in lib/steps). */
  showView: boolean;
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
  /** The offer whatever the view, priced or not: it decides whether "Offer" can be chosen. null when no offer has been read. */
  offerFocus: OfferFocus | null;
  mode: LossMode;
  onMode: (mode: LossMode) => void;
  /** Whether drainage flooding is added to the terrain maps. null until the drainage zone has been worked out for this data set. */
  drainage: boolean | null;
  onDrainage: (on: boolean) => void;
  /** Whether the agents' agreed assumptions are in force. null until the agents have agreed a set. */
  useAi: boolean | null;
  onUseAi: (on: boolean) => void;
  /** The model data's name and where it came from: "Nairobi starter kit, from the model data folder". */
  dataLine: string;
  /** Why the built-in sample had to be used. Empty otherwise. */
  dataReason: string;
  /** What the hazard maps hold, for the badge. null before the model has loaded. */
  hazardKind: HazardKind | null;
  onReplaceData: () => void;
}

/**
 * The second row of the header: every switch that changes the figures on screen, each under its
 * caption, and the model data at the right end. The "View" switch here is the only place the
 * reader chooses between the offer and the portfolio.
 */
export function ControlBar({ loaded, showView, viewMode, onViewMode, offerFocus, mode, onMode, drainage, onDrainage, useAi, onUseAi, dataLine, dataReason, hazardKind, onReplaceData }: Props) {
  return (
    <div className={`border-b border-line ${BAR_SURFACE}`}>
      {/* The captions sit over the switches, not beside them, so all four switches keep one row on a laptop. Below that the row wraps. */}
      <div className={`${GUTTER} flex flex-wrap items-end gap-x-4 gap-y-2 py-1.5`}>
        {loaded && showView && (
          <Control caption="View">
            <BarSwitch
              label="Show the offer or the portfolio"
              value={viewMode}
              onChange={onViewMode}
              options={[
                { value: "offer", label: "Offer", off: offerOff(offerFocus) },
                { value: "portfolio", label: "Portfolio" },
              ]}
            />
          </Control>
        )}
        {/* What a loss comes from. Depth only is the model as it was; the default prices every driver. */}
        {loaded && (
          <Control caption="Losses from">
            <BarSwitch
              label="What a loss comes from"
              value={mode}
              onChange={onMode}
              options={[
                { value: "depth_only", label: LOSS_MODE_LABELS.depth_only },
                { value: "all_drivers", label: LOSS_MODE_LABELS.all_drivers },
              ]}
            />
          </Control>
        )}
        {loaded && drainage !== null && (
          <Control caption="Flood source">
            <BarSwitch
              label="Flood source"
              value={drainage ? "on" : "off"}
              onChange={(v) => onDrainage(v === "on")}
              options={[
                { value: "off", label: "Terrain only" },
                { value: "on", label: "Terrain + drainage" },
              ]}
            />
          </Control>
        )}
        {loaded && useAi !== null && (
          <Control caption="Assumptions">
            <BarSwitch
              label="Assumptions"
              value={useAi ? "ai" : "reference"}
              onChange={(v) => onUseAi(v === "ai")}
              options={[
                { value: "ai", label: "Agreed by agents" },
                { value: "reference", label: "Reference, no AI" },
              ]}
            />
          </Control>
        )}
        <ModelData line={dataLine} reason={dataReason} hazardKind={hazardKind} onReplace={onReplaceData} />
      </div>
    </div>
  );
}

/** Why the Offer side of the View switch is off, in a few words for its title. null when the offer is priced and can be shown. */
function offerOff(offer: OfferFocus | null): string | null {
  if (!offer) return "No offer read yet";
  if (isPriced(offer)) return null;
  if (offer.status === "outside") return "The offer is outside the hazard maps";
  if (offer.status === "locating") return "The offer is being placed on the map";
  return "The offer is waiting for values";
}

/** One switch under its small caption, so nobody has to guess what it is for. The switch carries its own name for a screen reader. */
function Control({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span aria-hidden className="pl-3 text-xs font-medium text-ink-2">{caption}</span>
      {children}
    </div>
  );
}

interface SwitchOption<T extends string> {
  value: T;
  label: string;
  /** Why this choice cannot be made now. It switches the choice off and is shown as its title. */
  off?: string | null;
}

/**
 * A switch on the control bar. Drawn like the Segmented control in ui.tsx and a little tighter, so four
 * of them fit one row; it is its own piece because a choice has to be switched off with its reason.
 */
function BarSwitch<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: SwitchOption<T>[]; onChange: (value: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap gap-0.5 rounded-full border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={!!o.off}
          title={o.off || undefined}
          onClick={() => onChange(o.value)}
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${o.value === value ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-2 enabled:hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The quiet control at the right end of the bar: a button that opens a small panel under itself with
 * the model data's name and origin, what kind of data it is, and the way to replace it. Escape, a
 * click outside or moving on with the keyboard closes the panel.
 */
function ModelData({ line, reason, hazardKind, onReplace }: { line: string; reason: string; hazardKind: HazardKind | null; onReplace: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (wrap.current?.contains(e.target as Node)) return;
      setOpen(false);
      // The click may have landed on nothing that takes the focus. It then goes back to the button, not to the top of the page.
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) button.current?.focus();
      });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div
      ref={wrap}
      className="relative ml-auto"
      onBlur={(e) => {
        // Tabbing past the panel's last control leaves it: close it behind the reader.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((was) => !was)}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink-2 transition hover:text-ink"
      >
        Model data
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {/* Hung under the button and never wider than a phone's screen less its gutters. The bar does not clip it. */}
      {open && (
        <div id={panelId} role="group" aria-label="Model data" className="absolute right-0 top-full z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-4 shadow-lg">
          <div className="text-xs font-medium text-muted">Model data</div>
          <p className="mt-0.5 text-sm font-semibold text-ink wrap-anywhere">{line}</p>
          {reason && <p className="mt-1.5 text-xs leading-relaxed text-ink-2 wrap-anywhere">{reason}</p>}
          {hazardKind && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Tag kind="synthetic">Synthetic portfolio</Tag>
              <Tag kind={hazardKind === "score" ? "proxy" : "real"}>{hazardKind === "score" ? "Proxy hazard, not measured" : "Published depth maps"}</Tag>
            </div>
          )}
          <Button
            variant="secondary"
            className="mt-4 w-full"
            onClick={() => {
              setOpen(false);
              button.current?.focus();
              onReplace();
            }}
          >
            Replace model data
          </Button>
        </div>
      )}
    </div>
  );
}
