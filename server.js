// Unikum – ett ordspel för upp till 8 spelare.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { buildCategories, findEntry, key, clean, matchScore, TIER_INFO, TIERS } = require('./lib/words');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 8;

const CATEGORIES = buildCategories();
const CAT_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

// ---------- Statistik som gör sällsynthet bättre ju mer ni spelar ----------
let stats = {};
let learned = {};
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try { stats = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stats.json'), 'utf8')); } catch {}
try { learned = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'learned.json'), 'utf8')); } catch {}

function addLearned(cat, display) {
  const id = key(display);
  if (cat.byKey.has(id)) return cat.byKey.get(id);
  const entry = { id, display, keys: [id], tier: 'r', learned: true };
  cat.entries.push(entry);
  cat.byKey.set(id, entry);
  return entry;
}
for (const [catId, list] of Object.entries(learned)) {
  const cat = CAT_BY_ID.get(catId);
  if (cat) for (const d of list) addLearned(cat, d);
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'stats.json'), JSON.stringify(stats));
      fs.writeFileSync(path.join(DATA_DIR, 'learned.json'), JSON.stringify(learned));
    } catch (e) { console.error('Kunde inte spara statistik', e.message); }
  }, 2000);
}

function tierFor(cat, entry) {
  const base = TIERS.indexOf(entry.tier);
  const s = stats[cat.id];
  if (!s || s._total < 40) return entry.tier;
  const share = (s[entry.id] || 0) / s._total;
  const ratio = share * cat.entries.length;
  const statIdx = ratio >= 3 ? 0 : ratio >= 1.2 ? 1 : ratio >= 0.4 ? 2 : 3;
  return TIERS[Math.round((base + statIdx * 2) / 3)];
}

function recordStat(cat, entry) {
  const s = (stats[cat.id] = stats[cat.id] || { _total: 0 });
  s._total++;
  s[entry.id] = (s[entry.id] || 0) + 1;
  saveSoon();
}

// ---------- Rum ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(c));
  return c;
}

const AVATARS = ['🐙', '🦊', '🐸', '🐼', '🦄', '🐯', '🐨', '🐵', '🐧', '🦉', '🐢', '🦀', '🐝', '🦖', '🐳', '🦔'];
const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac'];

function defaultSettings() {
  return { turnTime: 15, lives: 3, strict: false, speedup: true, packs: { teman: true, lander: true, djur: true, orter: true } };
}

function createRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    phase: 'lobby',
    settings: defaultSettings(),
    players: [],
    round: null,
    lastRound: null,
    recentCats: [],
    winnerId: null,
    timer: null,
    emptySince: null,
    roundNum: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function publicState(room) {
  const r = room.round;
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    winnerId: room.winnerId,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, color: p.color, lives: p.lives, score: p.score,
      alive: p.alive, connected: p.connected, spectator: p.spectator, best: p.best, answers: p.answerCount,
    })),
    round: r && {
      num: r.num,
      category: { id: r.cat.id, name: r.cat.name, emoji: r.cat.emoji, size: r.cat.entries.length },
      answers: r.answers,
      turnPid: r.turnPid,
      deadline: r.deadline,
      turnTime: r.turnTime,
      startsAt: r.startsAt,
      vote: r.vote && { pid: r.vote.pid, text: r.vote.text, deadline: r.vote.deadline, votes: r.vote.votes },
    },
    lastRound: room.lastRound,
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  for (const p of room.players) if (p.id !== exceptId) send(p.ws, msg);
}

function sync(room) {
  const state = publicState(room);
  const now = Date.now();
  for (const p of room.players) send(p.ws, { t: 'state', state, you: p.id, now });
}

function event(room, ev) {
  broadcast(room, { t: 'event', ...ev });
}

function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    room.timer = null;
    try { fn(); } catch (e) { console.error(e); }
  }, ms);
}

const alivePlayers = (room) => room.players.filter((p) => p.alive);

function pickCategory(room) {
  const packs = room.settings.packs;
  let pool = CATEGORIES.filter((c) => packs[c.pack]);
  if (!pool.length) pool = CATEGORIES;
  const fresh = pool.filter((c) => !room.recentCats.includes(c.id));
  if (fresh.length) pool = fresh;
  // Teman väger tyngre så att bokstavskategorierna inte tar över.
  const weighted = [];
  for (const c of pool) {
    const w = c.pack === 'teman' ? 3 : c.letter ? 1 : 2;
    for (let i = 0; i < w; i++) weighted.push(c);
  }
  const cat = weighted[crypto.randomInt(weighted.length)];
  room.recentCats.push(cat.id);
  if (room.recentCats.length > 30) room.recentCats.shift();
  return cat;
}

function startGame(room) {
  for (const p of room.players) {
    p.spectator = !p.connected;
    p.alive = p.connected;
    p.lives = p.alive ? room.settings.lives : 0;
    p.score = 0;
    p.best = null;
    p.answerCount = 0;
  }
  room.winnerId = null;
  room.lastRound = null;
  room.roundNum = 0;
  const alive = alivePlayers(room);
  newRound(room, alive[crypto.randomInt(alive.length)].id);
}

function newRound(room, starterId) {
  const cat = pickCategory(room);
  room.roundNum++;
  room.phase = 'countdown';
  room.round = {
    num: room.roundNum, cat, answers: [], used: new Set(), unknownKeys: [],
    turnPid: starterId, deadline: null, turnTime: room.settings.turnTime, startsAt: Date.now() + 3500, vote: null,
  };
  sync(room);
  setTimer(room, 3500, () => beginTurn(room, starterId));
}

function turnTimeFor(room) {
  const base = room.settings.turnTime;
  if (!room.settings.speedup) return base;
  const alive = Math.max(1, alivePlayers(room).length);
  const laps = Math.floor(room.round.answers.length / alive);
  // Varje varv blir tiden två sekunder kortare, ner till ungefär en tredjedel.
  return Math.max(4, Math.ceil(base * 0.3), base - laps * 2);
}

function beginTurn(room, pid, ms) {
  const r = room.round;
  room.phase = 'turn';
  r.turnPid = pid;
  r.turnTime = turnTimeFor(room);
  const dur = ms ?? r.turnTime * 1000;
  r.deadline = Date.now() + dur;
  r.vote = null;
  sync(room);
  setTimer(room, dur + 150, () => timeout(room));
}

function nextPlayerAfter(room, pid) {
  const list = room.players;
  const idx = list.findIndex((p) => p.id === pid);
  for (let i = 1; i <= list.length; i++) {
    const p = list[(idx + i) % list.length];
    if (p.alive && p.connected) return p;
  }
  for (let i = 1; i <= list.length; i++) {
    const p = list[(idx + i) % list.length];
    if (p.alive) return p;
  }
  return null;
}

function timeout(room) {
  if (room.phase !== 'turn') return;
  const r = room.round;
  const loser = room.players.find((p) => p.id === r.turnPid);
  if (loser) {
    loser.lives = Math.max(0, loser.lives - 1);
    if (loser.lives === 0) loser.alive = false;
  }
  const unused = r.cat.entries.filter((e) => !r.used.has(e.id) && !e.learned);
  const missed = unused.filter((e) => e.tier === 'c').slice(0, 30);
  shuffle(missed);
  const rare = unused.filter((e) => e.tier === 'l');
  shuffle(rare);
  room.lastRound = {
    loserPid: loser && loser.id,
    out: loser && !loser.alive,
    category: r.cat.name,
    missed: missed.slice(0, 4).map((e) => e.display),
    rare: rare.slice(0, 2).map((e) => e.display),
    total: r.cat.entries.length,
    found: r.answers.length,
  };
  room.phase = 'roundEnd';
  event(room, { kind: 'lifeLost', pid: loser && loser.id });
  sync(room);
  setTimer(room, 6000, () => afterRound(room));
}

function afterRound(room) {
  const alive = alivePlayers(room);
  const startedWith = room.players.filter((p) => !p.spectator).length;
  if (alive.length === 0 || (startedWith > 1 && alive.length <= 1)) {
    room.phase = 'gameOver';
    const winner = alive[0] || [...room.players].sort((a, b) => b.score - a.score)[0];
    room.winnerId = winner ? winner.id : null;
    room.round = null;
    sync(room);
    return;
  }
  const lr = room.lastRound;
  const loser = room.players.find((p) => p.id === lr.loserPid);
  const starter = loser && loser.alive ? loser : nextPlayerAfter(room, lr.loserPid);
  newRound(room, starter.id);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function reject(room, p, msg) {
  send(p.ws, { t: 'event', kind: 'reject', msg });
  broadcast(room, { t: 'event', kind: 'rejectOther', pid: p.id, msg }, p.id);
}

function accept(room, p, display, entry, tier, unknown) {
  const r = room.round;
  const info = TIER_INFO[tier];
  r.used.add(entry ? entry.id : key(display));
  if (!entry) r.unknownKeys.push(key(display));
  const ans = { pid: p.id, text: display, tier, tierName: info.name, points: info.points, unknown: !!unknown };
  r.answers.push(ans);
  p.score += info.points;
  p.answerCount = (p.answerCount || 0) + 1;
  if (!p.best || TIERS.indexOf(tier) > TIERS.indexOf(p.best.tier)) p.best = { text: display, tier, tierName: info.name };
  event(room, { kind: 'accepted', answer: ans });
  const next = nextPlayerAfter(room, p.id) || p;
  beginTurn(room, next.id);
}

function handleAnswer(room, p, raw) {
  if (room.phase !== 'turn' || room.round.turnPid !== p.id) return;
  const r = room.round;
  const text = String(raw || '').trim().slice(0, 40);
  const cleaned = clean(text);
  if (!cleaned) return;
  const cat = r.cat;
  if (cat.letter && !cleaned.startsWith(cat.letter)) {
    return reject(room, p, `Måste börja på ${cat.letter.toUpperCase()}`);
  }
  const entry = findEntry(cat, text);
  if (entry) {
    if (r.used.has(entry.id)) return reject(room, p, `”${entry.display}” är redan taget!`);
    const tier = tierFor(cat, entry);
    recordStat(cat, entry);
    // Visa spelarens egen stavning om den är nära, annars ordlistans.
    const display = matchScore(key(text), entry.id) === 0 ? entry.display : entry.display;
    return accept(room, p, display, entry, tier, false);
  }
  const k = key(text);
  if (r.unknownKeys.some((u) => u === k || matchScore(k, u) !== null)) {
    return reject(room, p, `”${text}” är redan taget!`);
  }
  if (room.settings.strict) return reject(room, p, 'Finns inte i ordlistan');
  const voters = room.players.filter((q) => q.id !== p.id && q.connected);
  if (!voters.length) return reject(room, p, 'Finns inte i ordlistan');
  // Låt de andra rösta om det okända ordet.
  const remaining = Math.max(0, r.deadline - Date.now());
  room.phase = 'vote';
  r.vote = { pid: p.id, text: cleaned.charAt(0).toUpperCase() + cleaned.slice(1), votes: {}, deadline: Date.now() + 8000, remaining, voters: voters.map((v) => v.id) };
  sync(room);
  setTimer(room, 8000, () => resolveVote(room));
}

function handleVote(room, p, yes) {
  if (room.phase !== 'vote') return;
  const v = room.round.vote;
  if (!v.voters.includes(p.id)) return;
  v.votes[p.id] = !!yes;
  const stillConnected = v.voters.filter((id) => room.players.find((q) => q.id === id && q.connected));
  if (stillConnected.every((id) => id in v.votes)) resolveVote(room);
  else sync(room);
}

function resolveVote(room) {
  if (room.phase !== 'vote') return;
  const r = room.round;
  const v = r.vote;
  const p = room.players.find((q) => q.id === v.pid);
  const vals = Object.values(v.votes);
  const yes = vals.filter(Boolean).length;
  const no = vals.length - yes;
  if (!p) return beginTurn(room, nextPlayerAfter(room, v.pid).id);
  if (yes >= no) {
    const entry = addLearned(r.cat, v.text);
    (learned[r.cat.id] = learned[r.cat.id] || []).includes(v.text) || learned[r.cat.id].push(v.text);
    recordStat(r.cat, entry);
    r.used.add(entry.id);
    accept(room, p, v.text, entry, 'r', true);
  } else {
    send(p.ws, { t: 'event', kind: 'reject', msg: 'De andra underkände ordet' });
    broadcast(room, { t: 'event', kind: 'rejectOther', pid: p.id, msg: 'Underkänt' }, p.id);
    beginTurn(room, p.id, Math.max(v.remaining, 4000));
  }
}

// ---------- Anslutningar ----------
function joinRoom(ws, room, msg) {
  const token = String(msg.token || '').slice(0, 64);
  let p = room.players.find((q) => q.token === token);
  if (!p) {
    if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Rummet är fullt (max 8 spelare)' });
    const used = new Set(room.players.map((q) => q.color));
    p = {
      id: crypto.randomBytes(6).toString('hex'),
      token,
      name: '',
      avatar: '🐙',
      color: COLORS.find((c) => !used.has(c)) || COLORS[0],
      lives: 0, score: 0, alive: false,
      spectator: room.phase !== 'lobby' && room.phase !== 'gameOver',
      best: null, answerCount: 0,
    };
    room.players.push(p);
  }
  if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch {} }
  p.ws = ws;
  p.connected = true;
  p.name = String(msg.name || '').trim().slice(0, 16) || 'Spelare';
  if (AVATARS.includes(msg.avatar)) p.avatar = msg.avatar;
  clearTimeout(p.dropTimer);
  if (!room.hostId || !room.players.find((q) => q.id === room.hostId && q.connected)) room.hostId = p.id;
  room.emptySince = null;
  ws.room = room;
  ws.player = p;
  sync(room);
}

function leave(room, p, hard) {
  p.connected = false;
  p.ws = null;
  const removeNow = hard || room.phase === 'lobby' || room.phase === 'gameOver';
  const doRemove = () => {
    if (p.connected) return;
    if (room.phase === 'lobby' || room.phase === 'gameOver' || hard) {
      room.players = room.players.filter((q) => q !== p);
    } else {
      p.alive = false; // Lämnade mitt i spelet
      if (room.round && room.round.turnPid === p.id && room.phase === 'turn') {
        const nxt = nextPlayerAfter(room, p.id);
        if (nxt && nxt.id !== p.id) beginTurn(room, nxt.id);
      }
      maybeEnd(room);
    }
    fixHost(room);
    sync(room);
  };
  clearTimeout(p.dropTimer);
  if (removeNow && hard) doRemove();
  else p.dropTimer = setTimeout(doRemove, removeNow ? 15000 : 45000);
  fixHost(room);
  if (!room.players.some((q) => q.connected)) room.emptySince = Date.now();
  if (room.phase === 'vote') {
    const v = room.round.vote;
    const still = v.voters.filter((id) => room.players.find((q) => q.id === id && q.connected));
    if (still.every((id) => id in v.votes)) return resolveVote(room);
  }
  sync(room);
}

function maybeEnd(room) {
  if (['lobby', 'gameOver'].includes(room.phase)) return;
  const alive = alivePlayers(room);
  const startedWith = room.players.filter((p) => !p.spectator).length;
  if (alive.length === 0 || (startedWith > 1 && alive.length <= 1)) {
    clearTimeout(room.timer);
    room.phase = 'gameOver';
    room.winnerId = alive[0] ? alive[0].id : null;
    room.round = null;
  }
}

function fixHost(room) {
  const host = room.players.find((q) => q.id === room.hostId);
  if (!host || !host.connected) {
    const next = room.players.find((q) => q.connected);
    if (next) room.hostId = next.id;
  }
}

function sanitizeSettings(s, cur) {
  const out = { ...cur, packs: { ...cur.packs } };
  if ([8, 10, 15, 20, 30].includes(s.turnTime)) out.turnTime = s.turnTime;
  if (Number.isInteger(s.lives) && s.lives >= 1 && s.lives <= 5) out.lives = s.lives;
  if (typeof s.strict === 'boolean') out.strict = s.strict;
  if (typeof s.speedup === 'boolean') out.speedup = s.speedup;
  if (s.packs) for (const k of Object.keys(out.packs)) if (typeof s.packs[k] === 'boolean') out.packs[k] = s.packs[k];
  if (!Object.values(out.packs).some(Boolean)) out.packs.teman = true;
  return out;
}

function onMessage(ws, msg) {
  const room = ws.room;
  const p = ws.player;
  switch (msg.t) {
    case 'create': {
      const r = createRoom();
      return joinRoom(ws, r, msg);
    }
    case 'join': {
      const r = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!r) return send(ws, { t: 'error', msg: 'Hittade inget rum med den koden', code: 'noroom' });
      return joinRoom(ws, r, msg);
    }
  }
  if (!room || !p) return;
  const isHost = room.hostId === p.id;
  switch (msg.t) {
    case 'settings':
      if (isHost && room.phase === 'lobby') { room.settings = sanitizeSettings(msg.settings || {}, room.settings); sync(room); }
      break;
    case 'profile':
      p.name = String(msg.name || '').trim().slice(0, 16) || p.name;
      if (AVATARS.includes(msg.avatar)) p.avatar = msg.avatar;
      sync(room);
      break;
    case 'start':
      if (isHost && (room.phase === 'lobby' || room.phase === 'gameOver') && room.players.some((q) => q.connected)) startGame(room);
      break;
    case 'lobby':
      if (isHost && room.phase === 'gameOver') {
        room.phase = 'lobby';
        for (const q of room.players) q.spectator = false;
        sync(room);
      }
      break;
    case 'answer':
      handleAnswer(room, p, msg.text);
      break;
    case 'typing':
      if (room.phase === 'turn' && room.round.turnPid === p.id) {
        broadcast(room, { t: 'typing', pid: p.id, text: String(msg.text || '').slice(0, 40) }, p.id);
      }
      break;
    case 'vote':
      handleVote(room, p, msg.yes);
      break;
    case 'kick': {
      const target = room.players.find((q) => q.id === msg.id);
      if (isHost && target && target !== p && room.phase === 'lobby') {
        send(target.ws, { t: 'kicked' });
        room.players = room.players.filter((q) => q !== target);
        sync(room);
      }
      break;
    }
    case 'leave':
      ws.room = null; ws.player = null;
      leave(room, p, true);
      break;
    case 'react':
      if (typeof msg.emoji === 'string' && ['👏', '😂', '😮', '🔥', '💀', '🤯'].includes(msg.emoji)) {
        broadcast(room, { t: 'react', pid: p.id, emoji: msg.emoji });
      }
      break;
  }
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // Okända sökvägar (t.ex. /ABCD) visar spelet.
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': TYPES['.html'] });
        res.end(d2);
      });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg === 'object') {
      try { onMessage(ws, msg); } catch (e) { console.error(e); }
    }
  });
  ws.on('close', () => {
    if (ws.room && ws.player && ws.player.ws === ws) leave(ws.room, ws.player, false);
  });
});

// Håll anslutningar vid liv och städa bort tomma rum.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > 10 * 60 * 1000) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 25000);

server.listen(PORT, () => {
  console.log(`Unikum kör på http://localhost:${PORT} (${CATEGORIES.length} kategorier)`);
});

module.exports = { server, rooms };
