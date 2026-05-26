import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

const {
  buildProvablyFairDrop,
  commitServerSeed,
  fairnessMessage,
  sha256Hex,
  verifyProvablyFairDrop
} = await import("../core.mjs");

const serverSeed = "server-secret-example";
const clientSeed = "client-visible-example";
const nonce = 42;

const committedHash = await commitServerSeed(serverSeed);
assert.equal(committedHash, await sha256Hex(serverSeed));
assert.equal(fairnessMessage(serverSeed, clientSeed, nonce, 1), "server-secret-example:client-visible-example:42:1");

const drop = await buildProvablyFairDrop(12, {
  serverSeed,
  serverSeedHash: committedHash,
  clientSeed,
  nonce
});
const rebuilt = await buildProvablyFairDrop(12, {
  serverSeed,
  serverSeedHash: committedHash,
  clientSeed,
  nonce
});

assert.deepEqual(drop, rebuilt);
assert.equal(drop.directions.length, 12);
assert.equal(drop.points.length, 13);
assert.equal(drop.slot, drop.directions.filter((direction) => direction === "R").length);
assert.equal(drop.fairness.serverSeedHash, committedHash);
assert.equal(await verifyProvablyFairDrop(drop), true);

const tampered = {
  ...drop,
  directions: [...drop.directions.slice(0, -1), drop.directions.at(-1) === "R" ? "L" : "R"]
};
assert.equal(await verifyProvablyFairDrop(tampered), false);
