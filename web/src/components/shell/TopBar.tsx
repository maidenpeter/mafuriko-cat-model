import { STEP_NAMES, stepPlace, type StepId } from "@/lib/steps";
import { DisplayControls } from "../DisplayControls";
import { GUTTER } from "./layout";

/**
 * The top row of the header: the name of the demo, where the reader is, and the two display
 * settings. Nothing else sits here: every switch that changes a figure is in the control bar below.
 * `step` is the step on screen, or null while the model data panel stands in for it.
 */
export function TopBar({ step }: { step: StepId | null }) {
  return (
    <div className="bg-navy text-white">
      {/* One row from a tablet up. On a phone the brand and the settings keep the first row and the title takes a line of its own. */}
      <div className={`${GUTTER} flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 sm:flex-nowrap sm:gap-x-4`}>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
              <path d="M2 9c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" />
              <path d="M2 14c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" opacity="0.75" />
              <path d="M2 19c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" opacity="0.5" />
            </svg>
          </span>
          <div className="leading-tight">
            <div className="font-display text-lg font-semibold tracking-tight">Mafuriko</div>
            {/* Shown where the row has the room for it beside the title and the settings. */}
            <div className="hidden text-xs text-white/75 lg:block">A Nairobi centered CAT model</div>
          </div>
        </div>
        {/* Where the reader is. A plain label, not a heading: the step below carries the page's own title. */}
        <div className="order-last flex min-w-0 basis-full items-baseline gap-2 border-white/20 leading-tight sm:order-none sm:block sm:flex-1 sm:border-l sm:pl-4">
          {step && <div className="shrink-0 text-xs text-white/75">{stepPlace(step)}</div>}
          <div className="min-w-0 truncate font-display text-lg font-semibold tracking-tight">{step ? STEP_NAMES[step] : "Model data"}</div>
        </div>
        <DisplayControls className="ml-auto" />
      </div>
    </div>
  );
}
