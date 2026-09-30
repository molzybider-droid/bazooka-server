const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Health check and root info endpoints (for Cloud Hosting / Uptime monitoring)
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    game: 'بازوكا',
    message: 'خادم لعبة بازوكا يعمل بنجاح!',
    endpoints: {
      api: '/api/bazooka/server',
      health: '/health'
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

const PORT = process.env.PORT || 8085;
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initial Database - Zero Fake Data!
let db = {
  users: {},
  tokens: {},
  marketListings: [],
  matchHistory: {},
  friends: {}
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse database file, initializing clean database.');
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving db:', e);
  }
}

// In-Memory Active Game Rooms (Server Authoritative)
const activeRooms = new Map();
const roomTimers = new Map();
const clientSessions = new Map();

// Helper to authenticate request
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ message: 'غير مصرح' });
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const userId = db.tokens[token];
  if (!userId || !db.users[userId]) {
    return res.status(401).json({ message: 'جلسة غير صالحة' });
  }
  req.user = db.users[userId];
  next();
}

// --- REST API Router ---
const apiRouter = express.Router();

// 1. Auth: Register
apiRouter.post('/auth/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) {
    return res.status(400).json({ message: 'جميع الحقول مطلوبة' });
  }
  const cleanUsername = username.trim().toLowerCase();
  for (const uid in db.users) {
    if (db.users[uid].username.toLowerCase() === cleanUsername) {
      return res.status(400).json({ message: 'اسم المستخدم مسجل مسبقًا' });
    }
  }

  const userId = 'usr_' + crypto.randomUUID().slice(0, 8);
  const token = 'tok_' + crypto.randomUUID();
  const newUser = {
    id: userId,
    username: cleanUsername,
    password: password,
    displayName: displayName.trim(),
    avatar: 'avatar_1',
    victoryPoints: 0,
    bazookas: 5,
    fireBazookas: 0,
    winsCount: 0,
    matchesCount: 0,
    createdAt: Date.now()
  };

  db.users[userId] = newUser;
  db.tokens[token] = userId;
  saveDb();

  const { password: _, ...userSafe } = newUser;
  res.json({ token, user: userSafe });
});

// 2. Auth: Login
apiRouter.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
  }
  const cleanUsername = username.trim().toLowerCase();
  let foundUser = null;
  for (const uid in db.users) {
    if (db.users[uid].username === cleanUsername && db.users[uid].password === password) {
      foundUser = db.users[uid];
      break;
    }
  }

  if (!foundUser) {
    return res.status(401).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const token = 'tok_' + crypto.randomUUID();
  db.tokens[token] = foundUser.id;
  saveDb();

  const { password: _, ...userSafe } = foundUser;
  res.json({ token, user: userSafe });
});

// 3. Auth: Guest
apiRouter.post('/auth/guest', (req, res) => {
  const { displayName } = req.body;
  const guestName = displayName ? displayName.trim() : 'مقاتل_بازوكا';
  const userId = 'guest_' + crypto.randomUUID().slice(0, 8);
  const token = 'tok_' + crypto.randomUUID();

  const guestUser = {
    id: userId,
    username: 'guest_' + userId.slice(6),
    password: '',
    displayName: guestName,
    avatar: 'avatar_1',
    victoryPoints: 0,
    bazookas: 5,
    fireBazookas: 0,
    winsCount: 0,
    matchesCount: 0,
    createdAt: Date.now()
  };

  db.users[userId] = guestUser;
  db.tokens[token] = userId;
  saveDb();

  const { password: _, ...userSafe } = guestUser;
  res.json({ token, user: userSafe });
});

// 4. Profile Me
apiRouter.get('/profile/me', authenticate, (req, res) => {
  const { password: _, ...userSafe } = req.user;
  res.json(userSafe);
});

// 5. Rooms List
apiRouter.get('/rooms', (req, res) => {
  const list = [];
  for (const [id, room] of activeRooms.entries()) {
    list.push(formatRoomForClient(room));
  }
  res.json(list);
});

// 6. Create Room
apiRouter.post('/rooms', authenticate, (req, res) => {
  const { name, maxPlayers } = req.body;
  const roomId = 'room_' + crypto.randomUUID().slice(0, 6);
  const room = {
    id: roomId,
    code: Math.floor(1000 + Math.random() * 9000).toString(),
    name: name ? name.trim() : 'ساحة بازوكا',
    hostId: req.user.id,
    maxPlayers: maxPlayers ? Math.min(8, Math.max(2, maxPlayers)) : 6,
    players: [],
    status: 'WAITING',
    currentTurnPlayerId: null,
    turnRemainingSeconds: 7,
    currentRound: 1,
    countingCycle: [],
    countingCycleIndex: 0,
    duelState: null,
    winner: null
  };

  activeRooms.set(roomId, room);
  res.json(formatRoomForClient(room));
});

// 7. Leaderboard
apiRouter.get('/leaderboard', (req, res) => {
  const list = Object.values(db.users)
    .filter(u => u.victoryPoints > 0 || u.winsCount > 0)
    .sort((a, b) => b.victoryPoints - a.victoryPoints || b.winsCount - a.winsCount)
    .slice(0, 50)
    .map((u, index) => ({
      rank: index + 1,
      id: u.id,
      displayName: u.displayName,
      avatar: u.avatar || 'avatar_1',
      victoryPoints: u.victoryPoints,
      winsCount: u.winsCount
    }));

  res.json(list);
});

// 8. Shop Items
const OFFICIAL_SHOP_ITEMS = [
  {
    id: 'bazooka_pack_5',
    title: 'حزمة البازوكا (5 بازوكا)',
    description: '5 أسلحة بازوكا مقابل 2 نقطة فوز',
    price: 2,
    currency: 'VICTORY_POINTS',
    iconType: 'BAZOOKA',
    rewardBazookas: 5
  },
  {
    id: 'seat_selection',
    title: 'تحديد المقعد المفضل',
    description: 'اختر موقعك المفضل حول الدائرة في المعركة',
    price: 1,
    currency: 'VICTORY_POINTS',
    iconType: 'SEAT_SELECT',
    rewardBazookas: 0
  },
  {
    id: 'fire_bazooka',
    title: 'البازوكا النارية المدمرة',
    description: 'إخراج فوري وحظر الهدف لمدة جولتين كاملتين',
    price: 10,
    currency: 'BAZOOKAS',
    iconType: 'FIRE_BAZOOKA',
    rewardFireBazookas: 1
  }
];

apiRouter.get('/shop/items', (req, res) => {
  res.json(OFFICIAL_SHOP_ITEMS);
});

// 9. Buy Shop Item
apiRouter.post('/shop/buy/:itemId', authenticate, (req, res) => {
  const { itemId } = req.params;
  const item = OFFICIAL_SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ message: 'العنصر غير موجود' });

  const user = req.user;
  if (item.currency === 'VICTORY_POINTS') {
    if (user.victoryPoints < item.price) {
      return res.status(400).json({ message: 'نقاط الفوز غير كافية' });
    }
    user.victoryPoints -= item.price;
  } else if (item.currency === 'BAZOOKAS') {
    if (user.bazookas < item.price) {
      return res.status(400).json({ message: 'رصيد البازوكا غير كافٍ' });
    }
    user.bazookas -= item.price;
  }

  if (item.rewardBazookas) user.bazookas += item.rewardBazookas;
  if (item.rewardFireBazookas) user.fireBazookas += item.rewardFireBazookas;

  saveDb();
  const { password: _, ...userSafe } = user;
  res.json(userSafe);
});

// 10. Marketplace Listings
apiRouter.get('/market/listings', (req, res) => {
  res.json(db.marketListings);
});

// 11. Create Market Listing
apiRouter.post('/market/listings', authenticate, (req, res) => {
  const { bazookasAmount, priceVictoryPoints } = req.body;
  const user = req.user;
  const amount = parseInt(bazookasAmount, 10);
  const price = parseInt(priceVictoryPoints, 10);

  if (!amount || amount < 1 || !price || price < 1) {
    return res.status(400).json({ message: 'قيم غير صالحة' });
  }

  if (user.bazookas < amount) {
    return res.status(400).json({ message: 'ليس لديك رصيد بازوكا كافٍ للبيع' });
  }

  user.bazookas -= amount;

  const newListing = {
    id: 'list_' + crypto.randomUUID().slice(0, 8),
    sellerId: user.id,
    sellerName: user.displayName,
    bazookasAmount: amount,
    priceVictoryPoints: price,
    createdAt: Date.now()
  };

  db.marketListings.unshift(newListing);
  saveDb();
  res.json(newListing);
});

// 12. Buy Market Listing
apiRouter.post('/market/buy/:listingId', authenticate, (req, res) => {
  const { listingId } = req.params;
  const index = db.marketListings.findIndex(l => l.id === listingId);
  if (index === -1) return res.status(404).json({ message: 'العرض لم يعد متاحًا' });

  const listing = db.marketListings[index];
  const buyer = req.user;

  if (buyer.id === listing.sellerId) {
    return res.status(400).json({ message: 'لا يمكنك شراء عرضك الخاص' });
  }

  if (buyer.victoryPoints < listing.priceVictoryPoints) {
    return res.status(400).json({ message: 'نقاط الفوز غير كافية لإتمام الصفقة' });
  }

  const seller = db.users[listing.sellerId];
  buyer.victoryPoints -= listing.priceVictoryPoints;
  buyer.bazookas += listing.bazookasAmount;

  if (seller) {
    seller.victoryPoints += listing.priceVictoryPoints;
  }

  db.marketListings.splice(index, 1);
  saveDb();

  const { password: _, ...userSafe } = buyer;
  res.json(userSafe);
});

// 13. Match History
apiRouter.get('/matches/history', authenticate, (req, res) => {
  const history = db.matchHistory[req.user.id] || [];
  res.json(history);
});

// 14. Friends
apiRouter.get('/friends', authenticate, (req, res) => {
  const friendIds = db.friends[req.user.id] || [];
  const list = friendIds.map(fid => {
    const f = db.users[fid];
    if (!f) return null;
    return {
      id: f.id,
      displayName: f.displayName,
      isOnline: isUserOnline(f.id),
      victoryPoints: f.victoryPoints
    };
  }).filter(Boolean);
  res.json(list);
});

apiRouter.post('/friends/add', authenticate, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ message: 'اسم الصديق مطلوب' });
  const cleanUsername = username.trim().toLowerCase();

  let targetUser = null;
  for (const uid in db.users) {
    if (db.users[uid].username === cleanUsername) {
      targetUser = db.users[uid];
      break;
    }
  }

  if (!targetUser || targetUser.id === req.user.id) {
    return res.status(404).json({ message: 'تعذر العثور على اللاعب' });
  }

  if (!db.friends[req.user.id]) db.friends[req.user.id] = [];
  if (!db.friends[req.user.id].includes(targetUser.id)) {
    db.friends[req.user.id].push(targetUser.id);
    saveDb();
  }

  res.json({
    id: targetUser.id,
    displayName: targetUser.displayName,
    isOnline: isUserOnline(targetUser.id),
    victoryPoints: targetUser.victoryPoints
  });
});

// Mount the API Router on BOTH paths:
// 1. Full requested path: /api/bazooka/server
app.use('/api/bazooka/server', apiRouter);
// 2. Standard path: /api
app.use('/api', apiRouter);

function isUserOnline(userId) {
  for (const [ws, sess] of clientSessions.entries()) {
    if (sess.userId === userId && ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

function formatRoomForClient(room) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    players: room.players,
    status: room.status,
    currentTurnPlayerId: room.currentTurnPlayerId,
    turnRemainingSeconds: room.turnRemainingSeconds,
    currentRound: room.currentRound,
    duelState: room.duelState,
    winner: room.winner
  };
}

// --- Real-time WebSocket Authoritative Game Server ---
const server = http.createServer(app);
// Listen on all paths for WebSocket upgrades
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const userId = db.tokens[token];

  if (!userId || !db.users[userId]) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const user = db.users[userId];
  clientSessions.set(ws, { userId: user.id, roomId: null });

  ws.on('message', (messageRaw) => {
    try {
      const msg = JSON.parse(messageRaw.toString());
      handleClientSocketMessage(ws, user, msg.type, msg.payload);
    } catch (e) {
      console.error('Socket message parse error:', e);
    }
  });

  ws.on('close', () => {
    handlePlayerDisconnect(ws);
    clientSessions.delete(ws);
  });
});

function handleClientSocketMessage(ws, user, type, payload) {
  const session = clientSessions.get(ws);
  if (!session) return;

  switch (type) {
    case 'join_room': {
      const { roomId } = payload;
      joinRoom(ws, user, roomId);
      break;
    }
    case 'leave_room': {
      leaveRoom(ws);
      break;
    }
    case 'set_ready': {
      const { isReady } = payload;
      setPlayerReady(ws, isReady);
      break;
    }
    case 'select_seat': {
      const { seatIndex } = payload;
      selectSeat(ws, seatIndex);
      break;
    }
    case 'start_game': {
      startGame(ws);
      break;
    }
    case 'game_action': {
      const { actionType, targetPlayerId } = payload;
      executeGameAction(ws, actionType, targetPlayerId);
      break;
    }
    case 'duel_choice': {
      const { choice } = payload;
      handleDuelChoice(ws, choice);
      break;
    }
  }
}

function joinRoom(ws, user, roomId) {
  const room = activeRooms.get(roomId);
  if (!room) {
    sendToSocket(ws, 'error', { message: 'الغرفة غير موجودة' });
    return;
  }

  if (room.players.length >= room.maxPlayers && !room.players.some(p => p.id === user.id)) {
    sendToSocket(ws, 'error', { message: 'الغرفة ممتلئة بالكامل' });
    return;
  }

  let player = room.players.find(p => p.id === user.id);
  if (!player) {
    player = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar || 'avatar_1',
      health: 3,
      bazookas: user.bazookas,
      fireBazookas: user.fireBazookas,
      victoryPoints: user.victoryPoints,
      isSpectator: room.status !== 'WAITING',
      isEliminated: room.status !== 'WAITING',
      isReady: false,
      seatIndex: room.players.length,
      roundsBanned: 0
    };
    room.players.push(player);
  }

  const session = clientSessions.get(ws);
  if (session) session.roomId = roomId;

  broadcastToRoom(roomId, 'room_state', formatRoomForClient(room));
}

function leaveRoom(ws) {
  const session = clientSessions.get(ws);
  if (!session || !session.roomId) return;
  const roomId = session.roomId;
  const room = activeRooms.get(roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== session.userId);
  session.roomId = null;

  if (room.players.length === 0) {
    stopRoomTimer(roomId);
    activeRooms.delete(roomId);
  } else {
    if (room.currentTurnPlayerId === session.userId && room.status === 'PLAYING') {
      advanceTurn(room);
    }
    broadcastToRoom(roomId, 'room_state', formatRoomForClient(room));
  }
}

function handlePlayerDisconnect(ws) {
  leaveRoom(ws);
}

function setPlayerReady(ws, isReady) {
  const session = clientSessions.get(ws);
  if (!session || !session.roomId) return;
  const room = activeRooms.get(session.roomId);
  if (!room || room.status !== 'WAITING') return;

  const player = room.players.find(p => p.id === session.userId);
  if (player) {
    player.isReady = !!isReady;
    broadcastToRoom(room.id, 'room_state', formatRoomForClient(room));
  }
}

function selectSeat(ws, seatIndex) {
  const session = clientSessions.get(ws);
  if (!session || !session.roomId) return;
  const room = activeRooms.get(session.roomId);
  if (!room) return;

  const player = room.players.find(p => p.id === session.userId);
  if (player) {
    player.seatIndex = seatIndex;
    broadcastToRoom(room.id, 'room_state', formatRoomForClient(room));
  }
}

function startGame(ws) {
  const session = clientSessions.get(ws);
  if (!session || !session.roomId) return;
  const room = activeRooms.get(session.roomId);
  if (!room || room.status !== 'WAITING') return;
  if (room.hostId !== session.userId) {
    sendToSocket(ws, 'error', { message: 'المضيف فقط يستطيع بدء المعركة' });
    return;
  }
  if (room.players.length < 2) {
    sendToSocket(ws, 'error', { message: 'يلزم وجود لاعبين على الأقل للبدء' });
    return;
  }

  room.status = 'PLAYING';
  room.currentRound = 1;
  room.players.forEach(p => {
    p.health = 3;
    p.isEliminated = false;
    p.isSpectator = false;
  });

  buildCountingCycle(room);
  startAuthoritativeTurnTimer(room);
  broadcastToRoom(room.id, 'room_state', formatRoomForClient(room));
}

function buildCountingCycle(room) {
  const livingPlayers = room.players.filter(p => !p.isEliminated && !p.isSpectator && p.roundsBanned === 0);
  if (livingPlayers.length === 0) return;

  const cycle = [];
  livingPlayers.forEach(p => {
    if (p.health === 2) {
      cycle.push(p.id);
      cycle.push(p.id);
    } else {
      cycle.push(p.id);
    }
  });

  const startIndex = Math.floor(Math.random() * cycle.length);
  room.countingCycle = cycle;
  room.countingCycleIndex = startIndex;
  room.currentTurnPlayerId = cycle[startIndex];
  room.turnRemainingSeconds = 7;
}

function advanceTurn(room) {
  const livingPlayers = room.players.filter(p => !p.isEliminated && !p.isSpectator);

  if (livingPlayers.length <= 1) {
    finishGame(room, livingPlayers[0] || null);
    return;
  }

  if (livingPlayers.length === 2 && room.status !== 'DUEL') {
    startFinalDuel(room, livingPlayers[0], livingPlayers[1]);
    return;
  }

  buildCountingCycle(room);

  room.countingCycleIndex = (room.countingCycleIndex + 1) % room.countingCycle.length;
  room.currentTurnPlayerId = room.countingCycle[room.countingCycleIndex];
  room.turnRemainingSeconds = 7;

  broadcastToRoom(room.id, 'room_state', formatRoomForClient(room));
}

function startAuthoritativeTurnTimer(room) {
  stopRoomTimer(room.id);

  const timer = setInterval(() => {
    if (room.status !== 'PLAYING') return;

    room.turnRemainingSeconds -= 1;

    broadcastToRoom(room.id, 'turn_tick', {
      playerId: room.currentTurnPlayerId,
      seconds: Math.max(0, room.turnRemainingSeconds)
    });

    if (room.turnRemainingSeconds <= 0) {
      advanceTurn(room);
    }
  }, 1000);

  roomTimers.set(room.id, timer);
}

function stopRoomTimer(roomId) {
  if (roomTimers.has(roomId)) {
    clearInterval(roomTimers.get(roomId));
    roomTimers.delete(roomId);
  }
}

function executeGameAction(ws, actionType, targetPlayerId) {
  const session = clientSessions.get(ws);
  if (!session || !session.roomId) return;
  const room = activeRooms.get(session.roomId);
  if (!room || room.status !== 'PLAYING') {
    sendToSocket(ws, 'error', { message: 'المعركة ليست في حالة لعب' });
    return;
  }

  if (room.currentTurnPlayerId !== session.userId) {
    sendToSocket(ws, 'error', { message: 'ليس دورك الآن' });
    return;
  }

  const actor = room.players.find(p => p.id === session.userId);
  if (!actor || actor.isEliminated || actor.isSpectator) {
    sendToSocket(ws, 'error', { message: 'لا يمكن للاعب مقصى أو متفرج تنفيذ أي هجوم' });
    return;
  }

  const target = room.players.find(p => p.id === targetPlayerId);
  if (!target || target.isEliminated || target.isSpectator) {
    sendToSocket(ws, 'error', { message: 'الهدف غير صالح أو تم إقصاؤه' });
    return;
  }

  let actionLogMessage = '';

  switch (actionType) {
    case 'GUN': {
      target.health -= 1;
      actionLogMessage = `${actor.displayName} أطلق المسدس على ${target.displayName} (-1 نقطة)`;

      if (target.health <= 0) {
        target.health = 0;
        target.isEliminated = true;
        target.isSpectator = true;
        broadcastToRoom(room.id, 'player_eliminated', {
          playerId: target.id,
          playerName: target.displayName,
          isBanned: false
        });
      }
      break;
    }

    case 'BAZOOKA': {
      target.health = 0;
      target.isEliminated = true;
      target.isSpectator = true;
      actionLogMessage = `${actor.displayName} أطلق بازوكا مدمرة على ${target.displayName} وأقصاه فورًا!`;

      broadcastToRoom(room.id, 'player_eliminated', {
        playerId: target.id,
        playerName: target.displayName,
        isBanned: false
      });
      break;
    }

    case 'GIVE_BAZOOKA': {
      const dbActor = db.users[actor.id];
      if (!dbActor || dbActor.bazookas < 1) {
        sendToSocket(ws, 'error', { message: 'لا تملك بازوكا لإهدائها' });
        return;
      }
      dbActor.bazookas -= 1;
      actor.bazookas = dbActor.bazookas;

      const dbTarget = db.users[target.id];
      if (dbTarget) {
        dbTarget.bazookas += 1;
        target.bazookas = dbTarget.bazookas;
      }
      saveDb();
      actionLogMessage = `${actor.displayName} أهدى بازوكا إلى ${target.displayName}`;
      break;
    }

    case 'FIRE_BAZOOKA': {
      const dbActor = db.users[actor.id];
      if (!dbActor || (dbActor.fireBazookas < 1 && dbActor.bazookas < 10)) {
        sendToSocket(ws, 'error', { message: 'يلزم 1 بازوكا نارية أو 10 بازوكا عادية' });
        return;
      }

      if (dbActor.fireBazookas >= 1) {
        dbActor.fireBazookas -= 1;
      } else {
        dbActor.bazookas -= 10;
      }
      actor.bazookas = dbActor.bazookas;
      actor.fireBazookas = dbActor.fireBazookas;

      target.health = 0;
      target.isEliminated = true;
      target.isSpectator = true;
      target.roundsBanned = 2;
      saveDb();

      actionLogMessage = `${actor.displayName} أطلق البازوكا النارية على ${target.displayName}! تم إقصاؤه وحظره لمدة جولتين!`;
      broadcastToRoom(room.id, 'player_eliminated', {
        playerId: target.id,
        playerName: target.displayName,
        isBanned: true
      });
      break;
    }
  }

  broadcastToRoom(room.id, 'action_executed', {
    actorId: actor.id,
    actionType: actionType,
    targetId: target.id,
    message: actionLogMessage
  });

  advanceTurn(room);
}

function startFinalDuel(room, p1, p2) {
  stopRoomTimer(room.id);
  room.status = 'DUEL';
  room.duelState = {
    player1Id: p1.id,
    player2Id: p2.id,
    player1Name: p1.displayName,
    player2Name: p2.displayName,
    player1Score: 0,
    player2Score: 0,
    player1Choice: null,
    player2Choice: null,
    lastRoundWinner: null,
    winnerId: null
  };

  broadcastToRoom(room.id, 'room_state', formatRoomForClient(room));
}

function handleDuelChoice(ws, choice) {
  const session = clientSessions.get(ws);
  if (!session || !session.roomId) return;
  const room = activeRooms.get(session.roomId);
  if (!room || room.status !== 'DUEL' || !room.duelState) return;

  const duel = room.duelState;
  if (session.userId === duel.player1Id) {
    duel.player1Choice = choice;
  } else if (session.userId === duel.player2Id) {
    duel.player2Choice = choice;
  } else {
    return;
  }

  if (duel.player1Choice && duel.player2Choice) {
    const outcome = resolveRPS(duel.player1Choice, duel.player2Choice);
    if (outcome === 1) {
      duel.player1Score += 1;
      duel.lastRoundWinner = 'PLAYER_1';
    } else if (outcome === 2) {
      duel.player2Score += 1;
      duel.lastRoundWinner = 'PLAYER_2';
    } else {
      duel.lastRoundWinner = 'TIE';
    }

    duel.player1Choice = null;
    duel.player2Choice = null;

    if (duel.player1Score >= 3) {
      const winner = room.players.find(p => p.id === duel.player1Id);
      finishGame(room, winner);
      return;
    } else if (duel.player2Score >= 3) {
      const winner = room.players.find(p => p.id === duel.player2Id);
      finishGame(room, winner);
      return;
    }

    broadcastToRoom(room.id, 'room_state', formatRoomForClient(room));
  } else {
    broadcastToRoom(room.id, 'room_state', formatRoomForClient(room));
  }
}

function resolveRPS(c1, c2) {
  if (c1 === c2) return 0;
  if (
    (c1 === 'ROCK' && c2 === 'SCISSORS') ||
    (c1 === 'PAPER' && c2 === 'ROCK') ||
    (c1 === 'SCISSORS' && c2 === 'PAPER')
  ) {
    return 1;
  }
  return 2;
}

function finishGame(room, winner) {
  stopRoomTimer(room.id);
  room.status = 'FINISHED';
  room.winner = winner;

  if (winner) {
    const dbWinner = db.users[winner.id];
    if (dbWinner) {
      dbWinner.victoryPoints = (dbWinner.victoryPoints || 0) + 1;
      dbWinner.winsCount = (dbWinner.winsCount || 0) + 1;
    }
  }

  const matchDate = new Date().toLocaleDateString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  room.players.forEach(p => {
    const dbP = db.users[p.id];
    if (dbP) {
      dbP.matchesCount = (dbP.matchesCount || 0) + 1;
      if (!db.matchHistory[p.id]) db.matchHistory[p.id] = [];
      const wasWinner = winner && winner.id === p.id;
      db.matchHistory[p.id].unshift({
        id: 'mat_' + crypto.randomUUID().slice(0, 8),
        roomName: room.name,
        date: matchDate,
        rank: wasWinner ? 1 : 2,
        victoryPointsEarned: wasWinner ? 1 : 0,
        playersCount: room.players.length,
        wasWinner: wasWinner
      });
    }
  });

  saveDb();

  broadcastToRoom(room.id, 'game_over', {
    winner: winner,
    pointsAwarded: 1
  });
  broadcastToRoom(room.id, 'room_state', formatRoomForClient(room));
}

function broadcastToRoom(roomId, type, payload) {
  const json = JSON.stringify({ type, payload });
  for (const [ws, session] of clientSessions.entries()) {
    if (session.roomId === roomId && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

function sendToSocket(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`«بازوكا» Multiplayer Backend Server running on port ${PORT}`);
  console.log(`Endpoints available on:`);
  console.log(`- Path 1: http://localhost:${PORT}/api/bazooka/server/`);
  console.log(`- Path 2: http://localhost:${PORT}/api/`);
  console.log(`- WebSocket: ws://localhost:${PORT}/ (and /api/bazooka/server/ws)`);
});
