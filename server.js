'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3311;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'players.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DUEL_DURATION = Number(process.env.DUEL_DURATION) || 50000; // 50 秒（可用环境变量覆盖，便于测试）
const MATCH_START_DELAY = Number(process.env.MATCH_START_DELAY) || 3; // 配对后倒计时（秒）

// ---------------------------------------------------------------------------
// 持久化：账号 + 战绩（内存态为主，变更时落盘 JSON）
// ---------------------------------------------------------------------------
function loadPlayers() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('[store] 读取 players.json 失败：', e.message);
  }
  return {};
}
const players = loadPlayers();

function savePlayers() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(players, null, 2));
  } catch (e) {
    console.error('[store] 写入 players.json 失败：', e.message);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
const newSalt = () => crypto.randomBytes(16).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const newId = () => crypto.randomBytes(6).toString('hex');

function publicPlayer(username) {
  const p = players[username];
  return p ? { username: p.username, stats: p.stats, createdAt: p.createdAt } : null;
}
function ensureStats(username) {
  if (!players[username].stats) players[username].stats = { wins: 0, losses: 0, draws: 0, gamesPlayed: 0, highScore: 0 };
  return players[username].stats;
}
function applyResult(username, result, score) {
  const st = ensureStats(username);
  st.gamesPlayed += 1;
  if (result === 'win') st.wins += 1;
  else if (result === 'lose') st.losses += 1;
  else st.draws += 1;
  if (score > st.highScore) st.highScore = score;
}

// ---------------------------------------------------------------------------
// 会话 / 连接状态
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> username
const connByUser = new Map(); // username -> ws（同账号重连时踢掉旧连接）

const rooms = new Map(); // roomId -> room
const roomsByCode = new Map(); // 房号 -> roomId

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function attach(ws, username) {
  ws.username = username;
  const prev = connByUser.get(username);
  if (prev && prev !== ws) prev.close(4001, 'reconnected');
  connByUser.set(username, ws);
}

// ---------------------------------------------------------------------------
// 房间 + 好友对战
// ---------------------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混淆 0/O/1/I/L
function genCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (roomsByCode.has(code));
  return code;
}

function cleanupRoom(room) {
  cleanupRoom(room);
  if (room.code) roomsByCode.delete(room.code);
}

function handleCreateRoom(ws) {
  if (!ws.username) return;
  leaveRoom(ws);
  const code = genCode();
  const room = {
    id: newId(), code, a: ws.username, b: null, status: 'waiting',
    seed: 0, duration: DUEL_DURATION, scores: {}, combo: {}, ended: false, timer: null,
  };
  rooms.set(room.id, room);
  roomsByCode.set(code, room.id);
  ws.roomId = room.id;
  send(ws, { type: 'room_created', code });
}

function handleJoinRoom(ws, msg) {
  if (!ws.username) return;
  const code = String(msg.code || '').trim().toUpperCase();
  const room = roomsByCode.has(code) ? rooms.get(roomsByCode.get(code)) : null;
  if (!room || room.ended || room.status !== 'waiting') return send(ws, { type: 'room_err', message: '房间不存在或已开始' });
  if (room.a === ws.username) return send(ws, { type: 'room_err', message: '不能加入自己创建的房间' });
  leaveRoom(ws);
  room.b = ws.username;
  room.status = 'playing';
  room.seed = (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0;
  room.scores = { [room.a]: 0, [room.b]: 0 };
  room.combo = { [room.a]: 0, [room.b]: 0 };
  ws.roomId = room.id;
  const a = connByUser.get(room.a);
  send(a, { type: 'room_start', roomId: room.id, opponent: publicPlayer(room.b), startIn: MATCH_START_DELAY });
  send(ws, { type: 'room_start', roomId: room.id, opponent: publicPlayer(room.a), startIn: MATCH_START_DELAY });
  room.timer = setTimeout(() => startRoom(room), MATCH_START_DELAY * 1000);
}

function startRoom(room) {
  if (room.ended) return;
  const a = connByUser.get(room.a);
  const b = connByUser.get(room.b);
  if (!a || !b || a.readyState !== 1 || b.readyState !== 1) {
    forfeit(room, !a || a.readyState !== 1 ? room.a : room.b);
    return;
  }
  room.deadline = Date.now() + room.duration;
  send(a, { type: 'game_start', seed: room.seed, duration: room.duration, opponent: publicPlayer(room.b) });
  send(b, { type: 'game_start', seed: room.seed, duration: room.duration, opponent: publicPlayer(room.a) });
  room.timer = setTimeout(() => settleRoom(room), room.duration + 600);
}

function settleRoom(room) {
  if (room.ended) return;
  room.ended = true;
  clearTimeout(room.timer);
  const sa = room.scores[room.a] || 0;
  const sb = room.scores[room.b] || 0;
  let ra = 'draw', rb = 'draw';
  if (sa > sb) { ra = 'win'; rb = 'lose'; }
  else if (sb > sa) { ra = 'lose'; rb = 'win'; }
  applyResult(room.a, ra, sa);
  applyResult(room.b, rb, sb);
  const a = connByUser.get(room.a);
  const b = connByUser.get(room.b);
  if (a) { send(a, { type: 'game_end', result: ra, yourScore: sa, oppScore: sb, stats: publicPlayer(room.a).stats }); a.roomId = null; }
  if (b) { send(b, { type: 'game_end', result: rb, yourScore: sb, oppScore: sa, stats: publicPlayer(room.b).stats }); b.roomId = null; }
  cleanupRoom(room);
  savePlayers();
}

// 一方掉线/主动退出 -> 对方判胜
function forfeit(room, leaverUsername) {
  if (room.ended) return;
  room.ended = true;
  clearTimeout(room.timer);
  const stayUsername = room.a === leaverUsername ? room.b : room.a;
  const stay = connByUser.get(stayUsername);
  const stayScore = room.scores[stayUsername] || 0;
  const leaverScore = room.scores[leaverUsername] || 0;
  applyResult(leaverUsername, 'lose', leaverScore);
  if (stay) {
    applyResult(stayUsername, 'win', stayScore);
    send(stay, { type: 'game_end', result: 'win', yourScore: stayScore, oppScore: leaverScore, forfeit: true, stats: publicPlayer(stayUsername).stats });
    stay.roomId = null;
  }
  cleanupRoom(room);
  savePlayers();
}

function leaveRoom(ws) {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  ws.roomId = null;
  if (!room || room.ended) return;
  if (room.status === 'waiting') { cleanupRoom(room); return; }
  forfeit(room, ws.username);
}

// ---------------------------------------------------------------------------
// 消息分发
// ---------------------------------------------------------------------------
function handle(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'auth': handleAuth(ws, msg); break;
    case 'create_room': handleCreateRoom(ws); break;
    case 'join_room': handleJoinRoom(ws, msg); break;
    case 'leave': leaveRoom(ws); break;
    case 'game:score': handleScore(ws, msg); break;
    case 'ping': send(ws, { type: 'pong' }); break;
  }
}

function handleAuth(ws, msg) {
  const { action, username, password, token } = msg || {};

  if (action === 'resume') {
    const name = sessions.get(token);
    if (name && players[name]) {
      attach(ws, name);
      return send(ws, { type: 'auth_ok', token, player: publicPlayer(name) });
    }
    return send(ws, { type: 'auth_err', message: '会话已过期，请重新登录' });
  }

  const name = String(username || '').trim();
  if (!/^[一-龥A-Za-z0-9_]{2,16}$/.test(name)) {
    return send(ws, { type: 'auth_err', message: '用户名需 2–16 位，限中文、字母、数字、下划线' });
  }
  if (String(password || '').length < 4) {
    return send(ws, { type: 'auth_err', message: '密码至少 4 位' });
  }

  if (action === 'register') {
    if (players[name]) return send(ws, { type: 'auth_err', message: '该用户名已被注册' });
    const salt = newSalt();
    players[name] = {
      username: name,
      salt,
      hash: hashPassword(password, salt),
      createdAt: Date.now(),
      stats: { wins: 0, losses: 0, draws: 0, gamesPlayed: 0, highScore: 0 },
    };
    savePlayers();
    const t = newToken();
    sessions.set(t, name);
    attach(ws, name);
    return send(ws, { type: 'auth_ok', token: t, player: publicPlayer(name) });
  }

  if (action === 'login') {
    const rec = players[name];
    if (!rec) return send(ws, { type: 'auth_err', message: '账号不存在' });
    const h = hashPassword(password, rec.salt);
    if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(rec.hash, 'hex'))) {
      return send(ws, { type: 'auth_err', message: '密码错误' });
    }
    const t = newToken();
    sessions.set(t, name);
    attach(ws, name);
    return send(ws, { type: 'auth_ok', token: t, player: publicPlayer(name) });
  }

  send(ws, { type: 'auth_err', message: '未知操作' });
}

function handleScore(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room || room.ended) return;
  room.scores[ws.username] = Number(msg.score) || 0;
  room.combo[ws.username] = Number(msg.combo) || 0;
  const otherUsername = room.a === ws.username ? room.b : room.a;
  const other = connByUser.get(otherUsername);
  if (other && other.readyState === 1) {
    send(other, { type: 'opponent_score', score: room.scores[ws.username], combo: room.combo[ws.username] });
  }
}

// ---------------------------------------------------------------------------
// HTTP 静态服务
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  if ((req.url || '/').split('?')[0] === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, players: Object.keys(players).length, rooms: rooms.size }));
  }
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  });
});

// ---------------------------------------------------------------------------
// WebSocket 服务
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.username = null;
  ws.roomId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    handle(ws, msg);
  });

  ws.on('close', () => {
    if (ws.roomId) leaveRoom(ws);
    if (ws.username && connByUser.get(ws.username) === ws) connByUser.delete(ws.username);
  });

  ws.on('error', () => {});
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ✦ 轨道花园 · Orbit Bloom`);
  console.log(`  ├─ 本机访问：http://localhost:${PORT}`);
  console.log(`  └─ 局域网联机：http://<本机IP>:${PORT}\n`);
});
