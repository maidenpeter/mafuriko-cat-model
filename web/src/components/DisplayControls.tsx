"use client";

import { useLayoutEffect, type KeyboardEvent } from "react";
import { parseTextSize, parseTheme, setTextSize, setTheme, TEXT_SIZE_KEY, TEXT_SIZES, THEME_KEY, type TextSize } from "@/lib/display";
import { useTextSize, useTheme } from "@/lib/useDisplay";

// One letter A per size, drawn larger for each step so the choice can be read without the label.
const LETTER: Record<TextSize, string> = { standard: "text-sm", large: "text-lg", larger: "text-2xl" };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/** Light or dark, and how large the text is. Sits at the right end of the navy top bar, so it is drawn in white. */
export function DisplayControls({ className = "" }: { className?: string }) {
  const theme = useTheme();
  const size = useTextSize();
  const other = theme === "dark" ? "light" : "dark";

  // React can rebuild <html> from what it rendered itself, which drops the attributes the script
  // in <head> set: in development when it remounts the page, and anywhere when it gives up on
  // the server's markup and draws the page again. The saved choice is put back here, before the
  // browser draws. Normally the attributes are already in place and this changes nothing.
  useLayoutEffect(() => {
    try {
      const root = document.documentElement;
      const savedTheme = parseTheme(localStorage.getItem(THEME_KEY));
      const savedSize = parseTextSize(localStorage.getItem(TEXT_SIZE_KEY));
      if (savedTheme && root.dataset.theme !== savedTheme) setTheme(savedTheme);
      if (savedSize && root.dataset.textSize !== savedSize) setTextSize(savedSize);
    } catch {
      // Storage is switched off: the system theme and the Large size stay.
    }
  }, []);

  // A radio group is worked with the arrow keys: the choice and the focus move together.
  const onArrow = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (move === 0) return;
    e.preventDefault();
    const from = TEXT_SIZES.findIndex((s) => s.value === size);
    const to = (from + move + TEXT_SIZES.length) % TEXT_SIZES.length;
    setTextSize(TEXT_SIZES[to].value);
    (e.currentTarget.children[to] as HTMLElement | undefined)?.focus();
  };

  return (
    <div className={`flex shrink-0 items-center gap-1.5 ${className}`}>
      {/* The words are for readers who do not know the icons; on a phone there is only room for the controls. */}
      <span aria-hidden className="hidden text-xs font-medium text-white/75 md:inline">Text size</span>
      <div role="radiogroup" aria-label="Text size" onKeyDown={onArrow} className="inline-flex rounded-full border border-white/30">
        {TEXT_SIZES.map((s) => {
          const checked = s.value === size;
          return (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`Text size: ${s.label}`}
              title={`Text size: ${s.label}`}
              tabIndex={checked ? 0 : -1}
              onClick={() => setTextSize(s.value)}
              className={`flex h-9 w-9 items-center justify-center rounded-full font-display leading-none transition ${LETTER[s.value]} ${FOCUS} ${checked ? "bg-white font-semibold text-navy" : "text-white/80 hover:bg-white/15 hover:text-white"}`}
            >
              <span aria-hidden>A</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => setTheme(other)}
        aria-label={`Switch to ${other} mode`}
        title={`Switch to ${other} mode`}
        className={`flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-full border border-white/30 px-2 text-white/80 transition hover:bg-white/15 hover:text-white md:ml-1.5 md:px-3 ${FOCUS}`}
      >
        {/* The icon shows what the button gives: a moon while the page is light, a sun while it is dark. */}
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
          {other === "dark" ? (
            <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" />
          ) : (
            <>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
            </>
          )}
        </svg>
        <span aria-hidden className="hidden text-sm md:inline">{other === "dark" ? "Dark mode" : "Light mode"}</span>
      </button>
    </div>
  );
}
