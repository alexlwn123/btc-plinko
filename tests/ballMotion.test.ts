import { describe, expect, it } from "vitest";
import { type MotionBoard, buildBallMotion, pegRadius, sampleBallMotion } from "../src/ballMotion";
import { buildDrop } from "../src/core";

function boardFor(width: number, rows: number): MotionBoard {
  const topY = width < 620 ? 68 : 86;
  const rowGap = (width - topY - (width < 620 ? 104 : 122)) / rows;
  return {
    centerX: width / 2,
    topY,
    rowGap,
    slotGap: Math.min((width - (width < 620 ? 64 : 104)) / rows, rowGap * 1.32),
    binTop: topY + rowGap * rows + 16,
  };
}

describe("ball motion", () => {
  it("lands in the verified slot and contacts the right pegs without passing through them", () => {
    for (const width of [288, 375, 600, 900]) {
      for (const rows of [8, 10, 12, 14, 16]) {
        const board = boardFor(width, rows);
        for (let seed = 0; seed < 40; seed += 1) {
          let row = 0;
          const drop = buildDrop(rows, () => {
            // Include both edge slots, alternating paths, and irregular runs.
            return (seed < 2 ? seed : (seed * 2654435761) >>> row++) & 1;
          });
          const motion = buildBallMotion(drop, board, seed);
          const end = sampleBallMotion(motion, motion.duration * 1000 + 1);
          expect(end.done).toBe(true);
          expect(end.x).toBe(board.centerX + (drop.slot - rows / 2) * board.slotGap);
          expect(end.y).toBe(board.binTop - motion.radius);
          expect(motion.duration).toBeGreaterThan(2);
          expect(motion.duration).toBeLessThan(7);

          for (const impact of motion.impacts) {
            const hit = sampleBallMotion(motion, impact.time * 1000);
            const pegX = board.centerX + (impact.peg - impact.row / 2) * board.slotGap;
            const pegY = board.topY + impact.row * board.rowGap;
            expect(Math.hypot(hit.x - pegX, hit.y - pegY)).toBeCloseTo(
              motion.radius + pegRadius(board),
              7,
            );
          }

          // Sweep at 240 Hz, including neighbouring pegs and the board edges.
          let minimumClearance = Number.POSITIVE_INFINITY;
          let minimumEdgeClearance = Number.POSITIVE_INFINITY;
          for (let time = 0; time < motion.duration; time += 1 / 240) {
            const ball = sampleBallMotion(motion, time * 1000);
            minimumEdgeClearance = Math.min(
              minimumEdgeClearance,
              ball.x - motion.radius,
              width - ball.x - motion.radius,
            );
            const nearestRow = Math.round((ball.y - board.topY) / board.rowGap);
            for (
              let pegRow = Math.max(0, nearestRow - 1);
              pegRow <= Math.min(rows - 1, nearestRow + 1);
              pegRow += 1
            ) {
              const nearestPeg = Math.round((ball.x - board.centerX) / board.slotGap + pegRow / 2);
              if (nearestPeg < 0 || nearestPeg > pegRow) continue;
              const pegX = board.centerX + (nearestPeg - pegRow / 2) * board.slotGap;
              const pegY = board.topY + pegRow * board.rowGap;
              const clearance =
                Math.hypot(ball.x - pegX, ball.y - pegY) - motion.radius - pegRadius(board);
              minimumClearance = Math.min(minimumClearance, clearance);
            }
          }
          expect(minimumEdgeClearance).toBeGreaterThan(0);
          expect(
            minimumClearance,
            `width ${width}, rows ${rows}, seed ${seed}`,
          ).toBeGreaterThanOrEqual(-0.000001);
        }
      }
    }
  });

  it("accelerates under gravity and rebounds without pausing at contact", () => {
    const board = boardFor(700, 12);
    const drop = buildDrop(12, () => 1);
    const motion = buildBallMotion(drop, board, 42);
    for (const impact of motion.impacts) {
      const before = sampleBallMotion(motion, impact.time * 1000 - 0.01);
      const after = sampleBallMotion(motion, impact.time * 1000 + 0.01);
      expect(before.vy).toBeGreaterThan(0);
      expect(after.vy).toBeLessThan(0);
      expect(after.vx).toBeGreaterThan(0);
      expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.1);
    }
    const early = sampleBallMotion(motion, 20);
    const later = sampleBallMotion(motion, 40);
    expect(later.vy - early.vy).toBeCloseTo(motion.gravity * 0.02);
  });

  it("is deterministic across frame rates and missed frames", () => {
    const board = boardFor(375, 16);
    let bit = 0;
    const motion = buildBallMotion(
      buildDrop(16, () => bit++ % 2),
      board,
      17,
    );
    const expected = sampleBallMotion(motion, 1950);
    for (const fps of [30, 60, 120, 144]) {
      for (let time = 0; time < 1950; time += 1000 / fps) sampleBallMotion(motion, time);
      expect(sampleBallMotion(motion, 1950)).toEqual(expected);
    }
    expect(sampleBallMotion(motion, 60_000).done).toBe(true);
    expect(sampleBallMotion(motion, -100)).toEqual(sampleBallMotion(motion, 0));
  });
});
