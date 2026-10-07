import { describe, expect, it } from "vitest";
import { fmtKes, fmtNum, fmtPct } from "../src/lib/format";

describe("number formatting", () => {
  it("drops trailing zeros only after a decimal point", () => {
    expect(fmtNum(4)).toBe("4");
    expect(fmtNum(0.7)).toBe("0.7");
    expect(fmtNum(1.25)).toBe("1.25");
    expect(fmtNum(10, 0)).toBe("10");
    expect(fmtNum(100, 0)).toBe("100");
    expect(fmtNum(250, 0)).toBe("250");
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(NaN)).toBe("n/a");
  });
  it("scales shillings to millions and billions", () => {
    expect(fmtKes(63_635_075_000)).toBe("KES 63.6bn");
    expect(fmtKes(162_750_000, 2)).toBe("KES 162.75m");
    expect(fmtKes(null)).toBe("n/a");
  });
  it("formats shares", () => {
    expect(fmtPct(0.0606, 2)).toBe("6.06%");
  });
});
