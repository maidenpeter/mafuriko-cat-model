import { describe, expect, it } from "vitest";
import { BOOT_SCRIPT, DEFAULT_TEXT_SIZE, parseTextSize, parseTheme, TEXT_SIZE_KEY, TEXT_SIZES, textScale, THEME_KEY } from "../src/lib/display";

/**
 * Runs the <head> script the way a browser would, against a stand-in page and a stand-in
 * store, and returns the attributes it put on <html>. "blocked" is a browser whose storage
 * refuses to be read; "absent" is one with no storage at all.
 */
function boot(saved: Record<string, string> | "blocked" | "absent"): Record<string, string> {
  const attributes: Record<string, string> = {};
  const page = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
    },
  };
  const store = {
    getItem: (key: string) => {
      if (typeof saved === "string") throw new Error("storage is switched off");
      return saved[key] ?? null;
    },
  };
  new Function("document", "localStorage", BOOT_SCRIPT)(page, saved === "absent" ? undefined : store);
  return attributes;
}

describe("reader settings", () => {
  it("saves under the two agreed names", () => {
    expect(THEME_KEY).toBe("mafuriko-theme");
    expect(TEXT_SIZE_KEY).toBe("mafuriko-text-size");
  });

  it("accepts light and dark and nothing else", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("Dark")).toBeNull();
    expect(parseTheme("system")).toBeNull();
    expect(parseTheme("")).toBeNull();
    expect(parseTheme(null)).toBeNull();
    expect(parseTheme(undefined)).toBeNull();
  });

  it("accepts the three text sizes and nothing else", () => {
    expect(parseTextSize("standard")).toBe("standard");
    expect(parseTextSize("large")).toBe("large");
    expect(parseTextSize("larger")).toBe("larger");
    expect(parseTextSize("huge")).toBeNull();
    expect(parseTextSize("112.5")).toBeNull();
    expect(parseTextSize(null)).toBeNull();
    expect(parseTextSize(undefined)).toBeNull();
  });

  it("offers Standard 100%, Large 112.5% and Larger 125%, with Large as the default", () => {
    expect(TEXT_SIZES).toEqual([
      { value: "standard", label: "Standard", percent: 100 },
      { value: "large", label: "Large", percent: 112.5 },
      { value: "larger", label: "Larger", percent: 125 },
    ]);
    expect(DEFAULT_TEXT_SIZE).toBe("large");
  });

  it("turns a size into a multiplier for anything drawn in pixels", () => {
    expect(textScale("standard")).toBe(1);
    expect(textScale("large")).toBe(1.125);
    expect(textScale("larger")).toBe(1.25);
  });
});

describe("the script that runs before the page is drawn", () => {
  it("puts a saved theme and text size on <html>", () => {
    expect(boot({ "mafuriko-theme": "dark", "mafuriko-text-size": "larger" })).toEqual({ "data-theme": "dark", "data-text-size": "larger" });
    expect(boot({ "mafuriko-theme": "light", "mafuriko-text-size": "standard" })).toEqual({ "data-theme": "light", "data-text-size": "standard" });
  });

  it("sets each one on its own", () => {
    expect(boot({ "mafuriko-theme": "dark" })).toEqual({ "data-theme": "dark" });
    expect(boot({ "mafuriko-text-size": "large" })).toEqual({ "data-text-size": "large" });
  });

  it("sets nothing on a first visit, so the system theme and the Large size apply", () => {
    expect(boot({})).toEqual({});
  });

  it("ignores a saved value it does not know", () => {
    expect(boot({ "mafuriko-theme": "sepia", "mafuriko-text-size": "huge" })).toEqual({});
    // One bad value does not cost the reader the other setting.
    expect(boot({ "mafuriko-theme": "sepia", "mafuriko-text-size": "standard" })).toEqual({ "data-text-size": "standard" });
    expect(boot({ "mafuriko-theme": "dark", "mafuriko-text-size": "" })).toEqual({ "data-theme": "dark" });
  });

  it("does not stop the page when storage cannot be read", () => {
    expect(() => boot("blocked")).not.toThrow();
    expect(boot("blocked")).toEqual({});
    expect(() => boot("absent")).not.toThrow();
    expect(boot("absent")).toEqual({});
  });
});
