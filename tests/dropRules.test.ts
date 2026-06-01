import { describe, expect, it } from "vitest";
import { availableForDrop, canStartDrop } from "../src/dropRules";

describe("drop availability rules", () => {
  it("uses the full balance for local settlement", () => {
    expect(
      availableForDrop({
        balance: 100,
        pendingServerBetTotal: 90,
        usesServerSettlement: false,
      }),
    ).toBe(100);
  });

  it("reserves pending server bets from the playable balance", () => {
    expect(
      availableForDrop({
        balance: 100,
        pendingServerBetTotal: 30,
        usesServerSettlement: true,
      }),
    ).toBe(70);
  });

  it("does not report a negative playable balance", () => {
    expect(
      availableForDrop({
        balance: 100,
        pendingServerBetTotal: 125,
        usesServerSettlement: true,
      }),
    ).toBe(0);
  });

  it("allows another server-settled drop when the reserved balance still covers it", () => {
    expect(
      canStartDrop({
        balance: 100,
        bet: 25,
        hasCommit: false,
        pendingServerBetTotal: 50,
        serverSettlementReady: true,
        usesServerSettlement: true,
      }),
    ).toBe(true);
  });

  it("blocks server-settled drops when pending bets consume the available balance", () => {
    expect(
      canStartDrop({
        balance: 100,
        bet: 25,
        hasCommit: false,
        pendingServerBetTotal: 90,
        serverSettlementReady: true,
        usesServerSettlement: true,
      }),
    ).toBe(false);
  });

  it("requires the correct readiness signal for each settlement mode", () => {
    expect(
      canStartDrop({
        balance: 100,
        bet: 25,
        hasCommit: true,
        pendingServerBetTotal: 0,
        serverSettlementReady: false,
        usesServerSettlement: false,
      }),
    ).toBe(true);
    expect(
      canStartDrop({
        balance: 100,
        bet: 25,
        hasCommit: false,
        pendingServerBetTotal: 0,
        serverSettlementReady: true,
        usesServerSettlement: false,
      }),
    ).toBe(false);
    expect(
      canStartDrop({
        balance: 100,
        bet: 25,
        hasCommit: true,
        pendingServerBetTotal: 0,
        serverSettlementReady: false,
        usesServerSettlement: true,
      }),
    ).toBe(false);
  });
});
