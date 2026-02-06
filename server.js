import express from "express";
import http from "http";
import { Server } from "socket.io";

// ✅ FIX: pokersolver là CommonJS, project dùng ESM
import pkg from "pokersolver";
const { Hand } = pkg;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// ====== CONFIG ======
const START_TOKENS = 2000;
const MIN_UNIT = 5;      // cược phải là bội số của 5
const SB = 10;           // small blind
const BB = 20;           // big blind
const MAX_PLAYERS = 9;   // hard cap

// ====== STATE ======
const rooms = new Map();

/**
Room state:
{
  id,
  hostId: socketId | null,
  maxPlayers: 2..9,
  players: [{ id, name, tokens, seat, folded, allIn, betThisRound, cards: [] }],
  started: false,
  deck: [],
  dealerSeat: 0,
  pot: 0,
  community: [],
  stage: "lobby" | "preflop" | "flop" | "turn" | "river" | "showdown",
  currentSeat: 0,
  highestBet: 0,
  lastAggressorSeat: null,
  handId: 0
}
*/

function clampToUnit(x) {
  x = Math.floor(Number(x) || 0);
  return Math.floor(x / MIN_UNIT) * MIN_UNIT;
}

function makeDeck() {
  const suits = ["s", "h", "d", "c"]; // spades/hearts/diamonds/clubs
  const ranks = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"];
  const deck = [];
  for (const r of ranks) for (const s of suits) deck.push(r + s);

  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      hostId: null,
      maxPlayers: 9,
      players: [],
      started: false,
      deck: [],
      dealerSeat: 0,
      pot: 0,
      community: [],
      stage: "lobby",
      currentSeat: 0,
      highestBet: 0,
      lastAggressorSeat: null,
      handId: 0
    });
  }
  return rooms.get(roomId);
}

function publicState(room, viewerId = null) {
  // Ẩn bài của người khác; chỉ viewer thấy bài của mình
  const players = room.players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      tokens: p.tokens,
      folded: p.folded,
      allIn: p.allIn,
      betThisRound: p.betThisRound,
      cards: viewerId && p.id === viewerId
        ? p.cards
        : (p.cards.length ? ["??", "??"] : [])
    }));

  return {
    id: room.id,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    started: room.started,
    stage: room.stage,
    pot: room.pot,
    community: room.community,
    dealerSeat: room.dealerSeat,
    currentSeat: room.currentSeat,
    highestBet: room.highestBet,
    players
  };
}

function broadcastRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit("state", publicState(room, p.id));
  }
}

function nextSeat(room, fromSeat) {
  const seats = room.players.map((p) => p.seat).sort((a, b) => a - b);
  if (seats.length === 0) return 0;

  let idx = seats.indexOf(fromSeat);
  if (idx === -1) idx = 0;

  for (let k = 0; k < seats.length; k++) {
    idx = (idx + 1) % seats.length;
    const seat = seats[idx];
    const pl = room.players.find((p) => p.seat === seat);
    if (!pl) continue;
    if (pl.folded) continue;
    if (pl.allIn) continue;
    if (pl.cards.length === 0) continue;
    return seat;
  }
  return fromSeat;
}

function activePlayers(room) {
  return room.players.filter((p) => p.cards.length && !p.folded);
}

function allBetsSettled(room) {
  const act = activePlayers(room).filter((p) => !p.allIn);
  if (act.length === 0) return true;
  return act.every((p) => p.betThisRound === room.highestBet);
}

function takeFromPlayer(room, player, amount) {
  amount = clampToUnit(amount);
  if (amount <= 0) return 0;

  const canPay = Math.min(player.tokens, amount);
  player.tokens -= canPay;
  player.betThisRound += canPay;
  room.pot += canPay;

  if (player.tokens === 0) player.allIn = true;

  if (player.betThisRound > room.highestBet) {
    room.highestBet = player.betThisRound;
    room.lastAggressorSeat = player.seat;
  }
  return canPay;
}

function startHand(room) {
  if (room.players.length < 2) return;

  room.handId += 1;
  room.started = true;
  room.stage = "preflop";
  room.pot = 0;
  room.community = [];
  room.deck = makeDeck();

  // reset player statuses
  for (const p of room.players) {
    p.folded = false;
    p.allIn = false;
    p.betThisRound = 0;
    p.cards = [];
  }

  // move dealer button
  const seats = room.players.map((p) => p.seat).sort((a, b) => a - b);
  if (room.handId === 1) {
    room.dealerSeat = seats[0];
  } else {
    const idx = seats.indexOf(room.dealerSeat);
    room.dealerSeat = seats[(idx + 1) % seats.length];
  }

  const dealerIdx = seats.indexOf(room.dealerSeat);
  const sbSeat = seats[(dealerIdx + 1) % seats.length];
  const bbSeat = seats[(dealerIdx + 2) % seats.length];

  // deal 2 cards each
  for (let r = 0; r < 2; r++) {
    for (const seat of seats) {
      const p = room.players.find((x) => x.seat === seat);
      if (!p) continue;
      p.cards.push(room.deck.pop());
    }
  }

  // blinds
  const sbP = room.players.find((p) => p.seat === sbSeat);
  const bbP = room.players.find((p) => p.seat === bbSeat);

  takeFromPlayer(room, sbP, SB);
  takeFromPlayer(room, bbP, BB);

  // first action: seat after BB (UTG)
  room.currentSeat = seats[(dealerIdx + 3) % seats.length];

  broadcastRoom(room);
}

function advanceStage(room) {
  // If only one player remains (not folded) => wins immediately
  const act = activePlayers(room);
  if (act.length === 1) {
    act[0].tokens += room.pot;
    room.pot = 0;
    room.stage = "showdown";
    broadcastRoom(room);
    return;
  }

  if (room.stage === "preflop") {
    room.stage = "flop";
    room.deck.pop(); // burn
    room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    for (const p of room.players) p.betThisRound = 0;
    room.highestBet = 0;
    room.lastAggressorSeat = null;
  } else if (room.stage === "flop") {
    room.stage = "turn";
    room.deck.pop();
    room.community.push(room.deck.pop());
    for (const p of room.players) p.betThisRound = 0;
    room.highestBet = 0;
    room.lastAggressorSeat = null;
  } else if (room.stage === "turn") {
    room.stage = "river";
    room.deck.pop();
    room.community.push(room.deck.pop());
    for (const p of room.players) p.betThisRound = 0;
    room.highestBet = 0;
    room.lastAggressorSeat = null;
  } else if (room.stage === "river") {
    room.stage = "showdown";
    resolveShowdown(room);
    return;
  }

  // postflop: first to act is seat after dealer
  const seats = room.players.map((p) => p.seat).sort((a, b) => a - b);
  const dealerIdx = seats.indexOf(room.dealerSeat);
  let first = seats[(dealerIdx + 1) % seats.length];

  // skip folded/all-in/no cards
  room.currentSeat = nextSeat(room, first === seats[0] ? seats[seats.length - 1] : first - 1);

  broadcastRoom(room);
}

function resolveShowdown(room) {
  const contenders = activePlayers(room);

  const solved = contenders.map((p) => {
    const cards = [...p.cards, ...room.community]; // 7 cards
    const h = Hand.solve(cards);
    return { p, hand: h };
  });

  const winnersHands = Hand.winners(solved.map((x) => x.hand));
  const winners = solved
    .filter((x) => winnersHands.includes(x.hand))
    .map((x) => x.p);

  const share = Math.floor(room.pot / winners.length);
  let remainder = room.pot - share * winners.length;

  for (const w of winners) {
    w.tokens += share;
    // chia lẻ theo unit 5 nếu còn
    if (remainder >= MIN_UNIT) {
      w.tokens += MIN_UNIT;
      remainder -= MIN_UNIT;
    }
  }

  room.pot = 0;

  broadcastRoom(room);

  // auto new hand after 3 seconds if enough eligible players
  setTimeout(() => {
    const eligible = room.players.filter((p) => p.tokens > 0).length;
    if (eligible >= 2) startHand(room);
    else {
      room.started = false;
      room.stage = "lobby";
      for (const p of room.players) p.cards = [];
      broadcastRoom(room);
    }
  }, 3000);
}

function doAction(room, player, action, amount = 0) {
  if (!room.started) return;
  if (room.stage === "showdown") return;
  if (player.seat !== room.currentSeat) return;
  if (player.folded || player.allIn) return;

  amount = clampToUnit(amount);

  const toCall = Math.max(0, room.highestBet - player.betThisRound);

  if (action === "fold") {
    player.folded = true;
  } else if (action === "check") {
    if (toCall !== 0) return;
  } else if (action === "call") {
    takeFromPlayer(room, player, toCall);
  } else if (action === "bet") {
    if (room.highestBet !== 0) return;
    if (amount < MIN_UNIT) return;
    takeFromPlayer(room, player, amount);
  } else if (action === "raise") {
    if (room.highestBet === 0) return;
    if (amount < MIN_UNIT) return;
    takeFromPlayer(room, player, toCall + amount);
  } else if (action === "allin") {
    takeFromPlayer(room, player, player.tokens);
  }

  // If only one player remains => end now
  const act = activePlayers(room);
  if (act.length === 1) {
    act[0].tokens += room.pot;
    room.pot = 0;
    room.stage = "showdown";
    broadcastRoom(room);
    setTimeout(() => startHand(room), 2000);
    return;
  }

  // Round finished => advance stage
  if (allBetsSettled(room)) {
    advanceStage(room);
    return;
  }

  // next player
  room.currentSeat = nextSeat(room, room.currentSeat);
  broadcastRoom(room);
}

function safeRoomId(roomId) {
  return String(roomId || "").trim().slice(0, 24);
}
function safeName(name) {
  return String(name || "").trim().slice(0, 18);
}

io.on("connection", (socket) => {
  // ===== Create Room (for UI flow) =====
  socket.on("createRoom", ({ roomId, name, maxPlayers }) => {
    roomId = safeRoomId(roomId);
    name = safeName(name);
    maxPlayers = Math.max(2, Math.min(MAX_PLAYERS, parseInt(maxPlayers || "9", 10)));

    if (!roomId || !name) {
      socket.emit("errorMsg", "Bạn cần nhập Tên người chơi và Tên phòng.");
      return;
    }

    const room = getRoom(roomId);

    // set host only once (first creator)
    if (!room.hostId) room.hostId = socket.id;

    // allow host to set maxPlayers (only if not started)
    if (!room.started) room.maxPlayers = maxPlayers;

    // NOTE: join is handled by join event from client
  });

  // ===== List Rooms (for Find page) =====
  socket.on("listRooms", () => {
    const list = [];
    for (const r of rooms.values()) {
      const maxPlayers = r.maxPlayers || MAX_PLAYERS;
      list.push({
        id: r.id,
        players: r.players.length,
        maxPlayers,
        started: !!r.started && r.stage !== "lobby",
      });
    }
    // show rooms that are created (hostId) or have players
    const filtered = list.filter((x) => {
      const rr = rooms.get(x.id);
      return x.players > 0 || (rr && rr.hostId);
    });

    // sort: waiting first, then by players desc
    filtered.sort((a, b) => {
      if (a.started !== b.started) return a.started ? 1 : -1;
      return b.players - a.players;
    });

    socket.emit("roomsList", filtered);
  });

  // ===== Join Room =====
  socket.on("join", ({ roomId, name }) => {
    roomId = safeRoomId(roomId);
    name = safeName(name);

    if (!roomId || !name) {
      socket.emit("errorMsg", "Bạn cần nhập Tên và Mã phòng.");
      return;
    }

    const room = getRoom(roomId);

    // If no host set yet, first joiner becomes host
    if (!room.hostId) room.hostId = socket.id;

    // limit by room.maxPlayers (fallback MAX_PLAYERS)
    const limit = Math.max(2, Math.min(MAX_PLAYERS, room.maxPlayers || MAX_PLAYERS));
    if (room.players.length >= limit) {
      socket.emit("errorMsg", `Phòng đã đủ ${limit} người. Hãy tạo phòng mới hoặc dùng mã phòng khác.`);
      return;
    }

    // prevent duplicate name in room
    const existingName = room.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existingName) {
      socket.emit("errorMsg", "Tên này đã có trong phòng. Hãy chọn tên khác.");
      return;
    }

    // assign smallest available seat
    const usedSeats = new Set(room.players.map((p) => p.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat++;

    const player = {
      id: socket.id,
      name,
      tokens: START_TOKENS,
      seat,
      folded: false,
      allIn: false,
      betThisRound: 0,
      cards: []
    };

    room.players.push(player);
    socket.join(roomId);

    // if joining mid-game => spectator until next hand
    if (room.started && room.stage !== "lobby") {
      player.cards = [];
      player.folded = true;
      player.allIn = false;
      player.betThisRound = 0;
    }

    broadcastRoom(room);
  });

  // ===== Start (Host only) =====
  socket.on("start", ({ roomId }) => {
    const room = getRoom(safeRoomId(roomId));
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    if (room.hostId && room.hostId !== socket.id) {
      socket.emit("errorMsg", "Chỉ host mới có quyền bắt đầu.");
      return;
    }

    if (room.players.filter((p) => p.tokens > 0).length < 2) {
      socket.emit("errorMsg", "Cần ít nhất 2 người còn token để bắt đầu.");
      return;
    }

    startHand(room);
  });

  // ===== Action =====
  socket.on("action", ({ roomId, action, amount }) => {
    const room = getRoom(safeRoomId(roomId));
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    doAction(room, player, action, amount);
  });

  // ===== Disconnect =====
  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const wasHost = room.hostId === socket.id;
        room.players.splice(idx, 1);

        // if host left => assign new host to first player (if any)
        if (wasHost) {
          room.hostId = room.players.length ? room.players[0].id : null;
        }

        // if too few players => reset to lobby
        if (room.players.length < 2) {
          room.started = false;
          room.stage = "lobby";
          room.pot = 0;
          room.community = [];
          for (const p of room.players) {
            p.cards = [];
            p.folded = false;
            p.allIn = false;
            p.betThisRound = 0;
          }
        }

        broadcastRoom(room);

        // optional cleanup: remove empty rooms
        if (room.players.length === 0 && !room.hostId) {
          rooms.delete(room.id);
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Poker server running: http://localhost:${PORT}`);
});
