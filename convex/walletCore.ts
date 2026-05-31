export const INITIAL_PLAYABLE_BALANCE_SATS = 1000;

export type WalletBalances = {
  availableBalance: number;
  heldBalance: number;
};

export type WalletDelta = {
  availableDelta: number;
  heldDelta: number;
};

export function assertWalletAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Wallet amounts must be non-negative safe integers in sats.");
  }
}

export function assertPositiveWalletAmount(amount: number) {
  assertWalletAmount(amount);

  if (amount === 0) {
    throw new Error("Wallet amount must be greater than zero.");
  }
}

export function applyWalletDelta(balance: WalletBalances, delta: WalletDelta): WalletBalances {
  const availableBalance = balance.availableBalance + delta.availableDelta;
  const heldBalance = balance.heldBalance + delta.heldDelta;

  assertWalletAmount(availableBalance);
  assertWalletAmount(heldBalance);

  return {
    availableBalance,
    heldBalance,
  };
}

export function idempotencyKeyFor(sourceType: string, sourceId: string, kind: string) {
  if (!sourceType.trim() || !sourceId.trim() || !kind.trim()) {
    throw new Error("Wallet idempotency source must be complete.");
  }

  return `${sourceType}:${sourceId}:${kind}`;
}
