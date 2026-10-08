/**
 * Reader settings: light or dark, and how large the text is. Both live as attributes on
 * <html> (data-theme, data-text-size) that globals.css styles against, and both are saved
 * in the browser so they come back on the next visit.
 *
 * No React in this file: the root layout reads BOOT_SCRIPT from it on the server.
 */

export type Theme = "light" | "dark";
export type TextSize = "standard" | "large" | "larger";

export const THEME_KEY = "mafuriko-theme";
export const TEXT_SIZE_KEY = "mafuriko-text-size";

/** The root font size for each choice. globals.css carries the same three figures. */
export const TEXT_SIZES: { value: TextSize; label: string; percent: number }[] = [
  { value: "standard", label: "Standard", percent: 100 },
  { value: "large", label: "Large", percent: 112.5 },
  { value: "larger", label: "Larger", percent: 125 },
];
export const DEFAULT_TEXT_SIZE: TextSize = "large";

export const parseTheme = (value: unknown): Theme | null => (value === "light" || value === "dark" ? value : null);
export const parseTextSize = (value: unknown): TextSize | null => TEXT_SIZES.find((s) => s.value === value)?.value ?? null;

/** How much larger than the browser's own size the text is: 1, 1.125 or 1.25. */
export const textScale = (size: TextSize): number => (TEXT_SIZES.find((s) => s.value === size)?.percent ?? 100) / 100;

/**
 * Runs in <head> before the page is first drawn, so a saved choice never flashes in late.
 * With nothing saved it does nothing: the theme then follows the system setting and the
 * text is Large, both from globals.css alone.
 */
export const BOOT_SCRIPT = `(function(){try{var d=document.documentElement,t=localStorage.getItem(${JSON.stringify(THEME_KEY)}),s=localStorage.getItem(${JSON.stringify(TEXT_SIZE_KEY)});if(t==="light"||t==="dark")d.setAttribute("data-theme",t);if(${TEXT_SIZES.map((x) => `s===${JSON.stringify(x.value)}`).join("||")})d.setAttribute("data-text-size",s)}catch(e){}})()`;

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

/** The theme on screen now: the reader's choice if there is one, otherwise the system setting. */
export function currentTheme(): Theme {
  return parseTheme(document.documentElement.dataset.theme) ?? (window.matchMedia(SYSTEM_DARK).matches ? "dark" : "light");
}

export function currentTextSize(): TextSize {
  return parseTextSize(document.documentElement.dataset.textSize) ?? DEFAULT_TEXT_SIZE;
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Storage can be switched off (private windows, locked-down browsers); the choice then lasts for the visit only. */
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the attribute on <html> already carries the choice for this visit.
  }
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  save(THEME_KEY, theme);
  emit();
}

export function setTextSize(size: TextSize) {
  document.documentElement.dataset.textSize = size;
  save(TEXT_SIZE_KEY, size);
  emit();
}

/** Calls back when either setting changes: from the switches, the system setting, or another tab. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const system = window.matchMedia(SYSTEM_DARK);
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY) {
      const theme = parseTheme(e.newValue);
      if (theme) document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
    } else if (e.key === TEXT_SIZE_KEY) {
      const size = parseTextSize(e.newValue);
      if (size) document.documentElement.dataset.textSize = size;
      else delete document.documentElement.dataset.textSize;
    } else return;
    listener();
  };
  system.addEventListener("change", listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    system.removeEventListener("change", listener);
    window.removeEventListener("storage", onStorage);
  };
}
