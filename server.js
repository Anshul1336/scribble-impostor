const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const WORDS = require("./words");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};

const ROUND_SECONDS = 80;
const VOTE_SECONDS = 20;
const REVEAL_SECONDS = 6;

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function publicPlayers(room) {
  return Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    connected: p.connected,
  }));
}

function lobbyState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room),
    phase: room.phase,
    totalRounds: room.totalRounds,
  };
}

function clearTimer(room) {
  if (room.timerHandle) {
    clearTimeout(room.timerHandle);
    room.timerHandle = null;
  }
}

function publicRoundState(room) {
  return {
    phase: room.phase,
    round: room.roundNumber,
    totalRounds: room.totalRounds,
    artistId: room.currentArtistId,
    wordLength: room.currentWord ? room.currentWord.length : 0,
    endsAt: room.phaseEndsAt || null,
    scores: publicPlayers(room),
    log: room.log.slice(-40),
    revealedWord: room.phase === "reveal" || room.phase === "voting" || room.phase === "vote_result" ? room.currentWord : null,
    votes: room.phase === "vote_result" ? room.votesSummary : null,
  };
}

function addLog(room, text, kind) {
  room.log.push({ text, kind: kind || "info", ts: Date.now() });
}

function broadcastState(room) {
  io.to(room.code).emit("round_update", publicRoundState(room));
}

function sendRoleInfo(room) {
  Object.values(room.players).forEach((p) => {
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) return;
    let role = "guesser";
    if (p.id === room.currentArtistId) role = "artist";
    else if (p.id === room.currentImpostorId) role = "impostor";
    sock.emit("role_info", {
      role,
      word: role === "artist" || role === "impostor" ? room.currentWord : null,
    });
  });
}

function eligibleArtistOrder(room) {
  return Object.keys(room.players);
}

function startRound(room) {
  clearTimer(room);
  room.roundNumber++;
  if (room.roundNumber > room.totalRounds) {
    endGame(room);
    return;
  }

  const order = eligibleArtistOrder(room);
  room.currentArtistId = order[(room.roundNumber - 1) % order.length];

  const others = Object.keys(room.players).filter((id) => id !== room.currentArtistId);
  room.currentImpostorId = others.length >= 2 ? others[Math.floor(Math.random() * others.length)] : null;

  const unused = room.wordPool.filter((w) => !room.usedWords.includes(w));
  const pool = unused.length > 0 ? unused : WORDS;
  room.currentWord = pool[Math.floor(Math.random() * pool.length)];
  room.usedWords.push(room.currentWord);

  room.correctGuessers = [];
  room.impostorGuessedCorrectly = false;
  room.roundScores = {};
  Object.keys(room.players).forEach((id) => (room.roundScores[id] = 0));
  room.strokes = [];
  room.votes = {};

  room.phase = "round";
  room.phaseEndsAt = Date.now() + ROUND_SECONDS * 1000;

  addLog(room, `Round ${room.roundNumber}: ${room.players[room.currentArtistId].name} is drawing.`, "system");
  sendRoleInfo(room);
  io.to(room.code).emit("clear_canvas");
  broadcastState(room);

  room.timerHandle = setTimeout(() => endDrawingPhase(room), ROUND_SECONDS * 1000);
}

function endDrawingPhase(room) {
  if (room.phase !== "round") return;
  clearTimer(room);
  room.phase = "reveal";
  room.phaseEndsAt = Date.now() + REVEAL_SECONDS * 1000;
  addLog(room, `Time's up! The word was "${room.currentWord}".`, "system");
  broadcastState(room);
  room.timerHandle = setTimeout(() => {
    if (room.currentImpostorId) startVoting(room);
    else finishRoundScoring(room);
  }, REVEAL_SECONDS * 1000);
}

function startVoting(room) {
  clearTimer(room);
  room.phase = "voting";
  room.phaseEndsAt = Date.now() + VOTE_SECONDS * 1000;
  room.votes = {};
  addLog(room, "Vote: who do you think was the Impostor?", "system");
  broadcastState(room);
  room.timerHandle = setTimeout(() => resolveVotes(room), VOTE_SECONDS * 1000);
}

function resolveVotes(room) {
  clearTimer(room);
  const tally = {};
  Object.values(room.votes).forEach((suspectId) => {
    tally[suspectId] = (tally[suspectId] || 0) + 1;
  });
  let topSuspect = null;
  let topCount = 0;
  Object.entries(tally).forEach(([id, count]) => {
    if (count > topCount) {
      topCount = count;
      topSuspect = id;
    }
  });

  const voterCount = Object.keys(room.votes).length;
  const caught = room.currentImpostorId && topSuspect === room.currentImpostorId && topCount > voterCount / 2;

  room.votesSummary = {
    tally,
    impostorId: room.currentImpostorId,
    caught,
  };

  if (caught && room.impostorGuessedCorrectly) {
    room.roundScores[room.currentImpostorId] = 0;
    addLog(room, `${room.players[room.currentImpostorId].name} was the Impostor and got caught! Round points forfeited.`, "system");
  } else if (room.currentImpostorId) {
    if (room.impostorGuessedCorrectly) {
      addLog(room, `${room.players[room.currentImpostorId].name} was the Impostor and blended in! Points kept.`, "system");
    } else {
      addLog(room, `${room.players[room.currentImpostorId].name} was the Impostor.`, "system");
    }
  }

  room.phase = "vote_result";
  room.phaseEndsAt = Date.now() + REVEAL_SECONDS * 1000;
  broadcastState(room);
  room.timerHandle = setTimeout(() => finishRoundScoring(room), REVEAL_SECONDS * 1000);
}

function finishRoundScoring(room) {
  Object.entries(room.roundScores).forEach(([id, pts]) => {
    if (room.players[id]) room.players[id].score += pts;
  });
  startRound(room);
}

function endGame(room) {
  clearTimer(room);
  room.phase = "gameover";
  room.phaseEndsAt = null;
  addLog(room, "Game over! Final scores are in.", "system");
  broadcastState(room);
}

io.on("connection", (socket) => {
  socket.on("create_room", ({ name, totalRounds }, ack) => {
    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      players: {},
      phase: "lobby",
      totalRounds: Math.max(3, Math.min(20, parseInt(totalRounds, 10) || 6)),
      roundNumber: 0,
      wordPool: shuffle(WORDS),
      usedWords: [],
      log: [],
      strokes: [],
    };
    room.players[socket.id] = {
      id: socket.id,
      socketId: socket.id,
      name: (name || "Player").slice(0, 20),
      score: 0,
      connected: true,
    };
    rooms[code] = room;
    socket.join(code);
    socket.data.roomCode = code;
    ack && ack({ success: true, code });
    io.to(code).emit("lobby_update", lobbyState(room));
  });

  socket.on("join_room", ({ name, code }, ack) => {
    const room = rooms[(code || "").toUpperCase()];
    if (!room) return ack && ack({ success: false, error: "Room not found." });
    if (room.phase !== "lobby") return ack && ack({ success: false, error: "Game already in progress." });
    if (Object.keys(room.players).length >= 8) return ack && ack({ success: false, error: "Room full (max 8)." });

    room.players[socket.id] = {
      id: socket.id,
      socketId: socket.id,
      name: (name || "Player").slice(0, 20),
      score: 0,
      connected: true,
    };
    socket.join(room.code);
    socket.data.roomCode = room.code;
    ack && ack({ success: true, code: room.code });
    io.to(room.code).emit("lobby_update", lobbyState(room));
  });

  socket.on("start_game", (ack) => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.hostId) return ack && ack({ success: false, error: "Only host can start." });
    if (Object.keys(room.players).length < 3) {
      return ack && ack({ success: false, error: "Need at least 3 players." });
    }
    ack && ack({ success: true });
    startRound(room);
  });

  socket.on("draw_stroke", (stroke) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "round") return;
    if (socket.id !== room.currentArtistId) return;
    socket.to(room.code).emit("draw_stroke", stroke);
  });

  socket.on("clear_canvas", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "round") return;
    if (socket.id !== room.currentArtistId) return;
    socket.to(room.code).emit("clear_canvas");
  });

  socket.on("submit_guess", (text) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "round") return;
    const p = room.players[socket.id];
    if (!p) return;
    if (socket.id === room.currentArtistId) return;
    if (room.correctGuessers.includes(socket.id)) return;

    const clean = (text || "").trim();
    if (!clean) return;
    const isCorrect = clean.toLowerCase() === room.currentWord.toLowerCase();

    if (isCorrect) {
      room.correctGuessers.push(socket.id);
      const place = room.correctGuessers.length;
      const pts = Math.max(20, 100 - (place - 1) * 20);
      room.roundScores[socket.id] += pts;
      room.roundScores[room.currentArtistId] += 15;

      if (socket.id === room.currentImpostorId) {
        room.impostorGuessedCorrectly = true;
        addLog(room, `${p.name} guessed the word!`, "guess-correct");
      } else {
        addLog(room, `${p.name} guessed the word!`, "guess-correct");
      }

      const sock = io.sockets.sockets.get(socket.id);
      if (sock) sock.emit("your_guess_result", { correct: true });

      const realGuessers = Object.keys(room.players).filter(
        (id) => id !== room.currentArtistId && id !== room.currentImpostorId
      );
      const allRealGuessed = realGuessers.every((id) => room.correctGuessers.includes(id));
      if (allRealGuessed && realGuessers.length > 0) {
        endDrawingPhase(room);
        return;
      }
      broadcastState(room);
    } else {
      addLog(room, `${p.name}: ${clean}`, "guess-wrong");
      const sock = io.sockets.sockets.get(socket.id);
      if (sock) sock.emit("your_guess_result", { correct: false });
      broadcastState(room);
    }
  });

  socket.on("submit_vote", (suspectId) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "voting") return;
    if (!room.players[suspectId]) return;
    room.votes[socket.id] = suspectId;
  });

  socket.on("leave_room", () => cleanupPlayer(socket));
  socket.on("disconnect", () => cleanupPlayer(socket));

  function cleanupPlayer(socket) {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    delete room.players[socket.id];
    if (Object.keys(room.players).length === 0) {
      clearTimer(room);
      delete rooms[code];
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = Object.keys(room.players)[0];
    }
    if (room.phase === "lobby") {
      io.to(code).emit("lobby_update", lobbyState(room));
    } else {
      broadcastState(room);
    }
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Scribble: Impostor listening on port ${PORT}`));
