export type CashierStatus = "pending" | "completed" | "failed" | "canceled";

export function assertCashierAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Cashier amounts must be positive safe integers in sats.");
  }
}

export function assertPendingStatus(status: CashierStatus, label: string) {
  if (status !== "pending") {
    throw new Error(`${label} is already ${status}.`);
  }
}

export function canRetryCashierStatus(status: CashierStatus) {
  return status === "failed" || status === "canceled";
}

export function cashierRequestKey(sourceType: "deposit" | "withdrawal", requestId: string) {
  if (!requestId.trim()) {
    throw new Error("Cashier request id is required.");
  }

  return `${sourceType}:request:${requestId}`;
}
