import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  type Drop,
  type DropPoint,
  RISKS,
  type Risk,
  buildDrop,
  buildMultipliers,
  buildProvablyFairDrop,
  commitServerSeed,
  formatNumber,
  randomServerSeed,
  verifyProvablyFairDrop,
} from "./core";
import { availableForDrop } from "./dropRules";
import { clearPasskeySession, getSavedPasskeySession, savePasskeySession } from "./passkeySession";

const COMMIT_QUEUE_TARGET = 64;
const COMMIT_BATCH_SIZE = 16;
const MIN_DROP_ACTIVATION_MS = 50;
const SETTINGS_STORAGE_KEY = "btc-plinko:settings";
const DEFAULT_RISK: Risk = "medium";
const PLAY_HISTORY_LIMIT = 12;
const ROW_MIN = 8;
const ROW_MAX = 16;
const ROW_STEP = 2;
const DEFAULT_DEPOSIT_AMOUNT = "1000";
const DEFAULT_WITHDRAW_AMOUNT = "250";
const DEFAULT_WITHDRAW_INVOICE = "";
const CASHIER_HISTORY_LIMIT = 16;
const DEV_PROFILE = {
  accountState: "active",
  authMethod: "passkey",
  publicId: "dev-account",
} as const;

type ServerCommit = {
  serverSeed: string;
  serverSeedHash: string;
  nonce: number;
};

type FairnessState = {
  clientSeed: string;
  currentCommit: ServerCommit | null;
  commitQueue: ServerCommit[];
  nextNonce: number;
  refilling: boolean;
  lastProof: {
    serverSeed: string;
    serverSeedHash: string;
    clientSeed: string;
    nonce: number;
    slot: number;
    multiplier: number;
  } | null;
};

type BoardState = {
  width: number;
  height: number;
  topY: number;
  rowGap: number;
  slotGap: number;
  centerX: number;
  binTop: number;
};

type BoardPoint = {
  x: number;
  y: number;
};

type ActiveBall = {
  id: number;
  bet: number;
  drop: Drop;
  commit: ServerCommit;
  clientSeed: string;
  multiplier: number;
  payoutAmount: number;
  roundId?: string;
  settlement: "local" | "server";
  startedAt: number;
  duration: number;
  points: BoardPoint[];
  progress: number;
};

type PlayHistoryEntry = {
  id: number | string;
  bet: number;
  payout: number;
  multiplier: number;
  slot: number;
};

type GameState = {
  balance: number;
  betInput: string;
  rows: number;
  risk: Risk;
  multipliers: number[];
  activeBalls: ActiveBall[];
  animationFrame: number | null;
  nextBallId: number;
  pendingDrops: number;
  pendingServerBetTotal: number;
  lastPath: Array<"L" | "R">;
  lastSlot: number | null;
  lastWin: number;
  lastMultiplier: number;
  dropCount: number;
  playHistory: PlayHistoryEntry[];
  fairness: FairnessState;
  board: BoardState;
  serverSettlementReady: boolean;
  latestServerWalletNonce: number;
  usesServerSettlement: boolean;
};

type ViewState = {
  balance: number;
  betInput: string;
  rows: number;
  risk: Risk;
  betWarning: string | null;
  dropButtonLabel: string;
  isBetControlsDisabled: boolean;
  isSettingsLocked: boolean;
  isDropDisabled: boolean;
  playHistory: PlayHistoryEntry[];
  clientSeed: string;
  serverHash: string;
  fairNonce: string;
  revealedSeed: string;
  proofResult: string;
};

type CashierTab = "deposit" | "withdraw" | "history";

type CashierBusy =
  | "deposit:create"
  | "deposit:cancel"
  | "deposit:sync"
  | "withdrawal:create"
  | "withdrawal:cancel"
  | "withdrawal:sync"
  | "retry";

type AdminTab = "overview" | "support";

type AdminBusy = "account" | "adjustment";

type AdminLookupRequest = {
  depositId?: Id<"deposits">;
  publicId?: string;
  roundId?: Id<"gameRounds">;
  userId?: Id<"users">;
  withdrawalId?: Id<"withdrawals">;
};

type SettledPlinkoRound = {
  betAmount: number;
  clientSeed: string;
  directions: Array<"L" | "R">;
  id: string;
  multiplier: number;
  nonce: number;
  payoutAmount: number;
  points: DropPoint[];
  rows: number;
  serverSeed: string;
  serverSeedHash: string;
  slot: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value: number) {
  return value * value * (3 - 2 * value);
}

function parseRowsSetting(value: unknown) {
  const rows = Number(value);

  if (
    !Number.isInteger(rows) ||
    rows < ROW_MIN ||
    rows > ROW_MAX ||
    (rows - ROW_MIN) % ROW_STEP !== 0
  ) {
    return null;
  }

  return rows;
}

function parseRiskSetting(value: unknown): Risk | null {
  return typeof value === "string" && value in RISKS ? (value as Risk) : null;
}

function readSavedSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as { rows?: unknown; risk?: unknown };
    return {
      rows: parseRowsSetting(parsed?.rows),
      risk: parseRiskSetting(parsed?.risk),
    };
  } catch {
    return {};
  }
}

function createInitialGameState(): GameState {
  const savedSettings = readSavedSettings();
  const rows = savedSettings.rows ?? 12;
  const risk = savedSettings.risk ?? DEFAULT_RISK;

  return {
    balance: 1000,
    betInput: "10",
    rows,
    risk,
    multipliers: buildMultipliers(rows, risk),
    activeBalls: [],
    animationFrame: null,
    nextBallId: 1,
    pendingDrops: 0,
    pendingServerBetTotal: 0,
    lastPath: [],
    lastSlot: null,
    lastWin: 0,
    lastMultiplier: 0,
    dropCount: 0,
    playHistory: [],
    fairness: {
      clientSeed: "browser-client",
      currentCommit: null,
      commitQueue: [],
      nextNonce: 0,
      refilling: false,
      lastProof: null,
    },
    board: {
      width: 0,
      height: 0,
      topY: 0,
      rowGap: 0,
      slotGap: 0,
      centerX: 0,
      binTop: 0,
    },
    serverSettlementReady: true,
    latestServerWalletNonce: -1,
    usesServerSettlement: false,
  };
}

function playableBalance(state: GameState) {
  return availableForDrop({
    balance: state.balance,
    pendingServerBetTotal: state.pendingServerBetTotal,
    usesServerSettlement: state.usesServerSettlement,
  });
}

function snapshot(state: GameState): ViewState {
  const lastProof = state.fairness.lastProof;
  const usesServerSettlement = state.usesServerSettlement;
  const bet = Number(state.betInput);
  const roundedBet = Number.isFinite(bet) ? Math.round(bet) : 0;
  const isBusy = state.activeBalls.length + state.pendingDrops > 0;
  const hasInvalidBet = !Number.isSafeInteger(roundedBet) || roundedBet <= 0;
  const hasInsufficientBalance = !hasInvalidBet && roundedBet > playableBalance(state);
  const isWaitingForServerWallet = usesServerSettlement && !state.serverSettlementReady;

  return {
    balance: playableBalance(state),
    betInput: state.betInput,
    rows: state.rows,
    risk: state.risk,
    betWarning: hasInvalidBet
      ? "Enter a whole number of sats."
      : hasInsufficientBalance
        ? "Bet exceeds available balance."
        : null,
    dropButtonLabel: "Drop",
    isBetControlsDisabled: isBusy || isWaitingForServerWallet,
    isSettingsLocked: isBusy,
    isDropDisabled:
      hasInvalidBet ||
      hasInsufficientBalance ||
      (usesServerSettlement ? !state.serverSettlementReady : !state.fairness.currentCommit),
    playHistory: [...state.playHistory],
    clientSeed: state.fairness.clientSeed,
    serverHash: usesServerSettlement
      ? (lastProof?.serverSeedHash ?? "Server generated on drop")
      : (state.fairness.currentCommit?.serverSeedHash ?? "Preparing..."),
    fairNonce: usesServerSettlement
      ? lastProof
        ? `Nonce ${lastProof.nonce}`
        : "Nonce -"
      : state.fairness.currentCommit
        ? `Nonce ${state.fairness.currentCommit.nonce}`
        : "Nonce -",
    revealedSeed: lastProof?.serverSeed ?? "Awaiting result",
    proofResult: lastProof
      ? `Nonce ${lastProof.nonce} / slot ${lastProof.slot} / ${lastProof.multiplier}x`
      : "-",
  };
}

function saveSettings(state: GameState) {
  try {
    globalThis.localStorage?.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        rows: state.rows,
        risk: state.risk,
      }),
    );
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function payoutTone(entry: PlayHistoryEntry) {
  if (entry.multiplier >= 10) return "hot";
  if (entry.payout < entry.bet) return "loss";
  if (entry.payout === entry.bet) return "push";
  return "win";
}

function parseCashierAmount(value: string) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function newCashierRequestId(kind: "deposit" | "withdrawal") {
  if ("randomUUID" in crypto) {
    return `${kind}-${crypto.randomUUID()}`;
  }

  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newPlinkoRequestId() {
  if ("randomUUID" in crypto) {
    return `plinko-${crypto.randomUUID()}`;
  }

  return `plinko-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newAdminRequestId() {
  if ("randomUUID" in crypto) {
    return `admin-${crypto.randomUUID()}`;
  }

  return `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatCashierDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(timestamp);
}

function formatCashierType(type: "deposit" | "withdrawal") {
  return type === "deposit" ? "Deposit" : "Withdraw";
}

function formatAdminDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    second: "2-digit",
  }).format(timestamp);
}

function formatPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

function formatNetAmount(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, 0)}`;
}

function canRetryCashierStatus(status: string) {
  return status === "failed" || status === "canceled";
}

function multiplierColor(value: number, index: number, rows: number) {
  const edgeDistance = Math.abs(index - rows / 2) / (rows / 2);
  if (edgeDistance > 0.82) return "#f35b5b";
  if (edgeDistance > 0.58) return "#f5bc42";
  if (value >= 1) return "#00d084";
  return "#2bb7ff";
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<GameState>(createInitialGameState());
  const pointerDropActiveRef = useRef(false);
  const keyDropActiveRef = useRef(false);
  const lastDropActivationAtRef = useRef(0);
  const lastScrollYRef = useRef(0);
  const ensuredWalletSessionRef = useRef<string | null>(null);
  const [sessionToken, setSessionToken] = useState(() => getSavedPasskeySession());
  const [isDevSignedIn, setIsDevSignedIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState<"register" | "signin" | "signout" | null>(null);
  const [isControlSheetHidden, setIsControlSheetHidden] = useState(false);
  const [isCashierOpen, setIsCashierOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [adminTab, setAdminTab] = useState<AdminTab>("overview");
  const [adminBusy, setAdminBusy] = useState<AdminBusy | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminReason, setAdminReason] = useState("");
  const [adminAdjustmentInput, setAdminAdjustmentInput] = useState("100");
  const [adminAdjustmentDirection, setAdminAdjustmentDirection] = useState<"credit" | "debit">(
    "credit",
  );
  const [adminLookupRequest, setAdminLookupRequest] = useState<AdminLookupRequest | null>(null);
  const [adminLookupUserId, setAdminLookupUserId] = useState("");
  const [adminLookupPublicId, setAdminLookupPublicId] = useState("");
  const [adminLookupDepositId, setAdminLookupDepositId] = useState("");
  const [adminLookupWithdrawalId, setAdminLookupWithdrawalId] = useState("");
  const [adminLookupRoundId, setAdminLookupRoundId] = useState("");
  const [cashierTab, setCashierTab] = useState<CashierTab>("deposit");
  const [depositInput, setDepositInput] = useState(DEFAULT_DEPOSIT_AMOUNT);
  const [withdrawInput, setWithdrawInput] = useState(DEFAULT_WITHDRAW_AMOUNT);
  const [withdrawInvoiceInput, setWithdrawInvoiceInput] = useState(DEFAULT_WITHDRAW_INVOICE);
  const [cashierBusy, setCashierBusy] = useState<CashierBusy | null>(null);
  const [cashierError, setCashierError] = useState<string | null>(null);
  const [gameError, setGameError] = useState<string | null>(null);
  const [view, setView] = useState(() => snapshot(gameRef.current));
  const beginPasskeyRegistration = useMutation(api.users.beginPasskeyRegistration);
  const verifyPasskeyRegistration = useMutation(api.users.verifyPasskeyRegistration);
  const beginPasskeyAuthentication = useMutation(api.users.beginPasskeyAuthentication);
  const verifyPasskeyAuthentication = useMutation(api.users.verifyPasskeyAuthentication);
  const signOutPasskey = useMutation(api.users.signOutPasskey);
  const ensureWallet = useMutation(api.wallets.ensureWallet);
  const cancelFakeDeposit = useMutation(api.cashier.cancelFakeDeposit);
  const cancelFakeWithdrawal = useMutation(api.cashier.cancelFakeWithdrawal);
  const setAdminUserAccountState = useMutation(api.admin.setUserAccountState);
  const manualAdminBalanceAdjustment = useMutation(api.admin.manualBalanceAdjustment);
  const createLightningDeposit = useAction(api.lightning.createDeposit);
  const syncLightningDeposit = useAction(api.lightning.syncDeposit);
  const createLightningWithdrawal = useAction(api.lightning.createWithdrawal);
  const syncLightningWithdrawal = useAction(api.lightning.syncWithdrawal);
  const settlePlinkoDrop = useMutation(api.plinko.settleDrop);
  const profile = useQuery(api.users.getSessionUser, sessionToken ? { sessionToken } : "skip");
  const cashier = useQuery(api.cashier.getCashier, sessionToken ? { sessionToken } : "skip");
  const recentRounds = useQuery(
    api.plinko.getRecentRounds,
    sessionToken ? { sessionToken } : "skip",
  );
  const canViewAdmin = Boolean(sessionToken && profile?.role === "admin");
  const adminMetrics = useQuery(
    api.admin.getSiteMetrics,
    canViewAdmin && isAdminOpen && sessionToken ? { sessionToken } : "skip",
  );
  const adminSupportLookup = useQuery(
    api.admin.getSupportLookup,
    canViewAdmin && isAdminOpen && adminTab === "support" && sessionToken && adminLookupRequest
      ? { ...adminLookupRequest, sessionToken }
      : "skip",
  );
  const accountProfile = isDevSignedIn ? DEV_PROFILE : profile;
  const accountLabel = accountProfile?.publicId ?? "Passkey";
  const profileStatus =
    authError ?? accountProfile?.accountState ?? (sessionToken ? "syncing" : "not linked");
  const isSignedIn = isDevSignedIn || Boolean(sessionToken && profile);
  const canUseDevSignIn = import.meta.env.DEV && !isSignedIn;
  const authBusyLabel =
    authBusy === "register"
      ? "Creating"
      : authBusy === "signin"
        ? "Signing in"
        : authBusy === "signout"
          ? "Signing out"
          : null;
  const authPanelStatus = authBusyLabel ?? profileStatus;
  const isWalletBacked = Boolean(sessionToken && profile);
  const hasCashierWallet = Boolean(cashier?.wallet);
  const walletAvailable = cashier?.wallet.availableBalance ?? 0;
  const walletHeld = cashier?.wallet.heldBalance ?? 0;
  const walletStatus = sessionToken ? (cashier ? "Ready" : "Syncing") : "Passkey required";
  const displayBalance = view.balance;
  const displayPlayHistory =
    isWalletBacked && recentRounds
      ? recentRounds
          .map((round) => ({
            bet: round.betAmount,
            id: round.id,
            multiplier: round.multiplier,
            payout: round.payoutAmount,
            slot: round.slot,
          }))
          .slice(0, PLAY_HISTORY_LIMIT)
      : view.playHistory;
  const gameNotice = gameError ?? view.betWarning;
  const cashierTransactions = cashier
    ? [...cashier.deposits, ...cashier.withdrawals]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, CASHIER_HISTORY_LIMIT)
    : [];

  function publish() {
    setView(snapshot(gameRef.current));
  }

  function syncMultipliers() {
    const state = gameRef.current;
    state.multipliers = buildMultipliers(state.rows, state.risk);
  }

  function currentBet() {
    const value = Number(gameRef.current.betInput);
    return Number.isFinite(value) ? clamp(Math.round(value), 1, 999999) : 1;
  }

  function setBet(value: number) {
    gameRef.current.betInput = String(clamp(Math.round(value), 1, 999999));
    publish();
  }

  function recordPayout(ball: ActiveBall, payout: number) {
    const state = gameRef.current;
    state.playHistory.unshift({
      id: ball.id,
      bet: ball.bet,
      payout,
      multiplier: ball.multiplier,
      slot: ball.drop.slot,
    });
    state.playHistory = state.playHistory.slice(0, PLAY_HISTORY_LIMIT);
  }

  async function createCommit(nonce: number): Promise<ServerCommit> {
    const serverSeed = randomServerSeed();
    const serverSeedHash = await commitServerSeed(serverSeed);
    return { serverSeed, serverSeedHash, nonce };
  }

  function totalAvailableCommits() {
    const fairness = gameRef.current.fairness;
    return fairness.commitQueue.length + (fairness.currentCommit ? 1 : 0);
  }

  async function refillCommitQueue() {
    const state = gameRef.current;
    if (state.fairness.refilling) return;

    state.fairness.refilling = true;
    publish();

    try {
      while (totalAvailableCommits() < COMMIT_QUEUE_TARGET) {
        const count = Math.min(COMMIT_BATCH_SIZE, COMMIT_QUEUE_TARGET - totalAvailableCommits());
        const commits = await Promise.all(
          Array.from({ length: count }, () => createCommit(state.fairness.nextNonce++)),
        );

        for (const commit of commits) {
          if (!state.fairness.currentCommit) {
            state.fairness.currentCommit = commit;
          } else {
            state.fairness.commitQueue.push(commit);
          }
        }

        publish();
      }
    } finally {
      state.fairness.refilling = false;
      publish();
    }
  }

  function consumeCommit() {
    const state = gameRef.current;
    const commit = state.fairness.currentCommit;
    if (!commit) return null;

    state.fairness.currentCommit = state.fairness.commitQueue.shift() ?? null;
    publish();
    void refillCommitQueue();
    return commit;
  }

  function currentClientSeed() {
    const state = gameRef.current;
    const value = state.fairness.clientSeed.trim() || "browser-client";
    state.fairness.clientSeed = value;
    return value;
  }

  function computeBoard() {
    const state = gameRef.current;
    const { width, height } = state.board;
    const sideInset = width < 620 ? 32 : 52;
    const topY = width < 620 ? 68 : 86;
    const binSpace = width < 620 ? 104 : 122;
    const rowGap = (height - topY - binSpace) / state.rows;
    const slotGap = Math.min((width - sideInset * 2) / state.rows, rowGap * 1.32);

    state.board.centerX = width / 2;
    state.board.topY = topY;
    state.board.rowGap = rowGap;
    state.board.slotGap = slotGap;
    state.board.binTop = topY + rowGap * state.rows + 16;
  }

  function boardPoint(layer: number, rights: number) {
    const { centerX, topY, rowGap, slotGap } = gameRef.current.board;
    return {
      x: centerX + (rights - layer / 2) * slotGap,
      y: topY - rowGap * 0.62 + layer * rowGap,
    };
  }

  function dropPathPoints(drop: Drop) {
    const points = drop.points.map((point: DropPoint) => boardPoint(point.layer, point.rights));
    const end = boardPoint(drop.rows, drop.slot);
    end.y = gameRef.current.board.binTop - 18;
    points.push(end);
    return points;
  }

  function dropFromSettledRound(round: SettledPlinkoRound): Drop {
    return {
      directions: [...round.directions],
      points: round.points.map((point) => ({ ...point })),
      rows: round.rows,
      slot: round.slot,
    };
  }

  function resizeCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gameRef.current.board.width = rect.width;
    gameRef.current.board.height = rect.height;
    computeBoard();
    draw(performance.now());
  }

  function drawBackground(ctx: CanvasRenderingContext2D) {
    const { width, height } = gameRef.current.board;
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#151922");
    gradient.addColorStop(1, "#0d1016");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    for (let y = 32; y < height; y += 42) {
      ctx.beginPath();
      ctx.moveTo(24, y);
      ctx.lineTo(width - 24, y);
      ctx.stroke();
    }
  }

  function drawPegs(ctx: CanvasRenderingContext2D, now: number) {
    const state = gameRef.current;
    const { topY, rowGap, slotGap, centerX } = state.board;
    const activeLayers = new Set(state.activeBalls.map((ball) => Math.floor(ball.progress)));

    for (let row = 0; row < state.rows; row += 1) {
      for (let peg = 0; peg <= row; peg += 1) {
        const x = centerX + (peg - row / 2) * slotGap;
        const y = topY + row * rowGap;
        const isActiveLayer = activeLayers.has(row);
        const pulse = isActiveLayer ? 1 + Math.sin(now / 95) * 0.1 : 1;
        const radius = clamp(slotGap * 0.09, 4.2, 7.2) * pulse;

        ctx.beginPath();
        ctx.arc(x, y, radius + 7, 0, Math.PI * 2);
        ctx.fillStyle = isActiveLayer ? "rgba(0, 228, 141, 0.14)" : "rgba(255, 255, 255, 0.035)";
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = isActiveLayer ? "#7dffd0" : "#eef5ff";
        ctx.fill();
      }
    }
  }

  function drawBins(ctx: CanvasRenderingContext2D) {
    const state = gameRef.current;
    const { centerX, slotGap, binTop, height } = state.board;
    const binHeight = Math.max(48, height - binTop - 22);
    const binWidth = slotGap * 0.9;
    const fontSize = clamp(binWidth * 0.36, 7, 15);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;

    for (let slot = 0; slot <= state.rows; slot += 1) {
      const x = centerX + (slot - state.rows / 2) * slotGap;
      const multiplier = state.multipliers[slot];
      const fill = multiplierColor(multiplier, slot, state.rows);
      const active = state.lastSlot === slot;

      roundedRect(ctx, x - binWidth / 2, binTop, binWidth, binHeight, 7);
      ctx.fillStyle = fill;
      ctx.globalAlpha = active ? 1 : 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (active) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.fillStyle = "#101319";
      ctx.fillText(`${multiplier}x`, x, binTop + binHeight / 2);
    }
  }

  function drawRails(ctx: CanvasRenderingContext2D) {
    const state = gameRef.current;
    const { centerX, topY, rowGap, slotGap, binTop } = state.board;
    const leftTop = centerX - slotGap * 0.45;
    const rightTop = centerX + slotGap * 0.45;
    const leftBottom = centerX - (state.rows / 2 + 0.8) * slotGap;
    const rightBottom = centerX + (state.rows / 2 + 0.8) * slotGap;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(leftTop, topY - rowGap * 0.76);
    ctx.lineTo(leftBottom, binTop - 18);
    ctx.moveTo(rightTop, topY - rowGap * 0.76);
    ctx.lineTo(rightBottom, binTop - 18);
    ctx.stroke();
  }

  function currentBall(ball: ActiveBall, now: number) {
    const elapsed = now - ball.startedAt;
    const progress = clamp(elapsed / ball.duration, 0, 1);
    const scaled = progress * (ball.points.length - 1);
    const segment = Math.min(Math.floor(scaled), ball.points.length - 2);
    const local = smoothstep(scaled - segment);
    const from = ball.points[segment];
    const to = ball.points[segment + 1];
    const x = from.x + (to.x - from.x) * local;
    const y = from.y + (to.y - from.y) * local - Math.sin(local * Math.PI) * 10;

    ball.progress = scaled;

    return { x, y, done: progress >= 1, ball };
  }

  function drawPathPreview(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = "rgba(0, 228, 141, 0.18)";
    ctx.lineWidth = 3;

    for (const ball of gameRef.current.activeBalls.slice(-12)) {
      ctx.beginPath();
      ball.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    }
  }

  function drawBall(ctx: CanvasRenderingContext2D, ball: { x: number; y: number } | null) {
    if (!ball) return;

    const radius = clamp(gameRef.current.board.slotGap * 0.16, 9, 15);
    const glow = ctx.createRadialGradient(
      ball.x,
      ball.y,
      radius * 0.25,
      ball.x,
      ball.y,
      radius * 1.9,
    );
    glow.addColorStop(0, "rgba(0, 228, 141, 0.58)");
    glow.addColorStop(1, "rgba(0, 228, 141, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, radius * 1.9, 0, Math.PI * 2);
    ctx.fill();

    const shell = ctx.createLinearGradient(
      ball.x - radius,
      ball.y - radius,
      ball.x + radius,
      ball.y + radius,
    );
    shell.addColorStop(0, "#eafff7");
    shell.addColorStop(0.35, "#00e48d");
    shell.addColorStop(1, "#008c62");
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function draw(now = performance.now()) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    drawBackground(ctx);
    drawRails(ctx);
    drawPegs(ctx, now);
    drawBins(ctx);
    drawPathPreview(ctx);

    const finished: ActiveBall[] = [];
    for (const activeBall of gameRef.current.activeBalls) {
      const ball = currentBall(activeBall, now);
      drawBall(ctx, ball);

      if (ball.done) {
        finished.push(activeBall);
      }
    }

    if (finished.length > 0) {
      finishDrops(finished);
    }
  }

  function scheduleAnimation() {
    const state = gameRef.current;
    if (state.animationFrame !== null) return;

    state.animationFrame = requestAnimationFrame((now) => {
      state.animationFrame = null;
      draw(now);
      if (state.activeBalls.length > 0) {
        scheduleAnimation();
      }
    });
  }

  function finishDrops(finishedBalls: ActiveBall[]) {
    const state = gameRef.current;
    const finishedIds = new Set(finishedBalls.map((ball) => ball.id));
    state.activeBalls = state.activeBalls.filter((ball) => !finishedIds.has(ball.id));

    for (const ball of finishedBalls) {
      const win = ball.payoutAmount;

      if (ball.settlement === "local") {
        state.balance += win;
      }
      recordPayout(ball, win);
      state.lastWin = win;
      state.lastMultiplier = ball.multiplier;
      state.lastPath = [...ball.drop.directions];
      state.lastSlot = ball.drop.slot;
      state.dropCount += 1;
      state.fairness.lastProof = {
        serverSeed: ball.commit.serverSeed,
        serverSeedHash: ball.commit.serverSeedHash,
        clientSeed: ball.clientSeed,
        nonce: ball.commit.nonce,
        slot: ball.drop.slot,
        multiplier: ball.multiplier,
      };
    }

    publish();
  }

  async function startDrop() {
    const state = gameRef.current;
    const bet = currentBet();
    if (bet > playableBalance(state)) {
      setGameError("Bet exceeds available balance.");
      return;
    }

    if (state.usesServerSettlement) {
      if (!sessionToken) {
        setGameError("Sign in with a passkey account to play.");
        return;
      }

      const rows = state.rows;
      const risk = state.risk;
      const clientSeed = currentClientSeed();

      state.pendingDrops += 1;
      state.pendingServerBetTotal += bet;
      state.lastPath = [];
      state.lastSlot = null;
      state.lastWin = 0;
      state.lastMultiplier = 0;
      setGameError(null);
      publish();

      try {
        const result = await settlePlinkoDrop({
          betAmount: bet,
          clientSeed,
          requestId: newPlinkoRequestId(),
          risk,
          rows,
          sessionToken,
        });
        const round = result.round as SettledPlinkoRound;
        const drop = dropFromSettledRound(round);

        if (round.nonce >= state.latestServerWalletNonce) {
          state.balance = result.wallet.availableBalance;
          state.latestServerWalletNonce = round.nonce;
        }
        state.lastPath = [...drop.directions];
        state.activeBalls.push({
          bet,
          clientSeed: round.clientSeed,
          commit: {
            nonce: round.nonce,
            serverSeed: round.serverSeed,
            serverSeedHash: round.serverSeedHash,
          },
          drop,
          duration: 580 + round.rows * 165,
          id: state.nextBallId,
          multiplier: round.multiplier,
          payoutAmount: round.payoutAmount,
          points: dropPathPoints(drop),
          progress: 0,
          roundId: round.id,
          settlement: "server",
          startedAt: performance.now(),
        });
        state.nextBallId += 1;
        scheduleAnimation();
      } catch (error) {
        setGameError(error instanceof Error ? error.message : "Plinko settlement failed.");
      } finally {
        state.pendingDrops -= 1;
        state.pendingServerBetTotal = Math.max(0, state.pendingServerBetTotal - bet);
        publish();
      }

      return;
    }

    const commit = consumeCommit();
    if (!commit) return;

    const rows = state.rows;
    const clientSeed = currentClientSeed();
    const multipliers = [...state.multipliers];
    state.balance -= bet;
    state.pendingDrops += 1;
    state.lastPath = [];
    state.lastSlot = null;
    state.lastWin = 0;
    state.lastMultiplier = 0;
    setGameError(null);
    publish();

    try {
      const drop = await buildProvablyFairDrop(rows, {
        serverSeed: commit.serverSeed,
        serverSeedHash: commit.serverSeedHash,
        clientSeed,
        nonce: commit.nonce,
      });

      state.lastPath = [...drop.directions];
      state.activeBalls.push({
        bet,
        clientSeed,
        commit,
        drop,
        duration: 580 + rows * 165,
        id: state.nextBallId,
        multiplier: multipliers[drop.slot],
        payoutAmount: Math.floor(bet * multipliers[drop.slot]),
        points: dropPathPoints(drop),
        progress: 0,
        settlement: "local",
        startedAt: performance.now(),
      });
      state.nextBallId += 1;
      scheduleAnimation();
    } catch (error) {
      state.balance += bet;
      console.error(error);
    } finally {
      state.pendingDrops -= 1;
      publish();
    }
  }

  function requestDropActivation() {
    const now = performance.now();
    if (now - lastDropActivationAtRef.current < MIN_DROP_ACTIVATION_MS) return;

    lastDropActivationAtRef.current = now;
    void startDrop();
  }

  function handleRowsChange(value: string) {
    const state = gameRef.current;
    state.rows = parseRowsSetting(value) ?? state.rows;
    syncMultipliers();
    computeBoard();
    saveSettings(state);
    publish();
    draw(performance.now());
  }

  function handleRiskChange(risk: Risk) {
    const state = gameRef.current;
    state.risk = parseRiskSetting(risk) ?? DEFAULT_RISK;
    syncMultipliers();
    saveSettings(state);
    publish();
    draw(performance.now());
  }

  function handleDropPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || view.isDropDisabled || pointerDropActiveRef.current) return;
    event.preventDefault();
    pointerDropActiveRef.current = true;
    requestDropActivation();
  }

  function handleDropKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (
      event.repeat ||
      keyDropActiveRef.current ||
      !["Enter", " "].includes(event.key) ||
      view.isDropDisabled
    ) {
      return;
    }

    event.preventDefault();
    keyDropActiveRef.current = true;
    requestDropActivation();
  }

  function handleDropKeyUp(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (["Enter", " "].includes(event.key)) {
      keyDropActiveRef.current = false;
    }
  }

  function getCurrentPasskeyContext() {
    if (!browserSupportsWebAuthn()) {
      throw new Error("This browser does not support passkeys.");
    }

    if (window.location.protocol === "http:" && window.location.hostname !== "localhost") {
      const localUrl = `http://localhost${window.location.port ? `:${window.location.port}` : ""}`;
      throw new Error(`Open ${localUrl} to use passkeys in local development.`);
    }

    return {
      origin: window.location.origin,
      rpId: window.location.hostname,
    };
  }

  async function handleCreatePasskey() {
    setAuthBusy("register");
    setAuthError(null);

    try {
      const options = await beginPasskeyRegistration(getCurrentPasskeyContext());
      const response = await startRegistration({ optionsJSON: options });
      const result = await verifyPasskeyRegistration({
        challenge: options.challenge,
        response,
      });

      savePasskeySession(result.sessionToken);
      setSessionToken(result.sessionToken);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Passkey setup failed.");
    } finally {
      setAuthBusy(null);
    }
  }

  async function handleSignInPasskey() {
    setAuthBusy("signin");
    setAuthError(null);

    try {
      const options = await beginPasskeyAuthentication(getCurrentPasskeyContext());
      const response = await startAuthentication({ optionsJSON: options });
      const result = await verifyPasskeyAuthentication({
        challenge: options.challenge,
        response,
      });

      savePasskeySession(result.sessionToken);
      setSessionToken(result.sessionToken);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Passkey sign-in failed.");
    } finally {
      setAuthBusy(null);
    }
  }

  async function handlePasskeySignOut() {
    const token = sessionToken;

    setAuthBusy("signout");
    setAuthError(null);
    setIsDevSignedIn(false);
    clearPasskeySession();
    setSessionToken(null);
    setIsAdminOpen(false);
    setIsCashierOpen(false);

    try {
      if (token) {
        await signOutPasskey({ sessionToken: token });
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Passkey sign-out failed.");
    } finally {
      setAuthBusy(null);
    }
  }

  function handleDevSignIn() {
    setAuthError(null);
    setIsDevSignedIn(true);
  }

  function openCashier(tab: CashierTab = "deposit") {
    setCashierTab(tab);
    setCashierError(null);
    setIsCashierOpen(true);
  }

  async function runCashierAction(action: CashierBusy, task: (token: string) => Promise<unknown>) {
    if (!sessionToken) {
      setCashierError("Sign in with a passkey account to use the cashier.");
      return;
    }

    setCashierBusy(action);
    setCashierError(null);

    try {
      await task(sessionToken);
    } catch (error) {
      setCashierError(error instanceof Error ? error.message : "Cashier action failed.");
    } finally {
      setCashierBusy(null);
    }
  }

  async function handleCreateDeposit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const amount = parseCashierAmount(depositInput);
    if (!amount) {
      setCashierError("Enter a whole number of sats to deposit.");
      return;
    }

    await runCashierAction("deposit:create", async (token) => {
      await createLightningDeposit({
        amount,
        requestId: newCashierRequestId("deposit"),
        sessionToken: token,
      });
      setDepositInput(DEFAULT_DEPOSIT_AMOUNT);
      setCashierTab("history");
    });
  }

  async function handleCreateWithdrawal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const amount = parseCashierAmount(withdrawInput);
    if (!amount) {
      setCashierError("Enter a whole number of sats to withdraw.");
      return;
    }

    const paymentRequest = withdrawInvoiceInput.trim();
    if (!paymentRequest) {
      setCashierError("Paste a Lightning invoice to withdraw.");
      return;
    }

    await runCashierAction("withdrawal:create", async (token) => {
      await createLightningWithdrawal({
        amount,
        paymentRequest,
        requestId: newCashierRequestId("withdrawal"),
        sessionToken: token,
      });
      setWithdrawInput(DEFAULT_WITHDRAW_AMOUNT);
      setWithdrawInvoiceInput(DEFAULT_WITHDRAW_INVOICE);
      setCashierTab("history");
    });
  }

  function handleAdminLookup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const next: AdminLookupRequest = {};
    const userId = adminLookupUserId.trim();
    const publicId = adminLookupPublicId.trim();
    const depositId = adminLookupDepositId.trim();
    const withdrawalId = adminLookupWithdrawalId.trim();
    const roundId = adminLookupRoundId.trim();

    if (userId) next.userId = userId as Id<"users">;
    if (publicId) next.publicId = publicId;
    if (depositId) next.depositId = depositId as Id<"deposits">;
    if (withdrawalId) next.withdrawalId = withdrawalId as Id<"withdrawals">;
    if (roundId) next.roundId = roundId as Id<"gameRounds">;

    if (Object.keys(next).length === 0) {
      setAdminError("Enter at least one lookup value.");
      return;
    }

    setAdminError(null);
    setAdminLookupRequest(next);
  }

  async function runAdminAction(task: AdminBusy, action: (token: string) => Promise<unknown>) {
    if (!sessionToken) {
      setAdminError("Admin session required.");
      return;
    }

    setAdminBusy(task);
    setAdminError(null);

    try {
      await action(sessionToken);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Admin action failed.");
    } finally {
      setAdminBusy(null);
    }
  }

  function currentAdminUserId() {
    const userId = adminSupportLookup?.user?.id;
    return userId ? (userId as Id<"users">) : null;
  }

  async function handleAdminAccountState(
    state: "active" | "locked" | "pending_review" | "disabled",
  ) {
    const userId = currentAdminUserId();
    if (!userId) {
      setAdminError("Look up a user first.");
      return;
    }

    await runAdminAction("account", async (token) => {
      await setAdminUserAccountState({
        reason: adminReason,
        sessionToken: token,
        state,
        userId,
      });
    });
  }

  async function handleAdminAdjustment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const userId = currentAdminUserId();
    const amount = parseCashierAmount(adminAdjustmentInput);

    if (!userId) {
      setAdminError("Look up a user first.");
      return;
    }

    if (!amount) {
      setAdminError("Enter a whole number of sats to adjust.");
      return;
    }

    await runAdminAction("adjustment", async (token) => {
      await manualAdminBalanceAdjustment({
        amount,
        direction: adminAdjustmentDirection,
        reason: adminReason,
        requestId: newAdminRequestId(),
        sessionToken: token,
        userId,
      });
    });
  }

  useEffect(() => {
    if (sessionToken && profile === null) {
      clearPasskeySession();
      setSessionToken(null);
    }
  }, [profile, sessionToken]);

  useEffect(() => {
    if (!sessionToken || !profile) {
      ensuredWalletSessionRef.current = null;
      return;
    }

    if (ensuredWalletSessionRef.current === sessionToken) {
      return;
    }

    ensuredWalletSessionRef.current = sessionToken;
    ensureWallet({ sessionToken }).catch((error) => {
      ensuredWalletSessionRef.current = null;
      setAuthError(error instanceof Error ? error.message : "Wallet setup failed.");
    });
  }, [ensureWallet, profile, sessionToken]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: publish snapshots mutable game state after wallet/session changes.
  useEffect(() => {
    const state = gameRef.current;
    const usesServerSettlement = Boolean(sessionToken && profile);
    const walletReady = !usesServerSettlement || hasCashierWallet;

    state.usesServerSettlement = usesServerSettlement;
    state.serverSettlementReady = walletReady;

    if (usesServerSettlement && hasCashierWallet) {
      state.balance = walletAvailable;
    }

    publish();
  }, [hasCashierWallet, profile, sessionToken, walletAvailable]);

  useEffect(() => {
    if (!isCashierOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsCashierOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCashierOpen]);

  useEffect(() => {
    if (!isAdminOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsAdminOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAdminOpen]);

  useEffect(() => {
    if (!canViewAdmin) {
      setIsAdminOpen(false);
    }
  }, [canViewAdmin]);

  useEffect(() => {
    if (!isSignedIn) {
      setIsControlSheetHidden(false);
      return;
    }

    const mobileQuery = window.matchMedia("(max-width: 900px)");
    lastScrollYRef.current = window.scrollY;

    function syncSheetForViewport() {
      if (!mobileQuery.matches) {
        setIsControlSheetHidden(false);
      }
    }

    function handleScroll() {
      if (!mobileQuery.matches) return;

      const nextScrollY = Math.max(0, window.scrollY);
      const delta = nextScrollY - lastScrollYRef.current;
      if (Math.abs(delta) < 8) return;

      setIsControlSheetHidden(nextScrollY > 24 && delta > 0);
      lastScrollYRef.current = nextScrollY;
    }

    syncSheetForViewport();
    window.addEventListener("scroll", handleScroll, { passive: true });
    mobileQuery.addEventListener("change", syncSheetForViewport);

    return () => {
      window.removeEventListener("scroll", handleScroll);
      mobileQuery.removeEventListener("change", syncSheetForViewport);
    };
  }, [isSignedIn]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: this mounts canvas observers and commit prefill once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(canvas);
    void refillCommitQueue();

    function releasePointerDrop() {
      pointerDropActiveRef.current = false;
    }

    window.addEventListener("pointerup", releasePointerDrop);
    window.addEventListener("pointercancel", releasePointerDrop);

    return () => {
      observer.disconnect();
      window.removeEventListener("pointerup", releasePointerDrop);
      window.removeEventListener("pointercancel", releasePointerDrop);
      if (gameRef.current.animationFrame !== null) {
        cancelAnimationFrame(gameRef.current.animationFrame);
      }
    };
  }, []);

  useEffect(() => {
    window.plinkoDebug = {
      buildDrop,
      buildMultipliers,
      buildProvablyFairDrop,
      verifyProvablyFairDrop,
      getState: () => {
        const state = gameRef.current;
        return {
          balance: state.balance,
          rows: state.rows,
          risk: state.risk,
          active: state.activeBalls.length,
          pending: state.pendingDrops,
          pendingServerBetTotal: state.pendingServerBetTotal,
          playableBalance: playableBalance(state),
          currentServerHash: state.fairness.currentCommit?.serverSeedHash,
          currentNonce: state.fairness.currentCommit?.nonce,
          lastProof: state.fairness.lastProof,
          lastPath: [...state.lastPath],
          lastSlot: state.lastSlot,
          playHistory: state.playHistory.map((entry) => ({ ...entry })),
        };
      },
    };
  });

  const shellClassName = [
    "app-shell",
    isSignedIn ? "is-playing" : "is-logged-out",
    isControlSheetHidden ? "is-control-sheet-hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <main className={shellClassName}>
        <section
          className={`control-panel ${isSignedIn ? "play-panel" : "auth-panel"}`}
          aria-label={isSignedIn ? "Game controls" : "Account access"}
        >
          {isSignedIn ? (
            <>
              <div className="play-hero">
                <div className="play-title">
                  <p className="eyebrow">Account active</p>
                  <h1>Plinko</h1>
                </div>
                <div className="panel-actions">
                  {canViewAdmin ? (
                    <button
                      className="panel-link"
                      type="button"
                      onClick={() => setIsAdminOpen(true)}
                    >
                      Admin
                    </button>
                  ) : null}
                  <button
                    className="panel-link"
                    type="button"
                    disabled={authBusy !== null}
                    onClick={handlePasskeySignOut}
                  >
                    Sign out
                  </button>
                </div>
              </div>

              <div className="play-ledger" aria-label="Account summary">
                <div className="ledger-balance">
                  <span>Balance</span>
                  <strong id="balance">{formatNumber(displayBalance, 0)}</strong>
                  <small>Sats</small>
                </div>
                <div>
                  <span>Available</span>
                  <strong>
                    {sessionToken ? `${formatNumber(walletAvailable, 0)} sats` : walletStatus}
                  </strong>
                </div>
                <div>
                  <span>Held</span>
                  <strong>{sessionToken ? `${formatNumber(walletHeld, 0)} sats` : "0 sats"}</strong>
                </div>
                <div>
                  <span>Account</span>
                  <strong>{accountLabel}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong className={authError ? "error" : ""}>{profileStatus}</strong>
                </div>
              </div>

              <button
                className="cashier-strip"
                type="button"
                onClick={() => openCashier("deposit")}
              >
                <span>Cashier</span>
                <strong>{walletStatus}</strong>
              </button>

              <div className="game-control-group">
                <div className="field">
                  <label htmlFor="bet">Bet</label>
                  <div className="bet-control">
                    <button
                      className="icon-button"
                      type="button"
                      id="halfBet"
                      aria-label="Halve bet"
                      disabled={view.isBetControlsDisabled}
                      onClick={() => setBet(currentBet() / 2)}
                    >
                      1/2
                    </button>
                    <input
                      id="bet"
                      type="number"
                      min="1"
                      step="1"
                      value={view.betInput}
                      inputMode="decimal"
                      disabled={view.isBetControlsDisabled}
                      onChange={(event) => {
                        gameRef.current.betInput = event.target.value;
                        setGameError(null);
                        publish();
                      }}
                      onBlur={() => setBet(currentBet())}
                    />
                    <button
                      className="icon-button"
                      type="button"
                      id="doubleBet"
                      aria-label="Double bet"
                      disabled={view.isBetControlsDisabled}
                      onClick={() => setBet(currentBet() * 2)}
                    >
                      2x
                    </button>
                  </div>
                </div>

                <div className="field">
                  <div className="label-row">
                    <label htmlFor="rows">Rows</label>
                    <output id="rowValue" htmlFor="rows">
                      {view.rows}
                    </output>
                  </div>
                  <input
                    id="rows"
                    type="range"
                    min={ROW_MIN}
                    max={ROW_MAX}
                    step={ROW_STEP}
                    value={view.rows}
                    disabled={view.isSettingsLocked}
                    onChange={(event) => handleRowsChange(event.target.value)}
                  />
                </div>

                <div className="field">
                  <span className="control-label">Risk</span>
                  <fieldset className="segmented" aria-label="Risk level">
                    {(Object.keys(RISKS) as Risk[]).map((risk) => (
                      <button
                        key={risk}
                        type="button"
                        data-risk={risk}
                        className={risk === view.risk ? "active" : ""}
                        disabled={view.isSettingsLocked}
                        onClick={() => handleRiskChange(risk)}
                      >
                        {RISKS[risk].label}
                      </button>
                    ))}
                  </fieldset>
                </div>

                <button
                  id="dropButton"
                  className="drop-button"
                  type="button"
                  disabled={view.isDropDisabled}
                  onPointerDown={handleDropPointerDown}
                  onKeyDown={handleDropKeyDown}
                  onKeyUp={handleDropKeyUp}
                >
                  {view.dropButtonLabel}
                </button>
                {gameNotice ? (
                  <div className="game-alert" role="alert">
                    {gameNotice}
                  </div>
                ) : null}
              </div>

              <div className="history-panel" aria-label="Play history">
                <div className="label-row">
                  <span className="control-label">Play history</span>
                  <span id="historyCount">Last {PLAY_HISTORY_LIMIT}</span>
                </div>
                <ol id="playHistory" className="play-history" aria-live="polite">
                  {displayPlayHistory.length === 0 ? (
                    <li className="history-empty">No payouts yet</li>
                  ) : (
                    displayPlayHistory.map((entry) => {
                      const multiplier = `${entry.multiplier.toFixed(2)}x`;
                      return (
                        <li
                          key={entry.id}
                          className={`history-item ${payoutTone(entry)}`}
                          aria-label={`Payout ${formatNumber(entry.payout, 0)} sats at ${multiplier}`}
                        >
                          <strong>{formatNumber(entry.payout, 0)}</strong>
                          <span>{multiplier}</span>
                        </li>
                      );
                    })
                  )}
                </ol>
              </div>

              <div className="fairness-panel">
                <div className="label-row">
                  <span className="control-label">Provably fair</span>
                  <span id="fairNonce">{view.fairNonce}</span>
                </div>
                <div className="field">
                  <label htmlFor="clientSeed">Client seed</label>
                  <input
                    id="clientSeed"
                    type="text"
                    value={view.clientSeed}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => {
                      gameRef.current.fairness.clientSeed = event.target.value;
                      publish();
                    }}
                  />
                </div>
                <div className="seed-grid">
                  <span>Server hash</span>
                  <code id="serverHash">{view.serverHash}</code>
                  <span>Revealed seed</span>
                  <code id="revealedSeed">{view.revealedSeed}</code>
                  <span>Proof</span>
                  <code id="proofResult">{view.proofResult}</code>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="auth-hero">
                <p className="eyebrow">Account access</p>
                <h1>Plinko</h1>
              </div>

              <div className="auth-status" aria-live="polite">
                <span>Anonymous</span>
                <strong>{accountLabel}</strong>
                <small className={authError ? "error" : ""}>{authPanelStatus}</small>
              </div>

              <div className="auth-actions">
                <button
                  className="auth-primary"
                  type="button"
                  disabled={authBusy !== null}
                  onClick={handleCreatePasskey}
                >
                  Create account
                </button>
                <button
                  className="auth-secondary"
                  type="button"
                  disabled={authBusy !== null}
                  onClick={handleSignInPasskey}
                >
                  Sign in
                </button>
                {canUseDevSignIn ? (
                  <button className="auth-dev" type="button" onClick={handleDevSignIn}>
                    Enter dev mode
                  </button>
                ) : null}
              </div>

              <div className="auth-ledger" aria-label="Account status">
                <span>Status</span>
                <strong>{authPanelStatus}</strong>
                <span>Unit</span>
                <strong>Sats</strong>
                <span>Cashier</span>
                <strong>Locked</strong>
              </div>
            </>
          )}
        </section>

        <section
          className={`board-panel ${isSignedIn ? "" : "board-preview"}`}
          aria-label="Plinko board"
        >
          <canvas
            ref={canvasRef}
            id="board"
            width="1200"
            height="1200"
            aria-label="Plinko game board"
          />
          {isSignedIn ? (
            <div className="board-hud" aria-hidden="true">
              <span>{formatNumber(displayBalance, 0)} sats</span>
              <span>{sessionToken ? `held ${formatNumber(walletHeld, 0)}` : profileStatus}</span>
            </div>
          ) : null}
          {!isSignedIn ? (
            <div className="board-lock" aria-hidden="true">
              <span>Passkey account</span>
              <strong>Sign in to play</strong>
            </div>
          ) : null}
        </section>
      </main>

      {isCashierOpen ? (
        <div
          className="cashier-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsCashierOpen(false);
            }
          }}
        >
          <dialog className="cashier-drawer" aria-labelledby="cashierTitle" open>
            <header className="cashier-header">
              <div>
                <p className="eyebrow">Cashier</p>
                <h2 id="cashierTitle">Wallet</h2>
              </div>
              <button className="panel-link" type="button" onClick={() => setIsCashierOpen(false)}>
                Close
              </button>
            </header>

            <div className="cashier-balance-grid" aria-label="Wallet balance">
              <div>
                <span>Available</span>
                <strong>{formatNumber(walletAvailable, 0)}</strong>
                <small>Sats</small>
              </div>
              <div>
                <span>Held</span>
                <strong>{formatNumber(walletHeld, 0)}</strong>
                <small>Sats</small>
              </div>
              <div>
                <span>Status</span>
                <strong>{walletStatus}</strong>
              </div>
            </div>

            {cashierError ? (
              <div className="cashier-alert" role="alert">
                {cashierError}
              </div>
            ) : null}

            {!sessionToken ? (
              <div className="cashier-empty">Passkey account required</div>
            ) : (
              <>
                <div className="cashier-tabs" role="tablist" aria-label="Cashier sections">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cashierTab === "deposit"}
                    className={cashierTab === "deposit" ? "active" : ""}
                    onClick={() => setCashierTab("deposit")}
                  >
                    Deposit
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cashierTab === "withdraw"}
                    className={cashierTab === "withdraw" ? "active" : ""}
                    onClick={() => setCashierTab("withdraw")}
                  >
                    Withdraw
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cashierTab === "history"}
                    className={cashierTab === "history" ? "active" : ""}
                    onClick={() => setCashierTab("history")}
                  >
                    History
                  </button>
                </div>

                {cashierTab === "deposit" ? (
                  <form className="cashier-form" onSubmit={handleCreateDeposit}>
                    <label htmlFor="depositAmount">Deposit amount</label>
                    <div className="cashier-amount-row">
                      <input
                        id="depositAmount"
                        type="number"
                        min="1"
                        step="1"
                        inputMode="numeric"
                        value={depositInput}
                        onChange={(event) => setDepositInput(event.target.value)}
                      />
                      <span>Sats</span>
                    </div>
                    <button className="auth-primary" type="submit" disabled={cashierBusy !== null}>
                      Create Deposit
                    </button>
                  </form>
                ) : null}

                {cashierTab === "withdraw" ? (
                  <form className="cashier-form" onSubmit={handleCreateWithdrawal}>
                    <label htmlFor="withdrawAmount">Withdraw amount</label>
                    <div className="cashier-amount-row">
                      <input
                        id="withdrawAmount"
                        type="number"
                        min="1"
                        step="1"
                        inputMode="numeric"
                        value={withdrawInput}
                        onChange={(event) => setWithdrawInput(event.target.value)}
                      />
                      <span>Sats</span>
                    </div>
                    <label htmlFor="withdrawInvoice">Lightning invoice</label>
                    <textarea
                      id="withdrawInvoice"
                      value={withdrawInvoiceInput}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => setWithdrawInvoiceInput(event.target.value)}
                    />
                    <button className="auth-primary" type="submit" disabled={cashierBusy !== null}>
                      Pay Invoice
                    </button>
                  </form>
                ) : null}

                {cashierTab === "history" ? (
                  <div className="cashier-history" aria-live="polite">
                    {cashierTransactions.length === 0 ? (
                      <div className="cashier-empty">No cashier activity</div>
                    ) : (
                      <ol className="cashier-transaction-list">
                        {cashierTransactions.map((entry) => (
                          <li
                            key={`${entry.type}-${entry.id}`}
                            className={`cashier-transaction ${entry.status}`}
                          >
                            <div className="cashier-transaction-main">
                              <div>
                                <strong>{formatCashierType(entry.type)}</strong>
                                <span>
                                  {entry.provider === "lnd" ? "Lightning" : "Manual"} /{" "}
                                  {formatCashierDate(entry.createdAt)}
                                </span>
                              </div>
                              <div>
                                <strong>{formatNumber(entry.amount, 0)}</strong>
                                <span>Sats</span>
                              </div>
                              <span className={`cashier-status ${entry.status}`}>
                                {entry.status}
                              </span>
                            </div>

                            {entry.providerError ? (
                              <div className="cashier-provider-error">{entry.providerError}</div>
                            ) : null}

                            {entry.type === "deposit" && entry.lightningPaymentRequest ? (
                              <div className="cashier-invoice-box">
                                <span>Lightning invoice</span>
                                <code>{entry.lightningPaymentRequest}</code>
                              </div>
                            ) : null}

                            {entry.type === "withdrawal" && entry.lightningPaymentRequest ? (
                              <div className="cashier-invoice-box">
                                <span>Paid invoice</span>
                                <code>{entry.lightningPaymentRequest}</code>
                              </div>
                            ) : null}

                            <div className="cashier-transaction-actions">
                              {entry.type === "deposit" && entry.lightningPaymentRequest ? (
                                <button
                                  type="button"
                                  disabled={cashierBusy !== null}
                                  onClick={() =>
                                    void navigator.clipboard?.writeText(
                                      entry.lightningPaymentRequest ?? "",
                                    )
                                  }
                                >
                                  Copy
                                </button>
                              ) : null}

                              {entry.status === "pending" && entry.type === "deposit" ? (
                                <button
                                  type="button"
                                  disabled={cashierBusy !== null}
                                  onClick={() =>
                                    void runCashierAction("deposit:sync", (token) =>
                                      syncLightningDeposit({
                                        depositId: entry.id,
                                        sessionToken: token,
                                      }),
                                    )
                                  }
                                >
                                  Check Payment
                                </button>
                              ) : null}

                              {entry.status === "pending" && entry.type === "withdrawal" ? (
                                <button
                                  type="button"
                                  disabled={cashierBusy !== null}
                                  onClick={() =>
                                    void runCashierAction("withdrawal:sync", (token) =>
                                      syncLightningWithdrawal({
                                        sessionToken: token,
                                        withdrawalId: entry.id,
                                      }),
                                    )
                                  }
                                >
                                  Check Status
                                </button>
                              ) : null}

                              {entry.status === "pending" && entry.provider !== "lnd" ? (
                                <button
                                  type="button"
                                  disabled={cashierBusy !== null}
                                  onClick={() =>
                                    void runCashierAction(
                                      entry.type === "deposit"
                                        ? "deposit:cancel"
                                        : "withdrawal:cancel",
                                      (token) =>
                                        entry.type === "deposit"
                                          ? cancelFakeDeposit({
                                              depositId: entry.id,
                                              sessionToken: token,
                                            })
                                          : cancelFakeWithdrawal({
                                              sessionToken: token,
                                              withdrawalId: entry.id,
                                            }),
                                    )
                                  }
                                >
                                  Cancel
                                </button>
                              ) : null}

                              {canRetryCashierStatus(entry.status) ? (
                                <button
                                  type="button"
                                  disabled={cashierBusy !== null}
                                  onClick={() => {
                                    if (entry.type === "deposit") {
                                      setDepositInput(String(entry.amount));
                                      setCashierTab("deposit");
                                    } else {
                                      setWithdrawInput(String(entry.amount));
                                      setWithdrawInvoiceInput(entry.lightningPaymentRequest ?? "");
                                      setCashierTab("withdraw");
                                    }
                                  }}
                                >
                                  Retry
                                </button>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </dialog>
        </div>
      ) : null}

      {isAdminOpen && canViewAdmin ? (
        <div
          className="cashier-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsAdminOpen(false);
            }
          }}
        >
          <dialog className="cashier-drawer admin-drawer" aria-labelledby="adminTitle" open>
            <header className="cashier-header">
              <div>
                <p className="eyebrow">Admin</p>
                <h2 id="adminTitle">Site Numbers</h2>
              </div>
              <button className="panel-link" type="button" onClick={() => setIsAdminOpen(false)}>
                Close
              </button>
            </header>

            <div className="admin-tabs" role="tablist" aria-label="Admin sections">
              <button
                type="button"
                role="tab"
                aria-selected={adminTab === "overview"}
                className={adminTab === "overview" ? "active" : ""}
                onClick={() => setAdminTab("overview")}
              >
                Overview
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={adminTab === "support"}
                className={adminTab === "support" ? "active" : ""}
                onClick={() => setAdminTab("support")}
              >
                Support
              </button>
            </div>

            {adminError ? (
              <div className="cashier-alert" role="alert">
                {adminError}
              </div>
            ) : null}

            {adminTab === "overview" ? (
              !adminMetrics ? (
                <div className="cashier-empty">Loading metrics</div>
              ) : (
                <>
                  <div className="admin-meta-row">
                    <span>Generated</span>
                    <strong>{formatAdminDate(adminMetrics.generatedAt)}</strong>
                  </div>

                  <section className="admin-metric-grid" aria-label="Site totals">
                    <article className="admin-metric">
                      <span>Players</span>
                      <strong>{formatNumber(adminMetrics.users.totalCount, 0)}</strong>
                      <small>{formatNumber(adminMetrics.users.active24h, 0)} active 24h</small>
                    </article>
                    <article className="admin-metric">
                      <span>Wallets</span>
                      <strong>{formatNumber(adminMetrics.wallets.totalBalance, 0)}</strong>
                      <small>{formatNumber(adminMetrics.wallets.heldBalance, 0)} held</small>
                    </article>
                    <article className="admin-metric">
                      <span>Deposits</span>
                      <strong>
                        {formatNumber(adminMetrics.deposits.lifetime.completedAmount, 0)}
                      </strong>
                      <small>
                        {formatNumber(adminMetrics.deposits.lifetime.pendingAmount, 0)} pending
                      </small>
                    </article>
                    <article className="admin-metric">
                      <span>Withdrawals</span>
                      <strong>
                        {formatNumber(adminMetrics.withdrawals.lifetime.completedAmount, 0)}
                      </strong>
                      <small>
                        {formatNumber(adminMetrics.withdrawals.lifetime.pendingAmount, 0)} pending
                      </small>
                    </article>
                    <article className="admin-metric">
                      <span>Wagered</span>
                      <strong>{formatNumber(adminMetrics.rounds.lifetime.wageredAmount, 0)}</strong>
                      <small>
                        {formatNumber(adminMetrics.rounds.last24h.wageredAmount, 0)} in 24h
                      </small>
                    </article>
                    <article className="admin-metric">
                      <span>Net</span>
                      <strong>
                        {formatNetAmount(adminMetrics.rounds.lifetime.netRevenueAmount)}
                      </strong>
                      <small>{formatPercent(adminMetrics.rounds.lifetime.holdPercent)} hold</small>
                    </article>
                  </section>

                  <section className="admin-risk-grid" aria-label="Operational review">
                    <div>
                      <span>Pending deposits</span>
                      <strong>{adminMetrics.deposits.lifetime.pendingCount}</strong>
                    </div>
                    <div>
                      <span>Pending withdrawals</span>
                      <strong>{adminMetrics.withdrawals.lifetime.pendingCount}</strong>
                    </div>
                    <div>
                      <span>Settling rounds</span>
                      <strong>{adminMetrics.rounds.lifetime.settlingCount}</strong>
                    </div>
                    <div>
                      <span>Failed rounds</span>
                      <strong>{adminMetrics.rounds.lifetime.failedCount}</strong>
                    </div>
                    <div>
                      <span>Locked users</span>
                      <strong>{adminMetrics.users.lockedCount}</strong>
                    </div>
                    <div>
                      <span>Review users</span>
                      <strong>{adminMetrics.users.pendingReviewCount}</strong>
                    </div>
                  </section>

                  <section className="admin-risk-grid" aria-label="Work queue">
                    <div>
                      <span>Stuck deposits</span>
                      <strong>{adminMetrics.workQueue.stuckDeposits.length}</strong>
                    </div>
                    <div>
                      <span>Stuck withdrawals</span>
                      <strong>{adminMetrics.workQueue.stuckWithdrawals.length}</strong>
                    </div>
                    <div>
                      <span>Delayed rounds</span>
                      <strong>{adminMetrics.workQueue.settlingRounds.length}</strong>
                    </div>
                    <div>
                      <span>Failed rounds</span>
                      <strong>{adminMetrics.workQueue.failedRounds.length}</strong>
                    </div>
                  </section>

                  <section className="admin-section" aria-label="Recent rounds">
                    <div className="label-row">
                      <span className="control-label">Recent rounds</span>
                      <span>Last {adminMetrics.recentRounds.length}</span>
                    </div>
                    <ol className="admin-list">
                      {adminMetrics.recentRounds.length === 0 ? (
                        <li className="cashier-empty">No rounds</li>
                      ) : (
                        adminMetrics.recentRounds.map((round) => (
                          <li key={round.id} className={`admin-row ${round.status}`}>
                            <div>
                              <strong>{formatNumber(round.betAmount, 0)} bet</strong>
                              <span>{formatAdminDate(round.createdAt)}</span>
                            </div>
                            <div>
                              <strong>{formatNumber(round.payoutAmount, 0)} paid</strong>
                              <span>
                                {round.multiplier.toFixed(2)}x / {round.rows} / {round.risk}
                              </span>
                            </div>
                            <span className={`cashier-status ${round.status}`}>{round.status}</span>
                          </li>
                        ))
                      )}
                    </ol>
                  </section>

                  <section className="admin-section" aria-label="Recent cashier activity">
                    <div className="label-row">
                      <span className="control-label">Recent cashier</span>
                      <span>Last {adminMetrics.recentCashier.length}</span>
                    </div>
                    <ol className="admin-list">
                      {adminMetrics.recentCashier.length === 0 ? (
                        <li className="cashier-empty">No cashier activity</li>
                      ) : (
                        adminMetrics.recentCashier.map((entry) => (
                          <li key={entry.id} className={`admin-row ${entry.status}`}>
                            <div>
                              <strong>{formatCashierType(entry.type)}</strong>
                              <span>{formatAdminDate(entry.createdAt)}</span>
                            </div>
                            <div>
                              <strong>{formatNumber(entry.amount, 0)}</strong>
                              <span>{entry.userId}</span>
                            </div>
                            <span className={`cashier-status ${entry.status}`}>{entry.status}</span>
                          </li>
                        ))
                      )}
                    </ol>
                  </section>
                </>
              )
            ) : (
              <section className="admin-support" aria-label="Support tools">
                <form className="admin-lookup-form" onSubmit={handleAdminLookup}>
                  <label htmlFor="adminUserId">User ID</label>
                  <input
                    id="adminUserId"
                    type="text"
                    value={adminLookupUserId}
                    onChange={(event) => setAdminLookupUserId(event.target.value)}
                  />
                  <label htmlFor="adminPublicId">Public ID</label>
                  <input
                    id="adminPublicId"
                    type="text"
                    value={adminLookupPublicId}
                    onChange={(event) => setAdminLookupPublicId(event.target.value)}
                  />
                  <label htmlFor="adminDepositId">Deposit ID</label>
                  <input
                    id="adminDepositId"
                    type="text"
                    value={adminLookupDepositId}
                    onChange={(event) => setAdminLookupDepositId(event.target.value)}
                  />
                  <label htmlFor="adminWithdrawalId">Withdrawal ID</label>
                  <input
                    id="adminWithdrawalId"
                    type="text"
                    value={adminLookupWithdrawalId}
                    onChange={(event) => setAdminLookupWithdrawalId(event.target.value)}
                  />
                  <label htmlFor="adminRoundId">Round ID</label>
                  <input
                    id="adminRoundId"
                    type="text"
                    value={adminLookupRoundId}
                    onChange={(event) => setAdminLookupRoundId(event.target.value)}
                  />
                  <button className="auth-secondary" type="submit">
                    Search
                  </button>
                </form>

                {!adminLookupRequest ? (
                  <div className="cashier-empty">No lookup selected</div>
                ) : !adminSupportLookup ? (
                  <div className="cashier-empty">Loading lookup</div>
                ) : !adminSupportLookup.found || !adminSupportLookup.user ? (
                  <div className="cashier-empty">No matching user</div>
                ) : (
                  <>
                    <div className="admin-user-summary">
                      <div>
                        <span>User</span>
                        <strong>{adminSupportLookup.user.publicId}</strong>
                        <small>{adminSupportLookup.user.id}</small>
                      </div>
                      <div>
                        <span>Status</span>
                        <strong>{adminSupportLookup.user.accountState}</strong>
                        <small>{adminSupportLookup.user.role}</small>
                      </div>
                      <div>
                        <span>Wallet</span>
                        <strong>{formatNumber(adminSupportLookup.wallet.totalBalance, 0)}</strong>
                        <small>
                          {formatNumber(adminSupportLookup.wallet.availableBalance, 0)} available
                        </small>
                      </div>
                    </div>

                    <div className="admin-action-panel">
                      <label htmlFor="adminReason">Reason</label>
                      <input
                        id="adminReason"
                        type="text"
                        value={adminReason}
                        onChange={(event) => setAdminReason(event.target.value)}
                      />
                      <div className="admin-action-buttons">
                        <button
                          type="button"
                          disabled={adminBusy !== null}
                          onClick={() => void handleAdminAccountState("active")}
                        >
                          Unlock
                        </button>
                        <button
                          type="button"
                          disabled={adminBusy !== null}
                          onClick={() => void handleAdminAccountState("locked")}
                        >
                          Lock
                        </button>
                        <button
                          type="button"
                          disabled={adminBusy !== null}
                          onClick={() => void handleAdminAccountState("pending_review")}
                        >
                          Review
                        </button>
                        <button
                          type="button"
                          disabled={adminBusy !== null}
                          onClick={() => void handleAdminAccountState("disabled")}
                        >
                          Disable
                        </button>
                      </div>
                      <form className="admin-adjustment-form" onSubmit={handleAdminAdjustment}>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={adminAdjustmentInput}
                          onChange={(event) => setAdminAdjustmentInput(event.target.value)}
                        />
                        <select
                          value={adminAdjustmentDirection}
                          onChange={(event) =>
                            setAdminAdjustmentDirection(event.target.value as "credit" | "debit")
                          }
                        >
                          <option value="credit">Credit</option>
                          <option value="debit">Debit</option>
                        </select>
                        <button type="submit" disabled={adminBusy !== null}>
                          Adjust
                        </button>
                      </form>
                    </div>

                    <div className="admin-support-grid">
                      <section className="admin-section">
                        <div className="label-row">
                          <span className="control-label">Wallet events</span>
                          <span>{adminSupportLookup.walletEvents.length}</span>
                        </div>
                        <ol className="admin-list">
                          {adminSupportLookup.walletEvents.map((event) => (
                            <li key={event.id} className="admin-row">
                              <div>
                                <strong>{event.kind}</strong>
                                <span>{formatAdminDate(event.createdAt)}</span>
                              </div>
                              <div>
                                <strong>{formatNetAmount(event.availableDelta)}</strong>
                                <span>{formatNumber(event.availableBalanceAfter, 0)} after</span>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </section>

                      <section className="admin-section">
                        <div className="label-row">
                          <span className="control-label">Deposits</span>
                          <span>{adminSupportLookup.deposits.length}</span>
                        </div>
                        <ol className="admin-list">
                          {adminSupportLookup.deposits.map((deposit) => (
                            <li key={deposit.id} className={`admin-row ${deposit.status}`}>
                              <div>
                                <strong>{formatNumber(deposit.amount, 0)}</strong>
                                <span>{deposit.id}</span>
                              </div>
                              <div>
                                <strong>{deposit.status}</strong>
                                <span>
                                  {deposit.lightningState ?? deposit.provider ?? "manual"}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </section>

                      <section className="admin-section">
                        <div className="label-row">
                          <span className="control-label">Withdrawals</span>
                          <span>{adminSupportLookup.withdrawals.length}</span>
                        </div>
                        <ol className="admin-list">
                          {adminSupportLookup.withdrawals.map((withdrawal) => (
                            <li key={withdrawal.id} className={`admin-row ${withdrawal.status}`}>
                              <div>
                                <strong>{formatNumber(withdrawal.amount, 0)}</strong>
                                <span>{withdrawal.id}</span>
                              </div>
                              <div>
                                <strong>{withdrawal.status}</strong>
                                <span>
                                  {withdrawal.lightningState ?? withdrawal.provider ?? "manual"}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </section>

                      <section className="admin-section">
                        <div className="label-row">
                          <span className="control-label">Rounds</span>
                          <span>{adminSupportLookup.rounds.length}</span>
                        </div>
                        <ol className="admin-list">
                          {adminSupportLookup.rounds.map((round) => (
                            <li key={round.id} className={`admin-row ${round.status}`}>
                              <div>
                                <strong>{formatNumber(round.betAmount, 0)} bet</strong>
                                <span>{round.id}</span>
                              </div>
                              <div>
                                <strong>{formatNumber(round.payoutAmount, 0)} paid</strong>
                                <span>{round.status}</span>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </section>

                      <section className="admin-section">
                        <div className="label-row">
                          <span className="control-label">Admin actions</span>
                          <span>{adminSupportLookup.adminActions.length}</span>
                        </div>
                        <ol className="admin-list">
                          {adminSupportLookup.adminActions.map((action) => (
                            <li key={action.id} className="admin-row">
                              <div>
                                <strong>{action.action}</strong>
                                <span>{formatAdminDate(action.createdAt)}</span>
                              </div>
                              <div>
                                <strong>{action.reason}</strong>
                                <span>{action.targetId}</span>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </section>
                    </div>
                  </>
                )}
              </section>
            )}
          </dialog>
        </div>
      ) : null}
    </>
  );
}
