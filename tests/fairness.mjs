import { webcrypto } from "node:crypto";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

const { buildDrop } = await import("../core.mjs");

const rows = 16;
const samples = 100000;
const totals = Array.from({ length: rows }, () => ({ left: 0, right: 0 }));

for (let sample = 0; sample < samples; sample += 1) {
  const drop = buildDrop(rows);
  drop.directions.forEach((direction, layer) => {
    totals[layer][direction === "R" ? "right" : "left"] += 1;
  });
}

const summary = totals.map(({ left, right }, index) => {
  const rightRate = right / (left + right);
  return {
    layer: index + 1,
    left,
    right,
    rightRate: Number(rightRate.toFixed(4))
  };
});

console.table(summary);
