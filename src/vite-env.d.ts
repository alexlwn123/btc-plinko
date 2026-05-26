/// <reference types="vite/client" />

import type {
  buildDrop,
  buildMultipliers,
  buildProvablyFairDrop,
  verifyProvablyFairDrop,
} from "./core";

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    plinkoDebug: {
      buildDrop: typeof buildDrop;
      buildMultipliers: typeof buildMultipliers;
      buildProvablyFairDrop: typeof buildProvablyFairDrop;
      verifyProvablyFairDrop: typeof verifyProvablyFairDrop;
      getState: () => {
        balance: number;
        rows: number;
        risk: string;
        active: number;
        pending: number;
        currentServerHash?: string;
        currentNonce?: number;
        lastProof: unknown;
        lastPath: string[];
        lastSlot: number | null;
        playHistory: Array<{
          id: number;
          bet: number;
          payout: number;
          multiplier: number;
          slot: number;
        }>;
      };
    };
  }
}
