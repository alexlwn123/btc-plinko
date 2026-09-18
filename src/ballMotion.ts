import type { Drop } from "./core";

export type MotionBoard = {
  centerX: number;
  topY: number;
  slotGap: number;
  rowGap: number;
  binTop: number;
};

type Point = { x: number; y: number };

export type BallFlight = {
  start: number;
  duration: number;
  from: Point;
  to: Point;
  vx: number;
  vy: number;
  spin: number;
  angle: number;
};

export type BallMotion = {
  flights: BallFlight[];
  impacts: Array<{ time: number; row: number; peg: number }>;
  duration: number;
  gravity: number;
  radius: number;
};

export function ballRadius(board: MotionBoard) {
  return board.slotGap * 0.17;
}

export function pegRadius(board: MotionBoard) {
  return board.slotGap * 0.09;
}

// This is a presentation of an already verified drop, not a settlement engine.
// Exact ballistic flights keep gravity and velocity independent of render rate.
// Rebound impulses are constrained to the verified left/right sequence: a free
// rigid-body simulation could land in a slot different from the awarded payout.
export function buildBallMotion(drop: Drop, board: MotionBoard, seed: number): BallMotion {
  let randomState = seed >>> 0;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const radius = ballRadius(board);
  const contactRadius = radius + pegRadius(board);
  const gravity = board.rowGap * 48;
  const contacts = drop.directions.map((direction, row) => {
    const normalX = (direction === "R" ? 1 : -1) * (0.22 + random() * 0.16);
    return {
      x:
        board.centerX +
        (drop.points[row].rights - row / 2) * board.slotGap +
        normalX * contactRadius,
      y: board.topY + row * board.rowGap - Math.sqrt(1 - normalX ** 2) * contactRadius,
    };
  });
  const first = contacts[0];
  let from = { x: first.x, y: first.y - board.rowGap * (0.85 + random() * 0.25) };
  let time = 0;
  let vy = 0;
  let angle = random() * Math.PI * 2;
  const flights: BallFlight[] = [];
  const impacts: BallMotion["impacts"] = [];
  const targets = [
    ...contacts,
    {
      x: board.centerX + (drop.slot - drop.rows / 2) * board.slotGap,
      y: board.binTop - radius,
    },
  ];

  for (let index = 0; index < targets.length; index += 1) {
    const to = targets[index];
    const duration = (-vy + Math.sqrt(vy * vy + 2 * gravity * (to.y - from.y))) / gravity;
    const vx = (to.x - from.x) / duration;
    const spin = (vx / radius) * 0.45;
    flights.push({ start: time, duration, from, to, vx, vy, spin, angle });
    time += duration;
    angle += spin * duration;
    if (index < contacts.length) {
      impacts.push({ time, row: index, peg: drop.points[index].rights });
    }

    // Lose vertical energy on impact. Alternating directions produce a stronger
    // rebound than glancing hits continuing to the same side.
    const reversal = index > 0 && drop.directions[index] !== drop.directions[index - 1];
    // The last peg needs extra clearance for the longer flight into the bins.
    const restitution =
      (index === contacts.length - 1 ? 0.48 : reversal ? 0.32 : 0.24) + random() * 0.13;
    vy = -(vy + gravity * duration) * restitution;
    from = to;
  }

  return { flights, impacts, duration: time, gravity, radius };
}

export function sampleBallMotion(motion: BallMotion, elapsedMs: number) {
  const time = Math.max(0, elapsedMs / 1000);
  const index = motion.flights.findIndex((flight) => time < flight.start + flight.duration);
  const flightIndex = index === -1 ? motion.flights.length - 1 : index;
  const flight = motion.flights[flightIndex];
  const t = Math.min(flight.duration, Math.max(0, time - flight.start));
  const done = time >= motion.duration;
  return {
    x: done ? flight.to.x : flight.from.x + flight.vx * t,
    y: done ? flight.to.y : flight.from.y + flight.vy * t + 0.5 * motion.gravity * t * t,
    vx: flight.vx,
    vy: flight.vy + motion.gravity * t,
    angle: flight.angle + flight.spin * t,
    flightIndex,
    flightProgress: t / flight.duration,
    done,
  };
}
