import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../convex/_generated/api";
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
  startedAt: number;
  duration: number;
  points: BoardPoint[];
  progress: number;
};

type PlayHistoryEntry = {
  id: number;
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
  lastPath: Array<"L" | "R">;
  lastSlot: number | null;
  lastWin: number;
  lastMultiplier: number;
  dropCount: number;
  playHistory: PlayHistoryEntry[];
  fairness: FairnessState;
  board: BoardState;
};

type ViewState = {
  balance: number;
  betInput: string;
  rows: number;
  risk: Risk;
  isSettingsLocked: boolean;
  isDropDisabled: boolean;
  playHistory: PlayHistoryEntry[];
  clientSeed: string;
  serverHash: string;
  fairNonce: string;
  revealedSeed: string;
  proofResult: string;
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
  };
}

function snapshot(state: GameState): ViewState {
  return {
    balance: state.balance,
    betInput: state.betInput,
    rows: state.rows,
    risk: state.risk,
    isSettingsLocked: state.activeBalls.length + state.pendingDrops > 0,
    isDropDisabled: !state.fairness.currentCommit,
    playHistory: [...state.playHistory],
    clientSeed: state.fairness.clientSeed,
    serverHash: state.fairness.currentCommit?.serverSeedHash ?? "Preparing...",
    fairNonce: state.fairness.currentCommit
      ? `Nonce ${state.fairness.currentCommit.nonce}`
      : "Nonce -",
    revealedSeed: state.fairness.lastProof?.serverSeed ?? "Awaiting result",
    proofResult: state.fairness.lastProof
      ? `Nonce ${state.fairness.lastProof.nonce} / slot ${state.fairness.lastProof.slot} / ${state.fairness.lastProof.multiplier}x`
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
  const [view, setView] = useState(() => snapshot(gameRef.current));
  const beginPasskeyRegistration = useMutation(api.users.beginPasskeyRegistration);
  const verifyPasskeyRegistration = useMutation(api.users.verifyPasskeyRegistration);
  const beginPasskeyAuthentication = useMutation(api.users.beginPasskeyAuthentication);
  const verifyPasskeyAuthentication = useMutation(api.users.verifyPasskeyAuthentication);
  const signOutPasskey = useMutation(api.users.signOutPasskey);
  const ensureWallet = useMutation(api.wallets.ensureWallet);
  const profile = useQuery(api.users.getSessionUser, sessionToken ? { sessionToken } : "skip");
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
      const win = Math.floor(ball.bet * ball.multiplier);

      state.balance += win;
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
    if (bet > state.balance) {
      setBet(state.balance);
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
        id: state.nextBallId,
        bet,
        drop,
        commit,
        clientSeed,
        multiplier: multipliers[drop.slot],
        startedAt: performance.now(),
        duration: 580 + rows * 165,
        points: dropPathPoints(drop),
        progress: 0,
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
              <button
                className="panel-link"
                type="button"
                disabled={authBusy !== null}
                onClick={handlePasskeySignOut}
              >
                Sign out
              </button>
            </div>

            <div className="play-ledger" aria-label="Account summary">
              <div className="ledger-balance">
                <span>Balance</span>
                <strong id="balance">{formatNumber(view.balance, 0)}</strong>
                <small>Sats</small>
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

            <button className="cashier-strip" type="button" disabled>
              <span>Cashier</span>
              <strong>Locked</strong>
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
                    onChange={(event) => {
                      gameRef.current.betInput = event.target.value;
                      publish();
                    }}
                    onBlur={() => setBet(currentBet())}
                  />
                  <button
                    className="icon-button"
                    type="button"
                    id="doubleBet"
                    aria-label="Double bet"
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
                Drop
              </button>
            </div>

            <div className="history-panel" aria-label="Play history">
              <div className="label-row">
                <span className="control-label">Play history</span>
                <span id="historyCount">Last {PLAY_HISTORY_LIMIT}</span>
              </div>
              <ol id="playHistory" className="play-history" aria-live="polite">
                {view.playHistory.length === 0 ? (
                  <li className="history-empty">No payouts yet</li>
                ) : (
                  view.playHistory.map((entry) => {
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
            <span>{formatNumber(view.balance, 0)} sats</span>
            <span>{profileStatus}</span>
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
  );
}
