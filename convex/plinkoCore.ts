import { assertPositiveWalletAmount } from "./walletCore";

export const PLINKO_RISKS = ["low", "medium", "high"] as const;
export type PlinkoRisk = (typeof PLINKO_RISKS)[number];

export type SettledPlinkoPoint = {
  layer: number;
  rights: number;
  slot: number;
};

export type SettledPlinkoDrop = {
  clientSeed: string;
  directions: Array<"L" | "R">;
  multiplier: number;
  nonce: number;
  payoutAmount: number;
  points: SettledPlinkoPoint[];
  risk: PlinkoRisk;
  rowHashes: string[];
  rows: number;
  serverSeed: string;
  serverSeedHash: string;
  slot: number;
};

export const MAX_BET_AMOUNT_SATS = 1_000_000;
export const MAX_CLIENT_SEED_LENGTH = 128;

export const PLINKO_MULTIPLIERS: Record<number, Record<PlinkoRisk, number[]>> = {
  8: {
    low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  },
  9: {
    low: [5.6, 2, 1.6, 1, 0.7, 0.7, 1, 1.6, 2, 5.6],
    medium: [18, 4, 1.7, 0.9, 0.5, 0.5, 0.9, 1.7, 4, 18],
    high: [43, 7, 2, 0.6, 0.2, 0.2, 0.6, 2, 7, 43],
  },
  10: {
    low: [8.9, 3, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 3, 8.9],
    medium: [22, 5, 2, 1.4, 0.6, 0.4, 0.6, 1.4, 2, 5, 22],
    high: [76, 10, 3, 0.9, 0.3, 0.2, 0.3, 0.9, 3, 10, 76],
  },
  11: {
    low: [8.4, 3, 1.9, 1.3, 1, 0.7, 0.7, 1, 1.3, 1.9, 3, 8.4],
    medium: [24, 6, 3, 1.8, 0.7, 0.5, 0.5, 0.7, 1.8, 3, 6, 24],
    high: [120, 14, 5.2, 1.4, 0.4, 0.2, 0.2, 0.4, 1.4, 5.2, 14, 120],
  },
  12: {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
    high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
  },
  13: {
    low: [8.1, 4, 3, 1.9, 1.2, 0.9, 0.7, 0.7, 0.9, 1.2, 1.9, 3, 4, 8.1],
    medium: [43, 13, 6, 3, 1.3, 0.7, 0.4, 0.4, 0.7, 1.3, 3, 6, 13, 43],
    high: [260, 37, 11, 4, 1, 0.2, 0.2, 0.2, 0.2, 1, 4, 11, 37, 260],
  },
  14: {
    low: [7.1, 4, 1.9, 1.4, 1.3, 1.1, 1, 0.5, 1, 1.1, 1.3, 1.4, 1.9, 4, 7.1],
    medium: [58, 15, 7, 4, 1.9, 1, 0.5, 0.2, 0.5, 1, 1.9, 4, 7, 15, 58],
    high: [420, 56, 18, 5, 1.9, 0.3, 0.2, 0.2, 0.2, 0.3, 1.9, 5, 18, 56, 420],
  },
  15: {
    low: [15, 8, 3, 2, 1.5, 1.1, 1, 0.7, 0.7, 1, 1.1, 1.5, 2, 3, 8, 15],
    medium: [88, 18, 11, 5, 3, 1.3, 0.5, 0.3, 0.3, 0.5, 1.3, 3, 5, 11, 18, 88],
    high: [620, 83, 27, 8, 3, 0.5, 0.2, 0.2, 0.2, 0.2, 0.5, 3, 8, 27, 83, 620],
  },
  16: {
    low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};

export function assertPlinkoBetAmount(amount: number) {
  assertPositiveWalletAmount(amount);

  if (amount > MAX_BET_AMOUNT_SATS) {
    throw new Error(`Bet amount cannot exceed ${MAX_BET_AMOUNT_SATS} sats.`);
  }
}

export function parsePlinkoRisk(risk: string): PlinkoRisk {
  if (PLINKO_RISKS.includes(risk as PlinkoRisk)) {
    return risk as PlinkoRisk;
  }

  throw new Error("Risk level is not supported.");
}

export function assertPlinkoRows(rows: number) {
  if (!Number.isInteger(rows) || !PLINKO_MULTIPLIERS[rows]) {
    throw new Error("Rows setting is not supported.");
  }
}

export function normalizeClientSeed(clientSeed: string) {
  const normalized = clientSeed.trim() || "browser-client";

  if (normalized.length > MAX_CLIENT_SEED_LENGTH) {
    throw new Error(`Client seed cannot exceed ${MAX_CLIENT_SEED_LENGTH} characters.`);
  }

  return normalized;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomServerSeed(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function sha256Hex(message: string) {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hash));
}

export async function commitServerSeed(serverSeed: string) {
  return sha256Hex(serverSeed);
}

export function fairnessMessage(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  row: number,
) {
  return `${serverSeed}:${clientSeed}:${nonce}:${row}`;
}

export function multiplierToRatio(multiplier: number) {
  const [integer, fraction = ""] = multiplier.toString().split(".");
  const denominator = 10 ** fraction.length;
  const numerator = Number(integer) * denominator + Number(fraction);

  return { denominator, numerator };
}

export function calculatePayoutAmount(betAmount: number, multiplier: number) {
  assertPlinkoBetAmount(betAmount);

  const { denominator, numerator } = multiplierToRatio(multiplier);
  const payout = (BigInt(betAmount) * BigInt(numerator)) / BigInt(denominator);

  if (payout > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Payout exceeds safe integer range.");
  }

  return Number(payout);
}

export function buildPlinkoMultipliers(rows: number, risk: string) {
  assertPlinkoRows(rows);
  return [...PLINKO_MULTIPLIERS[rows][parsePlinkoRisk(risk)]];
}

export async function settlePlinkoDrop({
  betAmount,
  clientSeed,
  nonce,
  risk,
  rows,
  serverSeed = randomServerSeed(),
}: {
  betAmount: number;
  clientSeed: string;
  nonce: number;
  risk: string;
  rows: number;
  serverSeed?: string;
}): Promise<SettledPlinkoDrop> {
  assertPlinkoBetAmount(betAmount);
  assertPlinkoRows(rows);

  const normalizedRisk = parsePlinkoRisk(risk);
  const normalizedClientSeed = normalizeClientSeed(clientSeed);
  const serverSeedHash = await commitServerSeed(serverSeed);
  const rowHashes = await Promise.all(
    Array.from({ length: rows }, (_, index) =>
      sha256Hex(fairnessMessage(serverSeed, normalizedClientSeed, nonce, index + 1)),
    ),
  );
  const directions: Array<"L" | "R"> = [];
  const points: SettledPlinkoPoint[] = [{ layer: 0, rights: 0, slot: 0 }];
  let rights = 0;

  rowHashes.forEach((hash, index) => {
    const bit = Number.parseInt(hash.slice(0, 2), 16) & 1;
    rights += bit;
    directions.push(bit ? "R" : "L");
    points.push({ layer: index + 1, rights, slot: rights });
  });

  const multiplier = PLINKO_MULTIPLIERS[rows][normalizedRisk][rights];

  return {
    clientSeed: normalizedClientSeed,
    directions,
    multiplier,
    nonce,
    payoutAmount: calculatePayoutAmount(betAmount, multiplier),
    points,
    risk: normalizedRisk,
    rowHashes,
    rows,
    serverSeed,
    serverSeedHash,
    slot: rights,
  };
}
