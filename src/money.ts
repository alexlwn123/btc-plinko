export const SATS_PER_BTC = 100_000_000;
export const MONEY_UNIT = "sat";

export type MoneyUnit = typeof MONEY_UNIT;
export type SatAmount = number;

export function assertSatAmount(amount: number): asserts amount is SatAmount {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Money amounts must be non-negative safe integers in sats.");
  }
}

export function btcToSats(btc: number): SatAmount {
  if (!Number.isFinite(btc) || btc < 0) {
    throw new Error("BTC amounts must be non-negative finite numbers.");
  }

  const sats = Math.round(btc * SATS_PER_BTC);
  if (Math.abs(sats / SATS_PER_BTC - btc) > Number.EPSILON * 10) {
    throw new Error("BTC amounts must not include fractions smaller than one sat.");
  }

  assertSatAmount(sats);
  return sats;
}

export function satsToBtc(amount: SatAmount) {
  assertSatAmount(amount);
  return amount / SATS_PER_BTC;
}

export function formatSats(amount: SatAmount) {
  assertSatAmount(amount);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatBtcAmount(amount: SatAmount) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }).format(satsToBtc(amount));
}
