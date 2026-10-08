"use client";

import { useSyncExternalStore } from "react";
import { currentTextSize, currentTheme, DEFAULT_TEXT_SIZE, subscribe, textScale, type TextSize, type Theme } from "./display";

/**
 * The theme on screen. On the server and during the first client render it reads "light";
 * the true value follows straight after, without a mismatch warning. The page itself is
 * already drawn in the right colours by then (see BOOT_SCRIPT), so only theme-dependent
 * markup such as the switch's icon catches up.
 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => "light");
}

export function useTextSize(): TextSize {
  return useSyncExternalStore(subscribe, currentTextSize, () => DEFAULT_TEXT_SIZE);
}

/** Multiplier for anything sized in pixels by code (chart labels and margins), so it grows with the text. */
export function useTextScale(): number {
  return textScale(useTextSize());
}
