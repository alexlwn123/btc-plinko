export function availableForDrop({
  balance,
  pendingServerBetTotal,
  usesServerSettlement,
}: {
  balance: number;
  pendingServerBetTotal: number;
  usesServerSettlement: boolean;
}) {
  return usesServerSettlement ? Math.max(0, balance - pendingServerBetTotal) : balance;
}

export function canStartDrop({
  balance,
  bet,
  hasCommit,
  pendingServerBetTotal,
  serverSettlementReady,
  usesServerSettlement,
}: {
  balance: number;
  bet: number;
  hasCommit: boolean;
  pendingServerBetTotal: number;
  serverSettlementReady: boolean;
  usesServerSettlement: boolean;
}) {
  if (!Number.isSafeInteger(bet) || bet <= 0) return false;
  if (bet > availableForDrop({ balance, pendingServerBetTotal, usesServerSettlement }))
    return false;
  return usesServerSettlement ? serverSettlementReady : hasCommit;
}
