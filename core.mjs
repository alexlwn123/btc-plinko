export const RISKS = {
  low: {
    label: "Low"
  },
  medium: {
    label: "Medium"
  },
  high: {
    label: "High"
  }
};

export const STAKE_MULTIPLIERS = {
  8: {
    low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29]
  },
  9: {
    low: [5.6, 2, 1.6, 1, 0.7, 0.7, 1, 1.6, 2, 5.6],
    medium: [18, 4, 1.7, 0.9, 0.5, 0.5, 0.9, 1.7, 4, 18],
    high: [43, 7, 2, 0.6, 0.2, 0.2, 0.6, 2, 7, 43]
  },
  10: {
    low: [8.9, 3, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 3, 8.9],
    medium: [22, 5, 2, 1.4, 0.6, 0.4, 0.6, 1.4, 2, 5, 22],
    high: [76, 10, 3, 0.9, 0.3, 0.2, 0.3, 0.9, 3, 10, 76]
  },
  11: {
    low: [8.4, 3, 1.9, 1.3, 1, 0.7, 0.7, 1, 1.3, 1.9, 3, 8.4],
    medium: [24, 6, 3, 1.8, 0.7, 0.5, 0.5, 0.7, 1.8, 3, 6, 24],
    high: [120, 14, 5.2, 1.4, 0.4, 0.2, 0.2, 0.4, 1.4, 5.2, 14, 120]
  },
  12: {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
    high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170]
  },
  13: {
    low: [8.1, 4, 3, 1.9, 1.2, 0.9, 0.7, 0.7, 0.9, 1.2, 1.9, 3, 4, 8.1],
    medium: [43, 13, 6, 3, 1.3, 0.7, 0.4, 0.4, 0.7, 1.3, 3, 6, 13, 43],
    high: [260, 37, 11, 4, 1, 0.2, 0.2, 0.2, 0.2, 1, 4, 11, 37, 260]
  },
  14: {
    low: [7.1, 4, 1.9, 1.4, 1.3, 1.1, 1, 0.5, 1, 1.1, 1.3, 1.4, 1.9, 4, 7.1],
    medium: [58, 15, 7, 4, 1.9, 1, 0.5, 0.2, 0.5, 1, 1.9, 4, 7, 15, 58],
    high: [420, 56, 18, 5, 1.9, 0.3, 0.2, 0.2, 0.2, 0.3, 1.9, 5, 18, 56, 420]
  },
  15: {
    low: [15, 8, 3, 2, 1.5, 1.1, 1, 0.7, 0.7, 1, 1.1, 1.5, 2, 3, 8, 15],
    medium: [88, 18, 11, 5, 3, 1.3, 0.5, 0.3, 0.3, 0.5, 1.3, 3, 5, 11, 18, 88],
    high: [620, 83, 27, 8, 3, 0.5, 0.2, 0.2, 0.2, 0.2, 0.5, 3, 8, 27, 83, 620]
  },
  16: {
    low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000]
  }
};

export function assertRows(rows) {
  if (!Number.isInteger(rows) || rows < 1) {
    throw new Error("Rows must be a positive integer.");
  }
}

export function unbiasedBit() {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0] & 1;
}

export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomServerSeed(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function sha256Hex(message) {
  const data = new TextEncoder().encode(message);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hash));
}

export async function commitServerSeed(serverSeed) {
  return sha256Hex(serverSeed);
}

export function fairnessMessage(serverSeed, clientSeed, nonce, row) {
  return `${serverSeed}:${clientSeed}:${nonce}:${row}`;
}

export async function buildProvablyFairDrop(rows, { serverSeed, serverSeedHash, clientSeed, nonce }) {
  assertRows(rows);

  const committedHash = serverSeedHash ?? await commitServerSeed(serverSeed);
  const rowHashes = await Promise.all(
    Array.from({ length: rows }, (_, index) => (
      sha256Hex(fairnessMessage(serverSeed, clientSeed, nonce, index + 1))
    ))
  );
  const directions = [];
  const points = [{ layer: 0, rights: 0, slot: 0 }];
  let rights = 0;

  rowHashes.forEach((hash, index) => {
    const bit = Number.parseInt(hash.slice(0, 2), 16) & 1;
    rights += bit;
    directions.push(bit ? "R" : "L");
    points.push({ layer: index + 1, rights, slot: rights });
  });

  return {
    rows,
    directions,
    points,
    slot: rights,
    fairness: {
      serverSeed,
      serverSeedHash: committedHash,
      clientSeed,
      nonce,
      rowHashes
    }
  };
}

export async function verifyProvablyFairDrop(drop) {
  const rebuilt = await buildProvablyFairDrop(drop.rows, drop.fairness);
  return (
    rebuilt.fairness.serverSeedHash === drop.fairness.serverSeedHash
    && rebuilt.slot === drop.slot
    && rebuilt.directions.join("") === drop.directions.join("")
  );
}

export function buildDrop(rows, bitSource = unbiasedBit) {
  assertRows(rows);

  const directions = [];
  const points = [{ layer: 0, rights: 0, slot: 0 }];
  let rights = 0;

  for (let layer = 1; layer <= rows; layer += 1) {
    const bit = bitSource() ? 1 : 0;
    rights += bit;
    directions.push(bit ? "R" : "L");
    points.push({ layer, rights, slot: rights });
  }

  return {
    rows,
    directions,
    points,
    slot: rights
  };
}

export function buildMultipliers(rows, riskName) {
  assertRows(rows);

  const risk = RISKS[riskName] ? riskName : "medium";
  const multipliers = STAKE_MULTIPLIERS[rows]?.[risk];
  if (!multipliers) {
    throw new Error(`No Stake multiplier table for ${rows} rows at ${risk} risk.`);
  }

  return [...multipliers];
}

export function formatNumber(value, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}
