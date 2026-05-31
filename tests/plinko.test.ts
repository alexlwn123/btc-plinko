import { describe, expect, it } from "vitest";
import { settleDropForUser } from "../convex/plinko";
import { calculatePayoutAmount } from "../convex/plinkoCore";
import { INITIAL_PLAYABLE_BALANCE_SATS } from "../convex/walletCore";
import { createDbMock, mutationCtx, testUserId as userId } from "./convexDbMock";

describe("plinko backend settlement", () => {
  it("records a completed round and applies wallet settlement together", async () => {
    const db = createDbMock();

    const result = await settleDropForUser(mutationCtx(db), {
      betAmount: 10,
      clientSeed: " player-seed ",
      requestId: "round-request-1",
      risk: "medium",
      rows: 12,
      userId,
    });

    expect(result.duplicate).toBe(false);
    expect(result.round).toMatchObject({
      betAmount: 10,
      clientSeed: "player-seed",
      nonce: 0,
      rows: 12,
      status: "completed",
    });
    expect(result.round.directions).toHaveLength(12);
    expect(result.round.points).toHaveLength(13);
    expect(result.round.rowHashes).toHaveLength(12);
    expect(result.round.payoutAmount).toBe(calculatePayoutAmount(10, result.round.multiplier));
    expect(result.wallet.availableBalance).toBe(
      INITIAL_PLAYABLE_BALANCE_SATS - 10 + result.round.payoutAmount,
    );
    expect(db.rows("gameRounds")).toHaveLength(1);
    expect(db.rows("walletEvents").map((event) => event.kind)).toEqual([
      "manual_adjustment",
      "bet_debit",
      "payout_credit",
    ]);
  });

  it("returns an existing round for duplicate settlement requests", async () => {
    const db = createDbMock();

    const first = await settleDropForUser(mutationCtx(db), {
      betAmount: 10,
      clientSeed: "player-seed",
      requestId: "same-request",
      risk: "medium",
      rows: 12,
      userId,
    });
    const eventCount = db.rows("walletEvents").length;
    const second = await settleDropForUser(mutationCtx(db), {
      betAmount: 10,
      clientSeed: "different-seed",
      requestId: "same-request",
      risk: "high",
      rows: 16,
      userId,
    });

    expect(second.duplicate).toBe(true);
    expect(second.round).toEqual(first.round);
    expect(db.rows("gameRounds")).toHaveLength(1);
    expect(db.rows("walletEvents")).toHaveLength(eventCount);
    expect(second.wallet).toEqual(first.wallet);
  });

  it("increments the user nonce for each new round", async () => {
    const db = createDbMock();

    const first = await settleDropForUser(mutationCtx(db), {
      betAmount: 10,
      clientSeed: "player-seed",
      requestId: "nonce-request-1",
      risk: "medium",
      rows: 12,
      userId,
    });
    const second = await settleDropForUser(mutationCtx(db), {
      betAmount: 10,
      clientSeed: "player-seed",
      requestId: "nonce-request-2",
      risk: "medium",
      rows: 12,
      userId,
    });

    expect(first.round.nonce).toBe(0);
    expect(second.round.nonce).toBe(1);
  });

  it("rejects insufficient balance without recording a round or bet event", async () => {
    const db = createDbMock();

    await expect(
      settleDropForUser(mutationCtx(db), {
        betAmount: INITIAL_PLAYABLE_BALANCE_SATS + 1,
        clientSeed: "player-seed",
        requestId: "too-large",
        risk: "medium",
        rows: 12,
        userId,
      }),
    ).rejects.toThrow("Insufficient available balance.");
    expect(db.rows("gameRounds")).toHaveLength(0);
    expect(db.rows("walletEvents").map((event) => event.kind)).toEqual(["manual_adjustment"]);
    expect(db.rows("wallets")[0]).toMatchObject({
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS,
      heldBalance: 0,
    });
  });
});
