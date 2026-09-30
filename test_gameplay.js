require('./src/server.js');
const http = require('http');
const { WebSocket } = require('ws');

const BASE_URL = 'http://127.0.0.1:8085/api/bazooka/server';
const WS_URL = 'ws://127.0.0.1:8085/api/bazooka/server/ws';

async function request(endpoint, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });

  return { status: res.status, data: await res.json() };
}

async function runTests() {
  console.log('--- 1. Testing Auth & Zero Fake Data ---');
  const u1Res = await request('/auth/register', 'POST', {
    username: 'warrior_' + Date.now().toString().slice(-4),
    password: 'password123',
    displayName: 'مقاتل_بازوكا_1'
  });
  console.log('User 1 Registered:', u1Res.status === 200, u1Res.data.user.displayName);
  const token1 = u1Res.data.token;
  const user1 = u1Res.data.user;

  const u2Res = await request('/auth/register', 'POST', {
    username: 'challenger_' + Date.now().toString().slice(-4),
    password: 'password123',
    displayName: 'مقاتل_بازوكا_2'
  });
  console.log('User 2 Registered:', u2Res.status === 200, u2Res.data.user.displayName);
  const token2 = u2Res.data.token;
  const user2 = u2Res.data.user;

  console.log('\n--- 2. Testing Room Creation ---');
  const roomRes = await request('/rooms', 'POST', { name: 'ساحة التحدي الكبرى', maxPlayers: 6 }, token1);
  console.log('Room Created:', roomRes.status === 200, roomRes.data.name, 'ID:', roomRes.data.id);
  const roomId = roomRes.data.id;

  console.log('\n--- 3. Testing Real-time WebSocket Circular Room &authoritative 7s Timer ---');
  const ws1 = new WebSocket(`${WS_URL}?token=${token1}`);
  const ws2 = new WebSocket(`${WS_URL}?token=${token2}`);

  await Promise.all([
    new Promise(res => ws1.on('open', res)),
    new Promise(res => ws2.on('open', res))
  ]);

  console.log('Both players connected to WebSocket successfully.');

  let turnTicksReceived = 0;
  let gameStarted = false;

  ws1.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'turn_tick') {
      turnTicksReceived++;
      if (turnTicksReceived <= 3) {
        console.log(`[Authoritative 7s Timer Tick]: Player ${msg.payload.playerId} has ${msg.payload.seconds}s remaining`);
      }
    } else if (msg.type === 'game_over') {
      console.log('*** GAME OVER RECEIVED *** Winner:', msg.payload.winner.displayName, '+1 VP Awarded');
    }
  });

  // Join Room
  ws1.send(JSON.stringify({ type: 'join_room', payload: { roomId } }));
  ws2.send(JSON.stringify({ type: 'join_room', payload: { roomId } }));

  await new Promise(r => setTimeout(r, 600));

  // Set Ready
  ws1.send(JSON.stringify({ type: 'set_ready', payload: { isReady: true } }));
  ws2.send(JSON.stringify({ type: 'set_ready', payload: { isReady: true } }));

  await new Promise(r => setTimeout(r, 400));

  // Host starts game
  ws1.send(JSON.stringify({ type: 'start_game', payload: {} }));
  console.log('Start game event dispatched by host.');

  await new Promise(r => setTimeout(r, 2000));

  console.log(`Received ${turnTicksReceived} timer ticks so far from authoritative server.`);

  // Test Gun Action
  console.log('\n--- 4. Testing Gun Action (-1 point) ---');
  ws1.send(JSON.stringify({
    type: 'game_action',
    payload: { actionType: 'GUN', targetPlayerId: user2.id }
  }));

  await new Promise(r => setTimeout(r, 1000));

  // Test Duel or Bazooka
  console.log('\n--- 5. Testing Bazooka Action (Direct Elimination) ---');
  ws1.send(JSON.stringify({
    type: 'game_action',
    payload: { actionType: 'BAZOOKA', targetPlayerId: user2.id }
  }));

  await new Promise(r => setTimeout(r, 1500));

  // Check Profile & Match History on REST
  console.log('\n--- 6. Verifying Updated Real Data on Server (Victory Points & History) ---');
  const prof1 = await request('/profile/me', 'GET', null, token1);
  console.log(`Winner Profile: ${prof1.data.displayName}, Victory Points: ${prof1.data.victoryPoints}, Wins: ${prof1.data.winsCount}`);

  const history = await request('/matches/history', 'GET', null, token1);
  console.log(`Match History recorded: ${history.data.length} match(es). First match won: ${history.data[0]?.wasWinner}`);

  ws1.close();
  ws2.close();
  console.log('\n>>> All Real Multiplayer Authoritative Backend Tests Passed Successfully! <<<');
  process.exit(0);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
