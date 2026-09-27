const socket = io();

let myId = null;
let myRole = "guesser";
let currentRoomCode = null;
let isHost = false;
let lastPlayers = [];
let hasGuessedCorrectly = false;
let votedFor = null;

function show(screenId) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
}

socket.on("connect", () => {
  myId = socket.id;
});

// ---------- HOME ----------
document.getElementById("btn-create").onclick = () => {
  const name = document.getElementById("name-input").value.trim() || "Player";
  socket.emit("create_room", { name, totalRounds: 6 }, (res) => {
    if (!res.success) return setErr("home-error", res.error);
    currentRoomCode = res.code;
    show("screen-lobby");
  });
};

document.getElementById("btn-join").onclick = () => {
  const name = document.getElementById("name-input").value.trim() || "Player";
  const code = document.getElementById("code-input").value.trim().toUpperCase();
  if (!code) return setErr("home-error", "Enter a room code.");
  socket.emit("join_room", { name, code }, (res) => {
    if (!res.success) return setErr("home-error", res.error);
    currentRoomCode = res.code;
    show("screen-lobby");
  });
};

function setErr(id, msg) {
  document.getElementById(id).textContent = msg || "";
}

// ---------- LOBBY ----------
document.getElementById("btn-start").onclick = () => {
  const rounds = document.getElementById("rounds-input").value;
  socket.emit("start_game", rounds, (res) => {
    if (!res.success) setErr("lobby-error", res.error);
  });
};

socket.on("lobby_update", (state) => {
  currentRoomCode = state.code;
  if (document.getElementById("screen-game").classList.contains("active")) return;
  show("screen-lobby");
  document.getElementById("lobby-code").textContent = state.code;
  isHost = state.hostId === myId;
  document.getElementById("host-settings").style.display = isHost ? "block" : "none";
  document.getElementById("btn-start").style.display = isHost ? "block" : "none";

  const list = document.getElementById("player-list");
  list.innerHTML = "";
  state.players.forEach((p) => {
    const div = document.createElement("div");
    div.className = "p";
    div.innerHTML = `<span>${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span>`;
    list.appendChild(div);
  });
  setErr("lobby-error", "");
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- GAME ----------
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
let drawing = false;
let lastX = 0, lastY = 0;
let canDraw = false;

function canvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function startDraw(e) {
  if (!canDraw) return;
  drawing = true;
  const pos = canvasPos(e);
  lastX = pos.x;
  lastY = pos.y;
}
function moveDraw(e) {
  if (!canDraw || !drawing) return;
  e.preventDefault();
  const pos = canvasPos(e);
  const color = document.getElementById("color-picker").value;
  const width = parseInt(document.getElementById("size-picker").value, 10);
  drawLine(lastX, lastY, pos.x, pos.y, color, width);
  socket.emit("draw_stroke", { x1: lastX, y1: lastY, x2: pos.x, y2: pos.y, color, width });
  lastX = pos.x;
  lastY = pos.y;
}
function endDraw() {
  drawing = false;
}

canvas.addEventListener("mousedown", startDraw);
canvas.addEventListener("mousemove", moveDraw);
window.addEventListener("mouseup", endDraw);
canvas.addEventListener("touchstart", startDraw);
canvas.addEventListener("touchmove", moveDraw, { passive: false });
canvas.addEventListener("touchend", endDraw);

function drawLine(x1, y1, x2, y2, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

document.getElementById("btn-clear").onclick = () => {
  if (!canDraw) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  socket.emit("clear_canvas");
};

socket.on("draw_stroke", (s) => drawLine(s.x1, s.y1, s.x2, s.y2, s.color, s.width));
socket.on("clear_canvas", () => ctx.clearRect(0, 0, canvas.width, canvas.height));

socket.on("role_info", ({ role, word }) => {
  myRole = role;
  show("screen-game");
  const banner = document.getElementById("role-banner");
  canDraw = role === "artist";
  document.getElementById("toolbar").style.display = canDraw ? "flex" : "none";
  canvas.style.cursor = canDraw ? "crosshair" : "default";

  if (role === "artist") {
    banner.textContent = `You're drawing: ${word}`;
    banner.className = "role-banner artist";
  } else if (role === "impostor") {
    banner.textContent = `You're the Impostor. The word is "${word}" — blend in, guess it late without being obvious.`;
    banner.className = "role-banner impostor";
  } else {
    banner.textContent = "Guess the drawing!";
    banner.className = "role-banner";
  }
  hasGuessedCorrectly = false;
  votedFor = null;
  document.getElementById("guess-panel").style.display = role === "artist" ? "none" : "flex";
  document.getElementById("vote-panel").style.display = "none";
});

document.getElementById("btn-guess").onclick = sendGuess;
document.getElementById("guess-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendGuess();
});
function sendGuess() {
  const input = document.getElementById("guess-input");
  const text = input.value.trim();
  if (!text || hasGuessedCorrectly) return;
  socket.emit("submit_guess", text);
  input.value = "";
}
socket.on("your_guess_result", ({ correct }) => {
  if (correct) {
    hasGuessedCorrectly = true;
    document.getElementById("guess-input").placeholder = "Correct! Waiting for round to end...";
    document.getElementById("guess-input").disabled = true;
  }
}
);

socket.on("round_update", (state) => {
  renderRoundBanner(state);
  renderScoreboard(state.scores);
  renderLog(state.log);
  startCountdown(state.endsAt);
  lastPlayers = state.scores;

  if (state.phase === "voting") {
    renderVotePanel(state);
  } else if (state.phase !== "voting") {
    if (state.phase !== "vote_result") document.getElementById("vote-panel").style.display = "none";
  }

  if (state.phase === "reveal" || state.phase === "vote_result") {
    document.getElementById("guess-input").disabled = true;
  } else if (state.phase === "round") {
    document.getElementById("guess-input").disabled = hasGuessedCorrectly;
    document.getElementById("guess-input").placeholder = hasGuessedCorrectly
      ? "Correct! Waiting for round to end..."
      : "Type your guess...";
  }

  if (state.phase === "vote_result" && state.votes) {
    renderVoteResult(state);
  }

  if (state.phase === "gameover") {
    renderGameOver(state.scores);
  }
});

function renderRoundBanner(state) {
  const banner = document.getElementById("round-banner");
  const phaseLabel = {
    round: "Drawing & guessing",
    reveal: "Reveal",
    voting: "Vote: who's the Impostor?",
    vote_result: "Vote result",
    gameover: "Game over",
  }[state.phase] || state.phase;
  banner.textContent = `Round ${state.round}/${state.totalRounds} — ${phaseLabel}`;
}

function renderScoreboard(scores) {
  const el = document.getElementById("scoreboard");
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  el.innerHTML = sorted
    .map((p) => `<div class="row"><span>${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span><span>${p.score}</span></div>`)
    .join("");
}

function renderLog(log) {
  const el = document.getElementById("log");
  el.innerHTML = log.map((l) => `<div class="${l.kind}">${escapeHtml(l.text)}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}

function renderVotePanel(state) {
  const panel = document.getElementById("vote-panel");
  panel.style.display = "block";
  panel.innerHTML = `<h3>Who was faking it? Vote the Impostor.</h3><div class="vote-options" id="vote-options"></div>`;
  const optionsEl = document.getElementById("vote-options");
  lastPlayers
    .filter((p) => p.id !== myId)
    .forEach((p) => {
      const btn = document.createElement("button");
      btn.textContent = p.name;
      if (votedFor === p.id) btn.classList.add("selected");
      btn.onclick = () => {
        votedFor = p.id;
        socket.emit("submit_vote", p.id);
        renderVotePanel(state);
      };
      optionsEl.appendChild(btn);
    });
}

function renderVoteResult(state) {
  const panel = document.getElementById("vote-panel");
  panel.style.display = "block";
  const impostor = lastPlayers.find((p) => p.id === state.votes.impostorId);
  const name = impostor ? impostor.name : "Unknown";
  panel.innerHTML = `<h3>${escapeHtml(name)} was the Impostor — ${state.votes.caught ? "caught! 🎯" : "got away with it! 😈"}</h3>`;
}

function renderGameOver(scores) {
  show("screen-gameover");
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  document.getElementById("final-scores").innerHTML = sorted
    .map(
      (p, i) =>
        `<div class="row"><span>${i + 1}. ${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span><span>${p.score}</span></div>`
    )
    .join("");
}

let timerInterval = null;
function startCountdown(endsAt) {
  stopCountdown();
  if (!endsAt) {
    document.getElementById("timer-display").textContent = "";
    return;
  }
  const el = document.getElementById("timer-display");
  const tick = () => {
    const secsLeft = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    el.textContent = `⏱ ${secsLeft}s`;
    if (secsLeft <= 0) stopCountdown();
  };
  tick();
  timerInterval = setInterval(tick, 500);
}
function stopCountdown() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

// ---------- GAME OVER ----------
document.getElementById("btn-again").onclick = () => {
  socket.emit("leave_room");
  location.reload();
};
