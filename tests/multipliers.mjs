import assert from "node:assert/strict";
import { buildMultipliers, STAKE_MULTIPLIERS } from "../core.mjs";

for (const [rows, byRisk] of Object.entries(STAKE_MULTIPLIERS)) {
  for (const [risk, multipliers] of Object.entries(byRisk)) {
    assert.equal(multipliers.length, Number(rows) + 1, `${rows}/${risk} slot count`);
    assert.deepEqual(multipliers, [...multipliers].reverse(), `${rows}/${risk} symmetry`);
    assert.deepEqual(buildMultipliers(Number(rows), risk), multipliers, `${rows}/${risk} lookup`);
  }
}

assert.deepEqual(
  buildMultipliers(16, "high"),
  [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000]
);

assert.deepEqual(
  buildMultipliers(8, "low"),
  [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6]
);
