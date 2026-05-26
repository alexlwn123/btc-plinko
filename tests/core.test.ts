import { describe, expect, it } from "vitest";
import {
  STAKE_MULTIPLIERS,
  buildDrop,
  buildMultipliers,
  buildProvablyFairDrop,
  commitServerSeed,
  fairnessMessage,
  sha256Hex,
  verifyProvablyFairDrop,
} from "../src/core";

describe("multipliers", () => {
  it("matches the configured table shape", () => {
    for (const [rows, byRisk] of Object.entries(STAKE_MULTIPLIERS)) {
      for (const [risk, multipliers] of Object.entries(byRisk)) {
        expect(multipliers, `${rows}/${risk} slot count`).toHaveLength(Number(rows) + 1);
        expect(multipliers, `${rows}/${risk} symmetry`).toEqual([...multipliers].reverse());
        expect(buildMultipliers(Number(rows), risk), `${rows}/${risk} lookup`).toEqual(multipliers);
      }
    }
  });

  it("returns known Stake multiplier rows", () => {
    expect(buildMultipliers(16, "high")).toEqual([
      1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000,
    ]);
    expect(buildMultipliers(8, "low")).toEqual([5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6]);
  });
});

describe("drop generation", () => {
  it("builds one direction per row and a valid slot", () => {
    const drop = buildDrop(16, () => 1);

    expect(drop.directions).toHaveLength(16);
    expect(drop.points).toHaveLength(17);
    expect(drop.slot).toBe(16);
  });

  it("does not bias fixed test bit sources", () => {
    let bit = 0;
    const drop = buildDrop(8, () => {
      bit = bit ? 0 : 1;
      return bit;
    });

    expect(drop.directions).toEqual(["R", "L", "R", "L", "R", "L", "R", "L"]);
    expect(drop.slot).toBe(4);
  });
});

describe("provably fair drops", () => {
  it("commits, rebuilds, and verifies deterministic drops", async () => {
    const serverSeed = "server-secret-example";
    const clientSeed = "client-visible-example";
    const nonce = 42;

    const committedHash = await commitServerSeed(serverSeed);
    expect(committedHash).toBe(await sha256Hex(serverSeed));
    expect(fairnessMessage(serverSeed, clientSeed, nonce, 1)).toBe(
      "server-secret-example:client-visible-example:42:1",
    );

    const drop = await buildProvablyFairDrop(12, {
      serverSeed,
      serverSeedHash: committedHash,
      clientSeed,
      nonce,
    });
    const rebuilt = await buildProvablyFairDrop(12, {
      serverSeed,
      serverSeedHash: committedHash,
      clientSeed,
      nonce,
    });

    expect(drop).toEqual(rebuilt);
    expect(drop.directions).toHaveLength(12);
    expect(drop.points).toHaveLength(13);
    expect(drop.slot).toBe(drop.directions.filter((direction) => direction === "R").length);
    expect(drop.fairness.serverSeedHash).toBe(committedHash);
    expect(await verifyProvablyFairDrop(drop)).toBe(true);
  });

  it("rejects a tampered direction path", async () => {
    const committedHash = await commitServerSeed("server-secret-example");
    const drop = await buildProvablyFairDrop(12, {
      serverSeed: "server-secret-example",
      serverSeedHash: committedHash,
      clientSeed: "client-visible-example",
      nonce: 42,
    });
    const lastDirection = drop.directions.at(-1);
    const replacementDirection: "L" | "R" = lastDirection === "R" ? "L" : "R";
    const tampered = {
      ...drop,
      directions: [...drop.directions.slice(0, -1), replacementDirection],
    };

    expect(await verifyProvablyFairDrop(tampered)).toBe(false);
  });
});
