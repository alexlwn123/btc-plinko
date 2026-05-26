import {
  buildDrop,
  buildMultipliers,
  buildProvablyFairDrop,
  commitServerSeed,
  formatNumber,
  randomServerSeed,
  RISKS,
  verifyProvablyFairDrop
} from "./core.mjs";

const canvas = document.querySelector("#board");
const ctx = canvas.getContext("2d");
const balanceEl = document.querySelector("#balance");
const betInput = document.querySelector("#bet");
const rowsInput = document.querySelector("#rows");
const rowValue = document.querySelector("#rowValue");
const dropButton = document.querySelector("#dropButton");
const halfBet = document.querySelector("#halfBet");
const doubleBet = document.querySelector("#doubleBet");
const riskButtons = [...document.querySelectorAll("[data-risk]")];
const historyCountEl = document.querySelector("#historyCount");
const playHistoryEl = document.querySelector("#playHistory");
const clientSeedInput = document.querySelector("#clientSeed");
const serverHashEl = document.querySelector("#serverHash");
const revealedSeedEl = document.querySelector("#revealedSeed");
const proofResultEl = document.querySelector("#proofResult");
const fairNonceEl = document.querySelector("#fairNonce");

const COMMIT_QUEUE_TARGET = 64;
const COMMIT_BATCH_SIZE = 16;
const MIN_DROP_ACTIVATION_MS = 50;
const SETTINGS_STORAGE_KEY = "btc-plinko:settings";
const DEFAULT_RISK = "medium";
const PLAY_HISTORY_LIMIT = 12;

let pointerDropActive = false;
let keyDropActive = false;
let lastDropActivationAt = 0;

function parseRowsSetting(value) {
  const rows = Number(value);
  const min = Number(rowsInput.min);
  const max = Number(rowsInput.max);
  const step = rowsInput.step === "any" ? 1 : Number(rowsInput.step || 1);

  if (
    !Number.isInteger(rows)
    || rows < min
    || rows > max
    || (step > 0 && (rows - min) % step !== 0)
  ) {
    return null;
  }

  return rows;
}

function parseRiskSetting(value) {
  return RISKS[value] ? value : null;
}

function readSavedSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    return {
      rows: parseRowsSetting(parsed?.rows),
      risk: parseRiskSetting(parsed?.risk)
    };
  } catch {
    return {};
  }
}

const savedSettings = readSavedSettings();

const state = {
  balance: 1000,
  rows: savedSettings.rows ?? Number(rowsInput.value),
  risk: savedSettings.risk ?? DEFAULT_RISK,
  multipliers: [],
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
    clientSeed: clientSeedInput.value,
    currentCommit: null,
    commitQueue: [],
    nextNonce: 0,
    refilling: false,
    lastProof: null
  },
  board: {
    width: 0,
    height: 0,
    topY: 0,
    rowGap: 0,
    slotGap: 0,
    centerX: 0,
    binTop: 0
  }
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function syncMultipliers() {
  state.multipliers = buildMultipliers(state.rows, state.risk);
}

function saveSettings() {
  try {
    globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      rows: state.rows,
      risk: state.risk
    }));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function payoutTone(entry) {
  if (entry.multiplier >= 10) return "hot";
  if (entry.payout < entry.bet) return "loss";
  if (entry.payout === entry.bet) return "push";
  return "win";
}

function renderPlayHistory() {
  historyCountEl.textContent = `Last ${PLAY_HISTORY_LIMIT}`;
  playHistoryEl.replaceChildren();

  if (state.playHistory.length === 0) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "No payouts yet";
    playHistoryEl.append(empty);
    return;
  }

  for (const entry of state.playHistory) {
    const item = document.createElement("li");
    const multiplier = `${entry.multiplier.toFixed(2)}x`;
    item.className = `history-item ${payoutTone(entry)}`;
    item.setAttribute("aria-label", `Payout ${formatNumber(entry.payout)} credits at ${multiplier}`);

    const payout = document.createElement("strong");
    payout.textContent = formatNumber(entry.payout);

    const detail = document.createElement("span");
    detail.textContent = multiplier;

    item.append(payout, detail);
    playHistoryEl.append(item);
  }
}

function recordPayout(ball, payout) {
  state.playHistory.unshift({
    id: ball.id,
    bet: ball.bet,
    payout,
    multiplier: ball.multiplier,
    slot: ball.drop.slot
  });
  state.playHistory = state.playHistory.slice(0, PLAY_HISTORY_LIMIT);
}

function currentBet() {
  const value = Number(betInput.value);
  return Number.isFinite(value) ? clamp(Math.round(value * 100) / 100, 1, 999999) : 1;
}

function setBet(value) {
  betInput.value = String(clamp(Math.round(value * 100) / 100, 1, 999999));
}

function updateHud() {
  balanceEl.textContent = formatNumber(state.balance);
  rowValue.value = state.rows;
  rowValue.textContent = String(state.rows);
  renderPlayHistory();
  serverHashEl.textContent = state.fairness.currentCommit?.serverSeedHash ?? "Preparing...";
  fairNonceEl.textContent = state.fairness.currentCommit ? `Nonce ${state.fairness.currentCommit.nonce}` : "Nonce -";
  revealedSeedEl.textContent = state.fairness.lastProof?.serverSeed ?? "Awaiting result";
  proofResultEl.textContent = state.fairness.lastProof
    ? `Nonce ${state.fairness.lastProof.nonce} / slot ${state.fairness.lastProof.slot} / ${state.fairness.lastProof.multiplier}x`
    : "-";
}

function setSettingsLocked(isLocked) {
  rowsInput.disabled = isLocked;
  for (const button of riskButtons) {
    button.disabled = isLocked;
  }
}

function syncSettingsLock() {
  setSettingsLocked(state.activeBalls.length + state.pendingDrops > 0);
}

function syncDropAvailability() {
  dropButton.disabled = !state.fairness.currentCommit;
}

function totalAvailableCommits() {
  return state.fairness.commitQueue.length + (state.fairness.currentCommit ? 1 : 0);
}

async function createCommit(nonce) {
  const serverSeed = randomServerSeed();
  const serverSeedHash = await commitServerSeed(serverSeed);
  return { serverSeed, serverSeedHash, nonce };
}

async function refillCommitQueue() {
  if (state.fairness.refilling) return;

  state.fairness.refilling = true;
  syncDropAvailability();

  try {
    while (totalAvailableCommits() < COMMIT_QUEUE_TARGET) {
      const count = Math.min(COMMIT_BATCH_SIZE, COMMIT_QUEUE_TARGET - totalAvailableCommits());
      const commits = await Promise.all(
        Array.from({ length: count }, () => createCommit(state.fairness.nextNonce++))
      );

      for (const commit of commits) {
        if (!state.fairness.currentCommit) {
          state.fairness.currentCommit = commit;
        } else {
          state.fairness.commitQueue.push(commit);
        }
      }

      syncDropAvailability();
      updateHud();
    }
  } finally {
    state.fairness.refilling = false;
    syncDropAvailability();
    updateHud();
  }
}

function consumeCommit() {
  const commit = state.fairness.currentCommit;
  if (!commit) return null;

  state.fairness.currentCommit = state.fairness.commitQueue.shift() ?? null;
  syncDropAvailability();
  updateHud();
  void refillCommitQueue();
  return commit;
}

function currentClientSeed() {
  const value = clientSeedInput.value.trim() || "browser-client";
  clientSeedInput.value = value;
  state.fairness.clientSeed = value;
  return value;
}

function requestDropActivation() {
  const now = performance.now();
  if (now - lastDropActivationAt < MIN_DROP_ACTIVATION_MS) return;

  lastDropActivationAt = now;
  startDrop();
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.board.width = rect.width;
  state.board.height = rect.height;
  computeBoard();
  draw(performance.now());
}

function computeBoard() {
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

function boardPoint(layer, rights) {
  const { centerX, topY, rowGap, slotGap } = state.board;
  return {
    x: centerX + (rights - layer / 2) * slotGap,
    y: topY - rowGap * 0.62 + layer * rowGap
  };
}

function dropPathPoints(drop) {
  const points = drop.points.map((point) => boardPoint(point.layer, point.rights));
  const end = boardPoint(drop.rows, drop.slot);
  end.y = state.board.binTop - 18;
  points.push(end);
  return points;
}

function drawBackground() {
  const { width, height } = state.board;
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

function drawPegs(now) {
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

function multiplierColor(value, index) {
  const edgeDistance = Math.abs(index - state.rows / 2) / (state.rows / 2);
  if (edgeDistance > 0.82) return "#f35b5b";
  if (edgeDistance > 0.58) return "#f5bc42";
  if (value >= 1) return "#00d084";
  return "#2bb7ff";
}

function drawBins() {
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
    const fill = multiplierColor(multiplier, slot);
    const active = state.lastSlot === slot;

    roundedRect(x - binWidth / 2, binTop, binWidth, binHeight, 7);
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

function roundedRect(x, y, width, height, radius) {
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

function drawRails() {
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

function currentBall(ball, now) {
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

function drawPathPreview() {
  ctx.strokeStyle = "rgba(0, 228, 141, 0.18)";
  ctx.lineWidth = 3;

  for (const ball of state.activeBalls.slice(-12)) {
    ctx.beginPath();
    ball.points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
  }
}

function drawBall(ball) {
  if (!ball) return;

  const radius = clamp(state.board.slotGap * 0.16, 9, 15);
  const glow = ctx.createRadialGradient(ball.x, ball.y, radius * 0.25, ball.x, ball.y, radius * 1.9);
  glow.addColorStop(0, "rgba(0, 228, 141, 0.58)");
  glow.addColorStop(1, "rgba(0, 228, 141, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, radius * 1.9, 0, Math.PI * 2);
  ctx.fill();

  const shell = ctx.createLinearGradient(ball.x - radius, ball.y - radius, ball.x + radius, ball.y + radius);
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
  drawBackground();
  drawRails();
  drawPegs(now);
  drawBins();
  drawPathPreview();

  const finished = [];
  for (const activeBall of state.activeBalls) {
    const ball = currentBall(activeBall, now);
    drawBall(ball);

    if (ball.done) {
      finished.push(activeBall);
    }
  }

  if (finished.length > 0) {
    finishDrops(finished);
  }
}

function scheduleAnimation() {
  if (state.animationFrame !== null) return;

  state.animationFrame = requestAnimationFrame((now) => {
    state.animationFrame = null;
    draw(now);
    if (state.activeBalls.length > 0) {
      scheduleAnimation();
    }
  });
}

function finishDrops(finishedBalls) {
  const finishedIds = new Set(finishedBalls.map((ball) => ball.id));
  state.activeBalls = state.activeBalls.filter((ball) => !finishedIds.has(ball.id));

  for (const ball of finishedBalls) {
    const win = ball.bet * ball.multiplier;

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
      multiplier: ball.multiplier
    };
  }

  syncSettingsLock();
  updateHud();
}

async function startDrop() {
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
  dropButton.blur();
  syncSettingsLock();
  updateHud();

  try {
    const drop = await buildProvablyFairDrop(rows, {
      serverSeed: commit.serverSeed,
      serverSeedHash: commit.serverSeedHash,
      clientSeed,
      nonce: commit.nonce
    });

    state.lastPath = [...drop.directions];
    state.activeBalls.push({
      id: state.nextBallId,
      bet,
      drop,
      commit,
      clientSeed,
      multiplier: multipliers[drop.slot],
      multipliers,
      startedAt: performance.now(),
      duration: 580 + rows * 165,
      points: dropPathPoints(drop),
      progress: 0
    });
    state.nextBallId += 1;
    scheduleAnimation();
  } catch (error) {
    state.balance += bet;
    console.error(error);
  } finally {
    state.pendingDrops -= 1;
    syncSettingsLock();
    updateHud();
  }
}

function syncRiskButtons() {
  for (const button of riskButtons) {
    button.classList.toggle("active", button.dataset.risk === state.risk);
  }
}

function setRisk(risk) {
  state.risk = parseRiskSetting(risk) ?? DEFAULT_RISK;
  syncRiskButtons();
  syncMultipliers();
  saveSettings();
  draw(performance.now());
}

rowsInput.addEventListener("input", () => {
  state.rows = parseRowsSetting(rowsInput.value) ?? state.rows;
  rowsInput.value = String(state.rows);
  syncMultipliers();
  computeBoard();
  updateHud();
  saveSettings();
  draw(performance.now());
});

betInput.addEventListener("change", () => setBet(currentBet()));
halfBet.addEventListener("click", () => {
  setBet(currentBet() / 2);
  halfBet.blur();
});
doubleBet.addEventListener("click", () => {
  setBet(currentBet() * 2);
  doubleBet.blur();
});
dropButton.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || dropButton.disabled || pointerDropActive) return;
  event.preventDefault();
  pointerDropActive = true;
  requestDropActivation();
});
window.addEventListener("pointerup", () => {
  pointerDropActive = false;
});
window.addEventListener("pointercancel", () => {
  pointerDropActive = false;
});
dropButton.addEventListener("keydown", (event) => {
  if (event.repeat || keyDropActive || !["Enter", " "].includes(event.key) || dropButton.disabled) return;
  event.preventDefault();
  keyDropActive = true;
  requestDropActivation();
});
dropButton.addEventListener("keyup", (event) => {
  if (["Enter", " "].includes(event.key)) {
    keyDropActive = false;
  }
});
clientSeedInput.addEventListener("input", () => {
  state.fairness.clientSeed = clientSeedInput.value;
});

for (const button of riskButtons) {
  button.addEventListener("click", () => setRisk(button.dataset.risk));
}

window.plinkoDebug = {
  buildDrop,
  buildMultipliers,
  buildProvablyFairDrop,
  verifyProvablyFairDrop,
  getState: () => ({
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
    playHistory: state.playHistory.map((entry) => ({ ...entry }))
  })
};

rowsInput.value = String(state.rows);
syncRiskButtons();
syncDropAvailability();
syncMultipliers();
updateHud();
void refillCommitQueue();
new ResizeObserver(resizeCanvas).observe(canvas);
