// Snabbtest: tre spelare, svar, dubbletter, röstning och tidsgräns.
process.env.PORT = process.env.PORT || '3999';
process.env.DATA_DIR = require('os').tmpdir() + '/unikum-test-' + Date.now();
const assert = require('assert');
const WebSocket = require('ws');
const { server } = require('../server');
const { buildCategories, findEntry } = require('../lib/words');

const cats = buildCategories();
const URL = `ws://localhost:${process.env.PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, state: null, events: [], you: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'state') { c.state = m.state; c.you = m.you; }
    else c.events.push(m);
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.open = new Promise((r) => ws.on('open', r));
  return c;
}

async function until(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return; await sleep(20); }
  throw new Error('Timeout: ' + fn.toString());
}

function answerFor(state, exclude) {
  const cat = cats.find((c) => c.id === state.round.category.id);
  const used = new Set(state.round.answers.map((a) => findEntry(cat, a.text)?.id));
  const e = cat.entries.find((x) => !used.has(x.id) && !exclude?.includes(x.id));
  return e.keys[0] === e.display.toLowerCase() ? e.display : e.display;
}

(async () => {
  const a = client('Anna'), b = client('Bo'), c = client('Cia');
  await Promise.all([a.open, b.open, c.open]);
  a.send({ t: 'create', token: 'ta', name: 'Anna', avatar: '🦊' });
  await until(() => a.state);
  const code = a.state.code;
  assert.match(code, /^[A-Z]{4}$/);
  b.send({ t: 'join', code, token: 'tb', name: 'Bo' });
  c.send({ t: 'join', code: code.toLowerCase(), token: 'tc', name: 'Cia' });
  await until(() => a.state.players.length === 3);
  assert.equal(a.state.hostId, a.you);

  b.send({ t: 'settings', settings: { turnTime: 30 } }); // inte värd
  a.send({ t: 'settings', settings: { turnTime: 8, lives: 2 } });
  await until(() => b.state.settings.turnTime === 8);
  assert.equal(b.state.settings.lives, 2);

  a.send({ t: 'start' });
  await until(() => a.state.phase === 'countdown');
  await until(() => a.state.phase === 'turn', 5000);
  const byId = { [a.you]: a, [b.you]: b, [c.you]: c };

  // Tre korrekta svar i tur och ordning
  for (let i = 0; i < 3; i++) {
    const cur = byId[a.state.round.turnPid];
    const n = a.state.round.answers.length;
    cur.send({ t: 'answer', text: answerFor(a.state) });
    await until(() => a.state.round.answers.length === n + 1);
  }
  const order = a.state.round.answers.map((x) => x.pid);
  assert.equal(new Set(order).size, 3, 'alla tre ska ha svarat');

  // Dubblett ska avvisas
  const cur = byId[a.state.round.turnPid];
  cur.events = [];
  cur.send({ t: 'answer', text: a.state.round.answers[0].text });
  await until(() => cur.events.some((e) => e.kind === 'reject'));
  assert.match(cur.events.find((e) => e.kind === 'reject').msg, /redan taget/);

  // Okänt ord -> röstning (om inte bokstavskategori stoppar det)
  const letter = cats.find((x) => x.id === a.state.round.category.id).letter;
  const weird = (letter || 'q') + 'zzyxqbrop';
  cur.send({ t: 'answer', text: weird });
  await until(() => a.state.phase === 'vote');
  for (const x of [a, b, c]) if (x !== cur) x.send({ t: 'vote', yes: false });
  await until(() => a.state.phase === 'turn');
  assert.equal(a.state.round.turnPid, cur.you, 'nekat ord -> samma spelare fortsätter');

  // Låt tiden gå ut -> liv förloras
  const loser = a.state.round.turnPid;
  await until(() => a.state.phase === 'roundEnd', 12000);
  assert.equal(a.state.lastRound.loserPid, loser);
  assert.equal(a.state.players.find((p) => p.id === loser).lives, 1);
  await until(() => a.state.phase === 'countdown', 8000);
  assert.equal(a.state.round.turnPid, loser, 'förloraren börjar nästa runda');

  // Frånkoppling och återanslutning med samma token
  b.ws.close();
  await sleep(200);
  const b2 = client('Bo');
  await b2.open;
  b2.send({ t: 'join', code, token: 'tb', name: 'Bo' });
  await until(() => b2.state && b2.state.players.length === 3);
  assert.equal(b2.state.players.filter((p) => p.connected).length, 3);

  console.log('✔ Alla tester gick igenom');
  for (const x of [a, b2, c]) x.ws.close();
  server.close();
  process.exit(0);
})().catch((e) => { console.error('✘', e); process.exit(1); });
