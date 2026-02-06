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
const MIN_UNIT = 5;   // 1 chip = 5 token, mọi cược phải là bội số của 5
const SB = 10;        // small blind (bội số của 5)
const BB = 20;        // big blind (bội số của 5)
const MAX_PLAYERS = 9; // ✅ tối đa 9 người / phòng

// ====== STATE ======
const rooms = new Map();

/**
Room state:
{
  id,
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

  // shuffle (Fisher-Yates)
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
  // Ẩn bài người khác, chỉ người xem thấy bài của mình
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
  // Nếu chỉ còn 1 người chưa fold => thắng luôn
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

  // first to act postflop is seat after dealer
  const seats = room.players.map((p) => p.seat).sort((a, b) => a - b);
  const dealerIdx = seats.indexOf(room.dealerSeat);
  room.currentSeat = seats[(dealerIdx + 1) % seats.length];

  // skip folded/all-in
  room.currentSeat = nextSeat(room, room.currentSeat === seats[0] ? seats[seats.length - 1] : room.currentSeat - 1);

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
  const winners = solved.filter((x) => winnersHands.includes(x.hand)).map((x) => x.p);

  const share = Math.floor(room.pot / winners.length);
  let remainder = room.pot - share * winners.length;

  for (const w of winners) {
    w.tokens += share;
    // chia lẻ theo unit 5 (nếu còn)
    if (remainder > 0) {
      w.tokens += MIN_UNIT;
      remainder -= MIN_UNIT;
    }
  }

  room.pot = 0;

  broadcastRoom(room);

  // tự động bắt đầu ván mới sau 3 giây (nếu còn >=2 người có token)
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

  // Nếu chỉ còn 1 người chưa fold => end
  const act = activePlayers(room);
  if (act.length === 1) {
    act[0].tokens += room.pot;
    room.pot = 0;
    room.stage = "showdown";
    broadcastRoom(room);
    setTimeout(() => startHand(room), 2000);
    return;
  }

  // Nếu hết vòng cược => sang stage
  if (allBetsSettled(room)) {
    advanceStage(room);
    return;
  }

  // next player
  room.currentSeat = nextSeat(room, room.currentSeat);
  broadcastRoom(room);
}

io.on("connection", (socket) => {
  socket.on("join", ({ roomId, name }) => {
    roomId = String(roomId || "").trim().slice(0, 24);
    name = String(name || "").trim().slice(0, 18);

    if (!roomId || !name) {
      socket.emit("errorMsg", "Bạn cần nhập Tên và Mã phòng.");
      return;
    }

    const room = getRoom(roomId);

    // ✅ Giới hạn tối đa 9 người
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("errorMsg", "Phòng đã đủ 9 người. Hãy tạo phòng mới hoặc dùng mã phòng khác.");
      return;
    }

    // chống trùng tên trong phòng
    const existingName = room.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existingName) {
      socket.emit("errorMsg", "Tên này đã có trong phòng. Hãy chọn tên khác.");
      return;
    }

    // gán seat nhỏ nhất chưa dùng
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

    // nếu đang trong ván mà người mới vào: cho họ đứng xem (không có bài)
    if (room.started && room.stage !== "lobby") {
      player.cards = [];
      player.folded = true;
      player.allIn = false;
      player.betThisRound = 0;
    }

    broadcastRoom(room);
  });

  socket.on("start", ({ roomId }) => {
    const room = getRoom(String(roomId || "").trim());
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    if (room.players.filter((p) => p.tokens > 0).length < 2) {
      socket.emit("errorMsg", "Cần ít nhất 2 người còn token để bắt đầu.");
      return;
    }

    startHand(room);
  });

  socket.on("action", ({ roomId, action, amount }) => {
    const room = getRoom(String(roomId || "").trim());
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    doAction(room, player, action, amount);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);

        // nếu đang chơi mà thiếu người -> về lobby
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
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Poker server running: http://localhost:${PORT}`);
});
