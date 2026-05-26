import { describe, expect, it } from "vitest";
import {
  MONEY_UNIT,
  SATS_PER_BTC,
  assertSatAmount,
  btcToSats,
  formatBtcAmount,
  formatSats,
  satsToBtc,
} from "../src/money";

describe("money unit", () => {
  it("uses sats as the internal unit", () => {
    expect(MONEY_UNIT).toBe("sat");
    expect(SATS_PER_BTC).toBe(100_000_000);
  });

  it("converts BTC display amounts into integer sats", () => {
    expect(btcToSats(0)).toBe(0);
    expect(btcToSats(0.00000001)).toBe(1);
    expect(btcToSats(1)).toBe(100_000_000);
    expect(btcToSats(1.23456789)).toBe(123_456_789);
  });

  it("converts sats back to BTC display amounts", () => {
    expect(satsToBtc(0)).toBe(0);
    expect(satsToBtc(1)).toBe(0.00000001);
    expect(satsToBtc(100_000_000)).toBe(1);
    expect(satsToBtc(123_456_789)).toBe(1.23456789);
  });

  it("formats sats and BTC amounts for display", () => {
    expect(formatSats(0)).toBe("0");
    expect(formatSats(123_456_789)).toBe("123,456,789");
    expect(formatBtcAmount(0)).toBe("0.00000000");
    expect(formatBtcAmount(123_456_789)).toBe("1.23456789");
  });

  it("rejects invalid sat values", () => {
    expect(() => assertSatAmount(-1)).toThrow();
    expect(() => assertSatAmount(1.2)).toThrow();
    expect(() => assertSatAmount(Number.NaN)).toThrow();
    expect(() => assertSatAmount(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("rejects invalid BTC display values", () => {
    expect(() => btcToSats(-1)).toThrow();
    expect(() => btcToSats(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => btcToSats(0.000000001)).toThrow();
  });
});
