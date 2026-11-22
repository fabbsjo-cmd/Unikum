(() => {
  'use strict';
  const AVATARS = ['🐙', '🦊', '🐸', '🐼', '🦄', '🐯', '🐨', '🐵', '🐧', '🦉', '🐢', '🦀', '🐝', '🦖', '🐳', '🦔'];
  const TIER_NAMES = { c: 'Vanlig', u: 'Ovanlig', r: 'Sällsynt', l: 'Legendarisk' };
  const PACKS = [['teman', 'Teman'], ['lander', 'Länder'], ['djur', 'Djur'], ['orter', 'Svenska orter']];
  const REACTS = ['👏', '😂', '😮', '🔥', '💀', '🤯'];

  const store = {
    get(k, d) { try { const v = localStorage.getItem('unikum.' + k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('unikum.' + k, v); } catch {} },
  };
  let token = store.get('token');
  if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('token', token); }

  const app = document.getElementById('app');
  const toasts = document.getElementById('toasts');

  let ws = null;
  let state = null;
  let me = null;
  let offset = 0; // serverns klocka minus vår
  let roomCode = null;
  let typingText = '';
  let lastTypingPid = null;
  let muted = store.get('muted') === '1';
  let profile = { name: store.get('name', ''), avatar: store.get('avatar', AVATARS[Math.floor(Math.random() * 8)]) };
  let reconnectDelay = 500;
  let renderedKey = '';
  let lastAnswerCount = 0;
  let lastTickSec = null;

  const urlCode = (new URLSearchParams(location.search).get('rum') || location.pathname.slice(1)).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  // ---------- Hjälpfunktioner ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const now = () => Date.now() + offset;
  const player = (id) => state && state.players.find((p) => p.id === id);
  const isHost = () => state && state.hostId === me;
  const av = (p, cls) => h('div', { class: 'av' + (cls ? ' ' + cls : ''), style: `background:${p.color}` }, p.avatar);

  function toast(msg, kind) {
    const t = h('div', { class: 'toast ' + (kind || '') }, msg);
    toasts.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ---------- Ljud ----------
  let actx = null;
  function beep(freq, dur, type, vol, when) {
    if (muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = actx.currentTime + (when || 0);
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(vol || 0.15, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g).connect(actx.destination);
      o.start(t0);
      o.stop(t0 + dur);
    } catch {}
  }
  const sfx = {
    accept(tier) {
      const notes = { c: [523], u: [523, 659], r: [523, 659, 784], l: [523, 659, 784, 1047] }[tier] || [523];
      notes.forEach((n, i) => beep(n, 0.18, 'triangle', 0.15, i * 0.08));
    },
    reject() { beep(180, 0.25, 'sawtooth', 0.08); },
    tick() { beep(880, 0.05, 'square', 0.04); },
    lose() { [392, 330, 262].forEach((n, i) => beep(n, 0.25, 'triangle', 0.15, i * 0.15)); },
    turn() { beep(660, 0.12, 'sine', 0.12); beep(990, 0.15, 'sine', 0.12, 0.1); },
    growl(v) {
      if (muted) return;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        const t0 = actx.currentTime, dur = 0.5 + v * 0.4;
        const o = actx.createOscillator(), lfo = actx.createOscillator(), lg = actx.createGain(), g = actx.createGain();
        o.type = 'sawtooth'; o.frequency.setValueAtTime(90, t0); o.frequency.linearRampToValueAtTime(60, t0 + dur);
        lfo.frequency.value = 28; lg.gain.value = 25; lfo.connect(lg).connect(o.frequency);
        g.gain.setValueAtTime(0.001, t0); g.gain.linearRampToValueAtTime(0.12 * v, t0 + 0.08); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        o.connect(g).connect(actx.destination); o.start(t0); lfo.start(t0); o.stop(t0 + dur); lfo.stop(t0 + dur);
      } catch {}
    },
    slash() { beep(1200, 0.08, 'sawtooth', 0.08); beep(900, 0.08, 'sawtooth', 0.08, 0.07); beep(700, 0.1, 'sawtooth', 0.08, 0.14); },
    chomp() { beep(140, 0.12, 'square', 0.12); beep(110, 0.15, 'square', 0.12, 0.12); },
    win() { [523, 659, 784, 1047, 784, 1047].forEach((n, i) => beep(n, 0.2, 'triangle', 0.14, i * 0.12)); },
  };

  // ---------- Nätverk ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      reconnectDelay = 500;
      if (roomCode) sendMsg({ t: 'join', code: roomCode, token, ...profile });
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      onMsg(m);
    };
    ws.onclose = () => {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      if (state) toast('Anslutningen bröts, försöker igen…', 'bad');
    };
  }
  function sendMsg(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  function onMsg(m) {
    switch (m.t) {
      case 'state': {
        const prev = state;
        state = m.state;
        me = m.you;
        offset = m.now - Date.now();
        if (roomCode !== state.code) {
          roomCode = state.code;
          history.replaceState(null, '', '/?rum=' + roomCode);
        }
        onStateChange(prev, state);
        render();
        break;
      }
      case 'error':
        toast(m.msg, 'bad');
        if (m.code === 'noroom') { roomCode = null; state = null; history.replaceState(null, '', '/'); render(); }
        break;
      case 'kicked':
        toast('Du togs bort från rummet', 'bad');
        roomCode = null; state = null; history.replaceState(null, '', '/'); render();
        break;
      case 'typing':
        typingText = m.text; lastTypingPid = m.pid;
        updateTyping();
        break;
      case 'event':
        onEvent(m);
        break;
      case 'react':
        showReact(m.pid, m.emoji);
        break;
    }
  }

  function onStateChange(prev, s) {
    const r = s.round;
    if (r && (!prev || !prev.round || prev.round.turnPid !== r.turnPid || prev.phase !== s.phase)) {
      typingText = ''; lastTypingPid = null;
      if (s.phase === 'turn' && r.turnPid === me && (!prev || prev.round?.turnPid !== me || prev.phase !== 'turn')) {
        sfx.turn();
        if (navigator.vibrate) navigator.vibrate(80);
      }
    }
    if (s.phase === 'gameOver' && prev && prev.phase !== 'gameOver') { sfx.win(); confetti(); }
  }

  function onEvent(m) {
    if (m.kind === 'reject') {
      toast(m.msg, 'bad');
      sfx.reject();
      const box = document.querySelector('.answerbox form');
      if (box) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
    } else if (m.kind === 'rejectOther') {
      seatBubble(m.pid, '✗ ' + m.msg, 'bad');
    } else if (m.kind === 'accepted') {
      sfx.accept(m.answer.tier);
      seatBubble(m.answer.pid, m.answer.text, 'ok ' + m.answer.tier, m.answer);
      if (m.answer.tier === 'l') toast(`🌟 Legendariskt! ”${m.answer.text}”`, 'good');
    } else if (m.kind === 'extraLife') {
      sfx.accept('l');
      seatFx(m.pid, 'cheer', '❤️+1');
      if (m.pid === me) toast('❤️ Du fick ett extraliv!', 'good');
    } else if (m.kind === 'gotPass') {
      sfx.accept('r');
      seatFx(m.pid, 'cheer', '🎯');
      if (m.pid === me) toast('🎯 Du kan skicka turen vidare när det är din tur!', 'good');
    } else if (m.kind === 'rewardReady') {
      sfx.win();
      toast(`🎁 ${m.score} poäng! Välj en belöning`, 'good');
    } else if (m.kind === 'passed') {
      const f = player(m.from), t = player(m.to);
      sfx.slash();
      flyBetween(m.from, m.to, '🎯');
      toast(`${m.from === me ? 'Du' : f?.name} skickade turen till ${m.to === me ? 'dig' : t?.name}!`);
    } else if (m.kind === 'lifeLost') {
      sfx.lose();
      if (table && table.tiger) { tigerAttack(m.pid); setTimeout(() => bigHeart(m.pid), 1500); }
      else { seatFx(m.pid, 'hit', '💔'); bigHeart(m.pid); }
      if (m.pid === me && navigator.vibrate) navigator.vibrate([100, 60, 100]);
    }
  }

  // ---------- Vyer ----------
  function render() {
    if (!state) return renderHome();
    const key = state.phase === 'lobby' ? 'lobby' : state.phase === 'gameOver' ? 'over' : 'game';
    if (key === 'lobby') return renderLobby();
    if (key === 'over') return renderOver();
    return renderGame();
  }

  function renderHome() {
    renderedKey = 'home'; table = null;
    const nameInput = h('input', { class: 'input', id: 'name', maxlength: 16, placeholder: 'Ditt namn', value: profile.name, autocomplete: 'nickname' });
    const codeInput = h('input', { class: 'input code-input', id: 'code', maxlength: 4, placeholder: 'KOD', value: urlCode || '', autocomplete: 'off', autocapitalize: 'characters' });
    const avatars = h('div', { class: 'avatars' }, AVATARS.map((a) => h('button', {
      class: a === profile.avatar ? 'sel' : '', type: 'button', 'aria-label': 'Välj ' + a,
      onclick: (e) => { profile.avatar = a; store.set('avatar', a); avatars.querySelectorAll('button').forEach((b) => b.classList.remove('sel')); e.currentTarget.classList.add('sel'); },
    }, a)));
    const saveName = () => { profile.name = nameInput.value.trim(); store.set('name', profile.name); };
    const go = (create) => {
      saveName();
      if (!profile.name) { nameInput.focus(); return toast('Skriv ditt namn först', 'bad'); }
      if (!ws || ws.readyState !== 1) return toast('Ansluter… försök igen om en sekund');
      if (create) sendMsg({ t: 'create', token, ...profile });
      else {
        const code = codeInput.value.trim().toUpperCase();
        if (code.length !== 4) { codeInput.focus(); return toast('Koden har fyra bokstäver', 'bad'); }
        roomCode = code;
        sendMsg({ t: 'join', code, token, ...profile });
      }
    };
    const joining = urlCode && urlCode.length === 4;
    app.replaceChildren(
      h('div', { class: 'blobs' }, '🐙', '🦊', '🐸', '🦄', '🐳'),
      h('h1', { class: 'logo' }, 'Unikum'),
      h('p', { class: 'tagline' }, 'Kom på ordet ingen annan tänker på'),
      h('div', { class: 'card stack' },
        h('div', null, h('p', { class: 'label' }, 'Vem är du?'), nameInput),
        avatars,
        joining
          ? h('div', { class: 'stack' },
            h('button', { class: 'btn block', onclick: () => go(false) }, `Gå med i rum ${urlCode}`),
            h('div', { class: 'divider' }, 'eller'),
            h('button', { class: 'btn secondary block', onclick: () => go(true) }, 'Skapa ett nytt rum'))
          : h('div', { class: 'stack' },
            h('button', { class: 'btn block', onclick: () => go(true) }, 'Skapa rum'),
            h('div', { class: 'divider' }, 'eller gå med'),
            h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); go(false); } },
              h('div', { class: 'grow' }, codeInput),
              h('button', { class: 'btn secondary', type: 'submit' }, 'Gå med'))),
      ),
      h('div', { class: 'card', style: 'margin-top:14px' }, rulesList()),
    );
    nameInput.addEventListener('change', saveName);
  }

  function rulesList() {
    return h('div', null,
      h('p', { class: 'label' }, 'Så spelar ni'),
      h('ol', { class: 'rules' },
        h('li', null, 'Alla får samma ', h('b', null, 'kategori'), ', till exempel ”Länder på S”.'),
        h('li', null, 'Ni svarar ', h('b', null, 'i tur och ordning'), ' innan tiden tar slut.'),
        h('li', null, 'Ett ord som redan sagts ', h('b', null, 'går inte att ta igen'), '.'),
        h('li', null, 'Ju ', h('b', null, 'ovanligare'), ' ordet är, desto fler poäng.'),
        h('li', null, 'Hinner du inte svara ', h('b', null, 'tappar du ett liv'), ' och en ny kategori kommer.'),
        h('li', null, 'Sist kvar vinner. Okända ord ', h('b', null, 'röstar'), ' de andra om.'),
        h('li', null, 'Når du en ', h('b', null, 'poänggräns'), ' får du ett extraliv, eller en powerup som skickar turen till valfri spelare.')));
  }

  function renderLobby() {
    renderedKey = 'lobby'; table = null;
    const s = state.settings;
    const host = isHost();
    const link = `${location.origin}/?rum=${state.code}`;
    const setS = (patch) => sendMsg({ t: 'settings', settings: { ...s, ...patch, packs: { ...s.packs, ...(patch.packs || {}) } } });
    const seg = (vals, cur, fmt, onpick) => h('div', { class: 'seg' }, vals.map((v) =>
      h('button', { class: v === cur ? 'sel' : '', disabled: !host, onclick: () => onpick(v) }, fmt(v))));
    const toggle = (label, on, onflip, hint) => h('div', { class: 'toggle' },
      h('div', null, label, hint ? h('div', { class: 'muted', style: 'font-size:13px' }, hint) : null),
      h('button', { class: 'switch' + (on ? ' on' : ''), disabled: !host, 'aria-label': label, 'aria-pressed': on ? 'true' : 'false', onclick: onflip }));
    const share = async () => {
      if (navigator.share) { try { await navigator.share({ title: 'Unikum', text: `Spela Unikum med mig! Kod: ${state.code}`, url: link }); return; } catch {} }
      try { await navigator.clipboard.writeText(link); toast('Länken är kopierad!', 'good'); } catch { toast(link); }
    };
    const connected = state.players.filter((p) => p.connected);
    app.replaceChildren(
      h('div', { class: 'topbar' },
        h('button', { class: 'btn small secondary', onclick: leaveRoom }, '← Lämna'),
        h('span', null, `${connected.length}/8 spelare`),
        soundBtn()),
      h('div', { class: 'card stack center' },
        h('p', { class: 'label' }, 'Rumskod'),
        h('div', { class: 'roomcode' }, state.code),
        h('button', { class: 'btn secondary block', onclick: share }, '📨 Bjud in vänner'),
        h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:14px' }, 'Vännerna öppnar länken eller skriver in koden på sin egen enhet.')),
      h('div', { class: 'card stack', style: 'margin-top:14px' },
        h('p', { class: 'label' }, 'Spelare'),
        h('div', { class: 'players' }, state.players.map((p) => h('div', { class: 'pl' + (p.connected ? '' : ' off') },
          p.id === state.hostId ? h('span', { class: 'crown', title: 'Värd' }, '👑') : null,
          av(p),
          h('div', { class: 'name' }, p.name, p.id === me ? h('span', { class: 'muted' }, ' (du)') : null),
          host && p.id !== me ? h('button', { class: 'kick', title: 'Ta bort', 'aria-label': 'Ta bort ' + p.name, onclick: () => sendMsg({ t: 'kick', id: p.id }) }, '✕') : null)))),
      h('div', { class: 'card settings', style: 'margin-top:14px' },
        h('p', { class: 'label', style: 'margin:0' }, host ? 'Inställningar' : 'Inställningar (värden bestämmer)'),
        h('div', null, h('div', { style: 'font-weight:700;margin-bottom:6px' }, 'Tid per tur'), seg([8, 10, 15, 20, 30], s.turnTime, (v) => v + ' s', (v) => setS({ turnTime: v }))),
        h('div', null, h('div', { style: 'font-weight:700;margin-bottom:6px' }, 'Liv'), seg([1, 2, 3, 4, 5], s.lives, (v) => '❤️'.repeat(1) + ' ' + v, (v) => setS({ lives: v }))),
        h('div', null, h('div', { style: 'font-weight:700;margin-bottom:6px' }, 'Kategorier'),
          h('div', { class: 'seg' }, PACKS.map(([k, label]) => h('button', { class: s.packs[k] ? 'sel' : '', disabled: !host, onclick: () => setS({ packs: { [k]: !s.packs[k] } }) }, label)))),
        toggle('Tempoökning', s.speedup, () => setS({ speedup: !s.speedup }), 'Tiden krymper med 2 s för varje varv'),
        toggle('Strikt läge', s.strict, () => setS({ strict: !s.strict }), 'Bara ord från ordlistan, ingen röstning'),
        h('div', null, h('div', { style: 'font-weight:700;margin-bottom:6px' }, 'Extraliv var'),
          seg([0, 300, 500, 700, 1000], s.lifeEvery, (v) => (v ? v + ' p' : 'Av'), (v) => setS({ lifeEvery: v }))),
        s.lifeEvery ? toggle('Powerup: Skicka turen', s.powerups, () => setS({ powerups: !s.powerups }), 'Vid poänggränsen väljer man extraliv eller att få skicka turen till valfri spelare') : null),
      h('div', { class: 'answerbox' },
        host
          ? h('button', { class: 'btn block', onclick: () => sendMsg({ t: 'start' }) }, connected.length > 1 ? 'Starta spelet!' : 'Starta (öva själv)')
          : h('div', { class: 'card center muted', style: 'font-weight:800' }, 'Väntar på att värden startar…')),
    );
  }

  function soundBtn() {
    return h('button', { class: 'iconbtn', 'aria-label': muted ? 'Slå på ljud' : 'Stäng av ljud', onclick: (e) => {
      muted = !muted; store.set('muted', muted ? '1' : '0'); e.currentTarget.textContent = muted ? '🔇' : '🔊';
    } }, muted ? '🔇' : '🔊');
  }

  function leaveRoom() {
    sendMsg({ t: 'leave' });
    state = null; roomCode = null;
    history.replaceState(null, '', '/');
    renderHome();
  }

  function hearts(p) {
    if (p.spectator) return '👀';
    const total = state.settings.lives;
    return '❤️'.repeat(p.lives) + '🖤'.repeat(Math.max(0, total - p.lives));
  }

  // ---------- Spelbordet ----------
  // Bordet byggs en gång per spelaruppsättning och uppdateras sedan bit för bit,
  // så att animationerna inte startar om vid varje uppdatering.
  let table = null; // { key, el, seats: Map(pid -> {el, angle}), pointer, ... }
  let pointerAngle = null;
  let shownAnswers = 0;
  let shownRound = null;
  let bottomKey = '';
  let wasMyTurn = false;
  let passMode = false;
  const isMyTurn = () => state && state.phase === 'turn' && state.round && state.round.turnPid === me;
  let overlayKey = '';

  function seatOrder() {
    const list = state.players.filter((p) => !p.spectator || p.id === me);
    const idx = list.findIndex((p) => p.id === me);
    return idx > 0 ? [...list.slice(idx), ...list.slice(0, idx)] : list;
  }

  function buildTable() {
    const order = seatOrder();
    const n = order.length;
    const seats = new Map();
    const ring = h('div', { class: 'tablewrap' });
    // Platserna ligger på en ellips runt ett bord som lutar bort från dig (3D)
    const RX = 41, RY = 33, CY = 50, TILT = 0.5; // TILT ≈ cos(bordets lutning)
    order.forEach((p, i) => {
      const angle = 90 + (i * 360) / n; // du sitter längst ner
      const rad = (angle * Math.PI) / 180;
      const x = 50 + RX * Math.cos(rad);
      const y = CY + RY * Math.sin(rad);
      const depth = (1 + Math.sin(rad)) / 2; // 0 = längst bort, 1 = närmast
      const sc = (0.78 + 0.27 * depth).toFixed(3);
      const below = Math.sin(rad) < -0.3; // bortre platser visar bubblan under sig
      const side = x < 30 ? ' left' : x > 70 ? ' right' : '';
      const bubble = h('div', { class: 'sbubble' + (below ? ' below' : '') + side });
      const el = h('div', { class: 'seat2' + (depth < 0.45 ? ' back' : ' front'), 'data-pid': p.id, style: `left:${x}%;top:${y}%;--sc:${sc};z-index:${depth < 0.45 ? 2 : 6}` },
        h('div', { class: 'spot' }),
        h('div', { class: 'blob', style: `--c:${p.color}` }, h('span', { class: 'face' }, p.avatar)),
        h('div', { class: 'tag' }, h('span', { class: 'nm' }), h('span', { class: 'hearts' })),
        h('div', { class: 'pts' }),
        h('div', { class: 'badge' }),
        bubble);
      el.addEventListener('click', () => {
        if (!passMode || !el.classList.contains('pickable')) return;
        passMode = false;
        sendMsg({ t: 'pass', target: p.id });
      });
      // Vinkeln i bordets eget plan, så att pilen på bordet pekar rätt
      const discAngle = (Math.atan2((Math.sin(rad) * RY * 0.92) / TILT, Math.cos(rad) * RX) * 180) / Math.PI;
      seats.set(p.id, { el, angle, discAngle, bubble, pos: (below ? ' below' : '') + side });
      ring.append(el);
    });
    const timerRing = svgRing();
    const pointer = h('div', { class: 'pointer' }, h('div', { class: 'arrow' }));
    const disc = h('div', { class: 'disc' }, h('div', { class: 'felt' }), timerRing.el, pointer);
    const tiger = buildTiger();
    const center = h('div', { class: 'tcenter' }, tiger, h('div', { class: 'csecs' }));
    const tbl = h('div', { class: 'table' },
      h('div', { class: 'floorshadow' }), h('div', { class: 'rim' }),
      h('div', { class: 'discwrap' }, disc), center);
    ring.prepend(h('div', { class: 'lamp' }), tbl);
    const banner = h('div', { class: 'catbanner' }, h('span', { class: 'cemoji' }), h('span', { class: 'cname' }));
    return { key: order.map((p) => p.id).join(','), el: ring, seats, pointer, center, timerRing, tiger, banner };
  }

  function svgRing() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'tring');
    const mk = (cls) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', 47); c.setAttribute('class', cls); svg.append(c); return c; };
    mk('bg');
    const fg = mk('fg');
    const len = 2 * Math.PI * 47;
    fg.style.strokeDasharray = len;
    return { el: svg, fg, len };
  }

  function renderGame() {
    const r = state.round;
    const myTurn = state.phase === 'turn' && r.turnPid === me;
    const order = seatOrder();
    const tkey = order.map((p) => p.id).join(',');
    if (renderedKey !== 'game' || !table || table.key !== tkey || !document.body.contains(table.el)) {
      renderedKey = 'game';
      table = buildTable();
      shownAnswers = 0; shownRound = null; bottomKey = ''; overlayKey = ''; pointerAngle = null;
      app.replaceChildren(
        h('div', { class: 'topbar' },
          h('button', { class: 'btn small secondary', onclick: () => { if (confirmLeave()) leaveRoom(); } }, '← Lämna'),
          h('span', { id: 'roundlbl' }),
          soundBtn()),
        table.banner,
        table.el,
        h('div', { class: 'turnline', id: 'turnline' }),
        h('div', { id: 'bottom' }),
        h('div', { class: 'feed', id: 'feed' }),
        h('div', { id: 'overlay' }));
    }
    const meP = player(me);
    document.getElementById('roundlbl').textContent = `Runda ${r.num}` + (meP && meP.spectator ? ' · Du tittar på' : '');

    // Kategori i mitten, vänds vid ny runda
    if (shownRound !== r.num) {
      shownRound = r.num;
      shownAnswers = 0;
      document.getElementById('feed').replaceChildren();
      const c = table.banner;
      c.querySelector('.cemoji').textContent = r.category.emoji;
      c.querySelector('.cname').textContent = r.category.name;
      c.classList.remove('flip'); void c.offsetWidth; c.classList.add('flip');
      for (const s of table.seats.values()) { s.bubble.className = s.bubble.className.replace(/ show.*$/, ''); }
    }

    // Platser
    const active = ['turn', 'vote'].includes(state.phase) ? r.turnPid : null;
    for (const [pid, s] of table.seats) {
      const p = player(pid);
      if (!p) continue;
      s.el.classList.toggle('turn', pid === active);
      s.el.classList.toggle('dead', !p.alive && !p.spectator);
      s.el.classList.toggle('off', !p.connected);
      s.el.classList.toggle('me', pid === me);
      s.el.querySelector('.nm').textContent = pid === me ? 'Du' : p.name;
      renderHearts(s, p);
      s.el.classList.toggle('pickable', passMode && myTurn && pid !== me && p.alive && p.connected);
      const badge = s.el.querySelector('.badge');
      const btxt = p.passes ? '🎯×' + p.passes : '';
      if (badge.textContent !== btxt) badge.textContent = btxt;
      const pts = s.el.querySelector('.pts');
      if (pts.textContent !== p.score + ' p') pts.textContent = p.score + ' p';
    }

    // Pilen i mitten pekar på den som har turen
    const seat = active && table.seats.get(active);
    table.pointer.classList.toggle('on', !!seat);
    if (seat) {
      let target = seat.discAngle;
      if (pointerAngle != null) {
        let d = ((target - pointerAngle) % 360 + 540) % 360 - 180;
        target = pointerAngle + d;
      }
      pointerAngle = target;
      table.pointer.style.transform = `translate(-50%, -50%) rotate(${target}deg)`;
      tigerLook(seat.angle);
    }

    // Raden under bordet
    const cur = player(r.turnPid);
    const tl = document.getElementById('turnline');
    tl.className = 'turnline' + (myTurn ? ' mine' : '');
    if (!myTurn) passMode = false;
    tl.textContent = state.phase === 'turn' ? (myTurn ? (passMode ? '🎯 Tryck på den som ska få turen' : '✨ Din tur! ✨') : `${cur ? cur.name : ''} tänker…`)
      : state.phase === 'vote' ? 'Röstning pågår…' : state.phase === 'countdown' ? 'Gör er redo!' : '';

    // Svarsfält: alla som är med kan skriva i förväg och skicka när det blir deras tur
    const canPlay = meP && meP.alive && !meP.spectator;
    const bkey = canPlay ? 'input' : 'reacts';
    if (bkey !== bottomKey) {
      bottomKey = bkey;
      const bottom = document.getElementById('bottom');
      const reacts = h('div', { class: 'reacts' }, REACTS.map((e) => h('button', { onclick: () => sendMsg({ t: 'react', emoji: e }), 'aria-label': 'Reagera ' + e }, e)));
      if (canPlay) {
        const inp = h('input', { class: 'input', id: 'answer', maxlength: 40, placeholder: 'Skriv ditt svar…', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'send' });
        let lastSent = 0;
        inp.addEventListener('input', () => {
          if (!isMyTurn()) return;
          const t = Date.now();
          if (t - lastSent > 120) { lastSent = t; sendMsg({ t: 'typing', text: inp.value }); }
          else setTimeout(() => sendMsg({ t: 'typing', text: inp.value }), 130);
        });
        const form = h('form', { onsubmit: (e) => {
          e.preventDefault();
          const v = inp.value.trim();
          if (!v) return;
          if (!isMyTurn()) {
            form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
            return toast('Vänta tills det är din tur – ordet ligger kvar');
          }
          sendMsg({ t: 'answer', text: v });
          inp.value = ''; // töm direkt, oavsett rätt eller fel
          sendMsg({ t: 'typing', text: '' });
          inp.focus();
        } }, h('div', { style: 'flex:1' }, inp), h('button', { class: 'btn', type: 'submit', id: 'sendbtn' }, 'Skicka'));
        bottom.replaceChildren(h('div', { class: 'answerbox' }, form), reacts);
        inp.focus({ preventScroll: true });
      } else {
        bottom.replaceChildren(reacts);
      }
    }
    const inp = document.getElementById('answer');
    if (inp) {
      const box = inp.closest('.answerbox');
      box.classList.toggle('waiting', !myTurn);
      box.classList.toggle('ready', myTurn);
      const btn = document.getElementById('sendbtn');
      btn.textContent = myTurn ? 'Skicka' : 'Vänta…';
      inp.placeholder = myTurn ? 'Skriv ditt svar…' : 'Förbered ditt svar…';
      if (myTurn && !wasMyTurn && inp.value) sendMsg({ t: 'typing', text: inp.value });
      if (myTurn && document.activeElement !== inp) inp.focus({ preventScroll: true });
    }
    wasMyTurn = myTurn;
    renderPowerbar(meP, myTurn);

    // Svarslistan: lägg bara till nya svar
    const feed = document.getElementById('feed');
    for (let i = shownAnswers; i < r.answers.length; i++) {
      const a = r.answers[i];
      const p = player(a.pid) || { color: '#666', avatar: '❔' };
      feed.prepend(h('div', { class: 'ans' }, av(p), h('div', { class: 'w' }, a.text, a.unknown ? h('span', { class: 'new' }, 'NYTT ORD') : null),
        h('span', { class: 'tier ' + a.tier }, a.tierName, h('span', { class: 'p' }, '+' + a.points))));
    }
    shownAnswers = r.answers.length;

    // Överlägg (nedräkning, röstning, rundslut)
    const okey = [state.phase, r.num, r.vote && JSON.stringify(r.vote.votes)].join('|');
    if (okey !== overlayKey) {
      overlayKey = okey;
      const ov = overlayFor();
      document.getElementById('overlay').replaceChildren(...(ov ? [ov] : []));
    }
    updateTyping();
    tickTimer();
  }

  function renderPowerbar(meP, myTurn) {
    let bar = document.getElementById('powerbar');
    if (!bar) {
      bar = h('div', { id: 'powerbar' });
      const bottom = document.getElementById('bottom');
      bottom.parentNode.insertBefore(bar, bottom);
    }
    const rewards = meP && meP.alive ? meP.rewards || 0 : 0;
    const passes = meP && meP.alive ? meP.passes || 0 : 0;
    const key = [rewards, passes, myTurn, passMode].join('|');
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    const kids = [];
    if (rewards) {
      kids.push(h('div', { class: 'reward card' },
        h('div', { class: 'rtitle' }, `🎁 Poänggräns nådd!${rewards > 1 ? ` (${rewards})` : ''} Välj din belöning:`),
        h('div', { class: 'row' },
          h('button', { class: 'btn block', onclick: () => sendMsg({ t: 'reward', choice: 'life' }) }, '❤️ Extraliv'),
          h('button', { class: 'btn secondary block', onclick: () => sendMsg({ t: 'reward', choice: 'pass' }) }, '🎯 Skicka turen'))));
    }
    if (passes && myTurn) {
      kids.push(h('button', { class: 'btn passbtn block' + (passMode ? ' on' : ''), onclick: () => { passMode = !passMode; renderedKey = 'game'; render(); } },
        passMode ? 'Avbryt' : `🎯 Skicka turen vidare (${passes} kvar)`));
    }
    bar.replaceChildren(...kids);
  }

  function renderHearts(s, p) {
    const el = s.el.querySelector('.hearts');
    if (p.spectator) { el.textContent = '👀'; s.lives = null; return; }
    const total = Math.max(state.settings.lives, p.lives);
    const lost = s.lives != null && p.lives < s.lives;
    const gained = s.lives != null && p.lives > s.lives;
    if (s.lives === p.lives && el.childElementCount === total) return;
    el.replaceChildren(...Array.from({ length: total }, (_, i) => {
      const alive = i < p.lives;
      const justLost = lost && i >= p.lives && i < s.lives;
      const justGot = gained && i >= s.lives && i < p.lives;
      return h('span', { class: 'heart' + (alive ? '' : ' gone') + (justLost ? ' breaking' : '') + (justGot ? ' gained' : '') }, alive ? '❤️' : justLost ? '💔' : '🖤');
    }));
    s.lives = p.lives;
  }

  // ---------- Tigern ----------
  // Egenritad tiger i SVG. Humöret styrs med data-mood: calm, alert, angry, furious.
  const TIGER_SVG = `
<svg viewBox="0 0 240 250" class="tiger-svg" aria-hidden="true">
  <defs>
    <radialGradient id="tgFur" cx="50%" cy="42%" r="62%">
      <stop offset="0" stop-color="#ffc977"/><stop offset=".45" stop-color="#f59a2f"/>
      <stop offset=".8" stop-color="#d96d18"/><stop offset="1" stop-color="#a5480b"/>
    </radialGradient>
    <radialGradient id="tgBody" cx="50%" cy="20%" r="80%">
      <stop offset="0" stop-color="#f7a03a"/><stop offset="1" stop-color="#a5480b"/>
    </radialGradient>
    <radialGradient id="tgWhite" cx="50%" cy="35%" r="70%">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eadfcf"/>
    </radialGradient>
    <radialGradient id="tgIris" cx="50%" cy="55%" r="60%">
      <stop offset="0" stop-color="#ffe680"/><stop offset=".55" stop-color="#f2ad1f"/><stop offset="1" stop-color="#a86204"/>
    </radialGradient>
    <linearGradient id="tgNose" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f0aaa3"/><stop offset="1" stop-color="#b8645d"/>
    </linearGradient>
    <clipPath id="tgEyeL"><path d="M76 112 Q92 96 112 108 Q96 122 76 112Z"/></clipPath>
    <clipPath id="tgEyeR"><path d="M164 112 Q148 96 128 108 Q144 122 164 112Z"/></clipPath>
  </defs>

  <!-- Kropp och axlar -->
  <path d="M30 250 Q34 196 74 178 L166 178 Q206 196 210 250Z" fill="url(#tgBody)"/>
  <g fill="#2a160a" opacity=".85">
    <path d="M44 214 q18 -4 30 6 q-16 2 -30 -6z"/><path d="M196 214 q-18 -4 -30 6 q16 2 30 -6z"/>
    <path d="M50 236 q16 -2 24 6 q-14 0 -24 -6z"/><path d="M190 236 q-16 -2 -24 6 q14 0 24 -6z"/>
  </g>
  <path d="M96 182 Q120 232 144 182Z" fill="url(#tgWhite)"/>

  <!-- Öron -->
  <g class="ears">
    <path d="M44 86 Q34 36 74 34 Q96 40 98 62Z" fill="#2a160a"/>
    <path d="M50 82 Q44 44 74 42 Q90 48 92 64Z" fill="url(#tgFur)"/>
    <path d="M58 74 Q56 52 74 52 Q84 58 84 66Z" fill="#fff4e6"/>
    <path d="M196 86 Q206 36 166 34 Q144 40 142 62Z" fill="#2a160a"/>
    <path d="M190 82 Q196 44 166 42 Q150 48 148 64Z" fill="url(#tgFur)"/>
    <path d="M182 74 Q184 52 166 52 Q156 58 156 66Z" fill="#fff4e6"/>
    <circle cx="70" cy="44" r="5" fill="#fff4e6"/><circle cx="170" cy="44" r="5" fill="#fff4e6"/>
  </g>

  <!-- Huvud med kindpäls -->
  <path class="fur head" fill="url(#tgFur)" d="M120 46 Q170 46 196 80 Q214 104 214 128
      L228 136 L212 144 L226 156 L206 160 L214 174 L192 172 Q172 204 120 208
      Q68 204 48 172 L26 174 L34 160 L14 156 L28 144 L12 136 L26 128
      Q26 104 44 80 Q70 46 120 46Z"/>

  <!-- Ränder -->
  <g fill="#2a160a">
    <path d="M120 50 q-7 14 0 30 q7 -16 0 -30z"/>
    <path d="M100 54 q-6 12 2 24 q2 -12 -2 -24z"/><path d="M140 54 q6 12 -2 24 q-2 -12 2 -24z"/>
    <path d="M84 62 q-2 10 6 18 q-1 -10 -6 -18z"/><path d="M156 62 q2 10 -6 18 q1 -10 6 -18z"/>
    <path d="M104 84 q8 2 16 -2 q-8 8 -16 2z"/><path d="M136 84 q-8 2 -16 -2 q8 8 16 2z"/>
    <path d="M30 116 q22 -2 36 10 q-20 0 -36 -10z"/><path d="M26 136 q22 0 38 8 q-22 4 -38 -8z"/>
    <path d="M36 156 q18 0 30 6 q-18 4 -30 -6z"/>
    <path d="M210 116 q-22 -2 -36 10 q20 0 36 -10z"/><path d="M214 136 q-22 0 -38 8 q22 4 38 -8z"/>
    <path d="M204 156 q-18 0 -30 6 q18 4 30 -6z"/>
    <path d="M56 92 q10 4 14 14 q-12 -4 -14 -14z"/><path d="M184 92 q-10 4 -14 14 q12 -4 14 -14z"/>
  </g>

  <!-- Vita fläckar ovanför ögonen -->
  <ellipse cx="92" cy="94" rx="17" ry="8" fill="url(#tgWhite)"/>
  <ellipse cx="148" cy="94" rx="17" ry="8" fill="url(#tgWhite)"/>

  <!-- Nosrygg -->
  <path d="M108 100 Q120 96 132 100 L128 134 L112 134Z" fill="#ffbf6a" opacity=".55"/>

  <!-- Ögon -->
  <g class="eyes">
    <path d="M76 112 Q92 96 112 108 Q96 122 76 112Z" class="iris" fill="url(#tgIris)"/>
    <path d="M164 112 Q148 96 128 108 Q144 122 164 112Z" class="iris" fill="url(#tgIris)"/>
    <g clip-path="url(#tgEyeL)"><g class="pupil"><circle cx="94" cy="110" r="5.5" fill="#120a04"/><circle cx="96.5" cy="107.5" r="2" fill="#fff"/></g></g>
    <g clip-path="url(#tgEyeR)"><g class="pupil"><circle cx="146" cy="110" r="5.5" fill="#120a04"/><circle cx="148.5" cy="107.5" r="2" fill="#fff"/></g></g>
    <g clip-path="url(#tgEyeL)"><rect class="lid" x="74" y="96" width="40" height="28" fill="#e98a2c"/></g>
    <g clip-path="url(#tgEyeR)"><rect class="lid" x="126" y="96" width="40" height="28" fill="#e98a2c"/></g>
    <path d="M74 112 Q92 94 114 108 M112 108 Q96 123 76 113 M112 108 L116 126" fill="none" stroke="#1a0d05" stroke-width="3" stroke-linecap="round"/>
    <path d="M166 112 Q148 94 126 108 M128 108 Q144 123 164 113 M128 108 L124 126" fill="none" stroke="#1a0d05" stroke-width="3" stroke-linecap="round"/>
  </g>
  <path class="brow brow-l" d="M76 90 q16 -8 34 -2"/>
  <path class="brow brow-r" d="M164 90 q-16 -8 -34 -2"/>

  <!-- Nosparti -->
  <ellipse cx="100" cy="156" rx="26" ry="20" fill="url(#tgWhite)"/>
  <ellipse cx="140" cy="156" rx="26" ry="20" fill="url(#tgWhite)"/>
  <ellipse cx="120" cy="184" rx="20" ry="14" fill="url(#tgWhite)"/>
  <g fill="#3a2414" opacity=".6">
    <circle cx="90" cy="150" r="1.8"/><circle cx="98" cy="146" r="1.8"/><circle cx="88" cy="160" r="1.8"/><circle cx="97" cy="156" r="1.8"/>
    <circle cx="150" cy="150" r="1.8"/><circle cx="142" cy="146" r="1.8"/><circle cx="152" cy="160" r="1.8"/><circle cx="143" cy="156" r="1.8"/>
  </g>
  <path d="M102 132 Q120 124 138 132 Q134 148 120 152 Q106 148 102 132Z" fill="url(#tgNose)"/>
  <path d="M108 140 q5 3 8 0 M124 140 q3 3 8 0" fill="none" stroke="#5a2a24" stroke-width="2.5" stroke-linecap="round"/>
  <g class="mouth-closed"><path d="M120 152 v8 M120 160 q-10 10 -22 4 M120 160 q10 10 22 4"/></g>
  <g class="mouth-open">
    <path d="M94 160 Q120 154 146 160 Q142 196 120 198 Q98 196 94 160Z" fill="#4a0a14"/>
    <path d="M99 161 l5 17 l5 -16z M141 161 l-5 17 l-5 -16z" fill="#fffaf0"/>
    <path d="M104 194 l3 -9 l4 9z M136 194 l-3 -9 l-4 9z" fill="#fffaf0"/>
    <path d="M108 188 Q120 180 132 188 Q126 196 120 196 Q114 196 108 188Z" fill="#d9536b"/>
  </g>
  <g class="whiskers">
    <path d="M78 156 Q46 146 14 150 M78 162 Q46 162 16 170 M80 168 Q52 176 26 190"/>
    <path d="M162 156 Q194 146 226 150 M162 162 Q194 162 224 170 M160 168 Q188 176 214 190"/>
  </g>

  <!-- Framtassar på bordet -->
  <g class="paws">
    <ellipse cx="82" cy="232" rx="30" ry="15" fill="url(#tgFur)"/>
    <ellipse cx="158" cy="232" rx="30" ry="15" fill="url(#tgFur)"/>
    <path d="M70 236 v8 M82 237 v9 M94 236 v8 M146 236 v8 M158 237 v9 M170 236 v8" stroke="#6b3410" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M64 224 q8 -4 14 2 M150 224 q8 -4 14 2" fill="none" stroke="#2a160a" stroke-width="4" stroke-linecap="round"/>
  </g>
</svg>`;

  function buildTiger() {
    const el = h('div', { class: 'tiger', 'data-mood': 'calm' });
    el.innerHTML = TIGER_SVG; // statisk egen grafik
    el.append(h('div', { class: 'tiger-steam' }, h('i'), h('i')));
    return el;
  }

  const MOOD_ORDER = ['calm', 'alert', 'angry', 'furious'];
  function setTigerMood(mood) {
    const t = table && table.tiger;
    if (!t || t.dataset.mood === mood || t.classList.contains('attacking')) return;
    const up = MOOD_ORDER.indexOf(mood) > MOOD_ORDER.indexOf(t.dataset.mood);
    t.dataset.mood = mood;
    if (up && mood === 'angry') sfx.growl(0.6);
    if (up && mood === 'furious') sfx.growl(1);
  }

  // Tigern tittar mot den som har turen
  function tigerLook(angle) {
    const t = table && table.tiger;
    if (!t) return;
    const rad = (angle * Math.PI) / 180;
    const dx = (Math.cos(rad) * 4).toFixed(1), dy = (Math.sin(rad) * 2.5).toFixed(1);
    t.querySelectorAll('.pupil').forEach((p) => p.setAttribute('transform', `translate(${dx} ${dy})`));
  }

  // Tigern hoppar på spelaren, river och tar ett hjärta
  function tigerAttack(pid) {
    const s = table && table.seats.get(pid);
    const t = table && table.tiger;
    if (!s || !t || !t.animate) return;
    const tr = t.getBoundingClientRect();
    const sr = s.el.querySelector('.blob').getBoundingClientRect();
    const dx = (sr.left + sr.width / 2) - (tr.left + tr.width / 2);
    const dy = (sr.top + sr.height / 2) - (tr.top + tr.height / 2);
    t.classList.add('attacking');
    t.dataset.mood = 'furious';
    sfx.growl(1.2);
    const jump = t.animate([
      { transform: 'translate(0,0) scale(1)' },
      { transform: `translate(${-dx * 0.12}px, ${-dy * 0.12}px) scale(0.9)`, offset: 0.18 },
      { transform: `translate(${dx * 0.72}px, ${dy * 0.72}px) scale(1.35) rotate(${dx > 0 ? 10 : -10}deg)`, offset: 0.42 },
      { transform: `translate(${dx * 0.66}px, ${dy * 0.66}px) scale(1.3)`, offset: 0.62 },
      { transform: 'translate(0,0) scale(1)' },
    ], { duration: 1700, easing: 'cubic-bezier(.3,.7,.4,1)' });
    // Klösmärken över spelaren
    setTimeout(() => {
      const claw = h('div', { class: 'claw' }, h('i'), h('i'), h('i'));
      s.el.append(claw);
      setTimeout(() => claw.remove(), 900);
      sfx.slash();
      seatFx(pid, 'hit');
    }, 650);
    // Hjärtat flyger från spelaren till tigern
    setTimeout(() => {
      const wrap = table.el.getBoundingClientRect();
      const from = s.el.querySelector('.hearts').getBoundingClientRect();
      const heart = h('div', { class: 'stolen-heart' }, '❤️');
      heart.style.left = (from.left + from.width / 2 - wrap.left) + 'px';
      heart.style.top = (from.top - wrap.top) + 'px';
      table.el.append(heart);
      const tx = tr.left + tr.width / 2 - wrap.left - (from.left + from.width / 2 - wrap.left);
      const ty = tr.top + tr.height * 0.75 - wrap.top - (from.top - wrap.top);
      heart.animate([
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${tx * 0.5}px), calc(-50% + ${ty * 0.5 - 40}px)) scale(2)`, opacity: 1, offset: 0.5 },
        { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0.6)`, opacity: 0.9 },
      ], { duration: 900, easing: 'ease-in-out', fill: 'forwards' });
      setTimeout(() => { heart.remove(); t.classList.add('chomp'); sfx.chomp(); }, 900);
    }, 900);
    jump.onfinish = () => {
      setTimeout(() => { t.classList.remove('attacking', 'chomp'); t.dataset.mood = 'calm'; }, 600);
    };
  }

  // Pratbubbla vid en spelares plats
  function seatBubble(pid, text, kind, answer) {
    const s = table && table.seats.get(pid);
    if (!s) return;
    const b = s.bubble;
    clearTimeout(s.hideT);
    b.replaceChildren(text, ...(answer ? [h('span', { class: 'btier' }, answer.tierName + ' +' + answer.points)] : []));
    b.className = 'sbubble' + s.pos + ' show ' + kind;
    void b.offsetWidth;
    if (answer) {
      const f = h('div', { class: 'floatpts ' + answer.tier }, '+' + answer.points);
      s.el.append(f);
      setTimeout(() => f.remove(), 1400);
      s.el.classList.remove('cheer'); void s.el.offsetWidth; s.el.classList.add('cheer');
    }
    s.hideT = setTimeout(() => { b.className = b.className.replace(/ show.*$/, ''); }, answer ? 1800 : 1400);
  }

  function flyBetween(fromPid, toPid, emoji) {
    const a = table && table.seats.get(fromPid), b = table && table.seats.get(toPid);
    if (!a || !b) return;
    const w = table.el.getBoundingClientRect();
    const ra = a.el.querySelector('.blob').getBoundingClientRect(), rb = b.el.querySelector('.blob').getBoundingClientRect();
    const x0 = ra.left + ra.width / 2 - w.left, y0 = ra.top + ra.height / 2 - w.top;
    const x1 = rb.left + rb.width / 2 - w.left, y1 = rb.top + rb.height / 2 - w.top;
    const el = h('div', { class: 'stolen-heart', style: `left:${x0}px;top:${y0}px;font-size:34px` }, emoji);
    table.el.append(el);
    el.animate([
      { transform: 'translate(-50%,-50%) scale(.5)' },
      { transform: `translate(calc(-50% + ${(x1 - x0) / 2}px), calc(-50% + ${(y1 - y0) / 2 - 60}px)) scale(1.6) rotate(180deg)`, offset: 0.5 },
      { transform: `translate(calc(-50% + ${x1 - x0}px), calc(-50% + ${y1 - y0}px)) scale(1) rotate(360deg)` },
    ], { duration: 800, easing: 'ease-in-out', fill: 'forwards' });
    setTimeout(() => { el.remove(); seatFx(toPid, 'hit'); }, 820);
  }

  function bigHeart(pid) {
    const p = player(pid);
    const el = h('div', { class: 'heartbreak' }, h('div', { class: 'hb' }, '💔'),
      h('div', { class: 'hbtext' }, pid === me ? 'Du tappade ett liv!' : `${p ? p.name : ''} tappade ett liv!`));
    document.body.append(el);
    setTimeout(() => el.remove(), 1500);
  }

  function seatFx(pid, cls, emoji) {
    const s = table && table.seats.get(pid);
    if (!s) return;
    s.el.classList.remove(cls); void s.el.offsetWidth; s.el.classList.add(cls);
    if (emoji) {
      const f = h('div', { class: 'floatpts big' }, emoji);
      s.el.append(f);
      setTimeout(() => f.remove(), 1500);
    }
  }

  let leaveArmed = 0;
  function confirmLeave() {
    if (Date.now() - leaveArmed < 3000) return true;
    leaveArmed = Date.now();
    toast('Tryck igen för att lämna spelet');
    return false;
  }

  function overlayFor() {
    const r = state.round;
    if (state.phase === 'countdown') {
      return h('div', { class: 'overlay' }, h('div', { class: 'modal' },
        h('p', { class: 'label' }, `Runda ${r.num} · Ny kategori`),
        h('div', { class: 'big spin' }, r.category.emoji),
        h('h2', null, r.category.name),
        h('div', { class: 'countnum', id: 'countdown' }, ''),
        h('p', { class: 'muted' }, `Först ut: ${player(r.turnPid)?.id === me ? 'du!' : player(r.turnPid)?.name || ''}`)));
    }
    if (state.phase === 'vote') {
      const v = r.vote;
      const p = player(v.pid);
      const mine = v.pid === me;
      const voted = me in v.votes;
      const n = Object.keys(v.votes).length;
      return h('div', { class: 'overlay' }, h('div', { class: 'modal' },
        h('p', { class: 'label' }, mine ? 'Ditt ord finns inte i ordlistan' : `${p ? p.name : ''} skrev ett okänt ord`),
        h('div', { class: 'voteword' }, `”${v.text}”`),
        h('p', { class: 'muted', style: 'margin:0' }, `Passar det i kategorin ”${r.category.name}”?`),
        mine || voted
          ? h('p', { style: 'font-weight:800;margin-top:16px' }, mine ? 'De andra röstar…' : 'Tack för din röst!', h('span', { class: 'muted' }, ` (${n} röster)`))
          : h('div', { class: 'vote-btns' },
            h('button', { class: 'btn', onclick: () => sendMsg({ t: 'vote', yes: true }) }, '👍 Godkänn'),
            h('button', { class: 'btn danger', onclick: () => sendMsg({ t: 'vote', yes: false }) }, '👎 Neka')),
        h('div', { class: 'timer', id: 'votetimer', style: 'margin-top:16px' }, h('div'))));
    }
    if (state.phase === 'roundEnd' && state.lastRound) {
      const lr = state.lastRound;
      const p = player(lr.loserPid);
      const you = lr.loserPid === me;
      return h('div', { class: 'overlay delayed' }, h('div', { class: 'modal' },
        h('div', { class: 'big' }, lr.out ? '💀' : '💔'),
        h('h2', null, you ? (lr.out ? 'Du är ute!' : 'Du tappade ett liv!') : `${p ? p.name : 'Någon'} ${lr.out ? 'är ute!' : 'tappade ett liv!'}`),
        h('p', { class: 'muted' }, `Ni hittade ${lr.found} av ${lr.total} möjliga i ”${lr.category}”.`),
        lr.missed.length ? h('div', null, h('p', { class: 'label', style: 'margin-top:14px' }, 'Vanliga svar ni missade'), h('div', { class: 'chips' }, lr.missed.map((w) => h('span', { class: 'chip' }, w)))) : null,
        lr.rare.length ? h('div', null, h('p', { class: 'label', style: 'margin-top:14px' }, 'Legendariska svar'), h('div', { class: 'chips' }, lr.rare.map((w) => h('span', { class: 'chip l' }, w)))) : null,
        h('p', { class: 'muted', style: 'margin-top:16px;font-size:14px' }, 'Nästa runda börjar strax…')));
    }
    return null;
  }

  // Visar vad den som har turen skriver, i en bubbla vid deras plats
  function updateTyping() {
    if (!table || !state || !state.round) return;
    const r = state.round;
    for (const [pid, s] of table.seats) {
      let t = s.el.querySelector('.typingb');
      const show = state.phase === 'turn' && pid === r.turnPid && pid !== me;
      if (!show) { if (t) t.remove(); continue; }
      if (!t) { t = h('div', { class: 'typingb' + s.pos }); s.el.append(t); }
      const txt = lastTypingPid === pid ? typingText : '';
      t.replaceChildren(txt ? txt : h('span', { class: 'dots' }, h('i'), h('i'), h('i')));
    }
  }

  function tickTimer() {
    if (!state || !state.round || !table) return;
    const r = state.round;
    const ring = table.timerRing;
    const secsEl = table.center.querySelector('.csecs');
    if (state.phase === 'turn' && r.deadline) {
      const left = Math.max(0, r.deadline - now());
      const frac = Math.min(1, left / (r.turnTime * 1000));
      ring.fg.style.strokeDashoffset = ring.len * (1 - frac);
      const cls = left < 3000 ? 'crit' : left < 6000 ? 'warn' : '';
      setTigerMood(frac > 0.6 ? 'calm' : frac > 0.35 ? 'alert' : frac > 0.15 ? 'angry' : 'furious');
      if (ring.el.dataset.c !== cls) { ring.el.dataset.c = cls; ring.el.setAttribute('class', 'tring ' + cls); }
      const s = Math.ceil(left / 1000);
      const txt = s + '';
      if (secsEl.textContent !== txt) { secsEl.textContent = txt; secsEl.className = 'csecs ' + cls; }
      if (s <= 3 && s > 0 && s !== lastTickSec && r.turnPid === me) sfx.tick();
      lastTickSec = s;
    } else if (state.phase !== 'vote') {
      if (state.phase !== 'roundEnd') setTigerMood('calm');
      ring.fg.style.strokeDashoffset = ring.len;
      if (secsEl.textContent) secsEl.textContent = '';
    }
    const vt = document.getElementById('votetimer');
    if (vt && r.vote) {
      const left = Math.max(0, r.vote.deadline - now());
      vt.firstChild.style.width = (left / 80).toFixed(1) + '%';
    }
    const cd = document.getElementById('countdown');
    if (cd && r.startsAt) cd.textContent = Math.max(1, Math.ceil((r.startsAt - now()) / 1000));
  }
  (function loop() { tickTimer(); requestAnimationFrame(loop); })();

  function showReact(pid, emoji) {
    const s = table && table.seats.get(pid);
    if (!s) return;
    const b = h('div', { class: 'reactpop' }, emoji);
    s.el.append(b);
    setTimeout(() => b.remove(), 1700);
  }

  function renderOver() {
    renderedKey = 'over'; table = null;
    const sorted = [...state.players].filter((p) => !p.spectator).sort((a, b) => (b.id === state.winnerId) - (a.id === state.winnerId) || b.score - a.score);
    const w = player(state.winnerId);
    const solo = sorted.length === 1;
    app.replaceChildren(
      h('div', { class: 'topbar' }, h('button', { class: 'btn small secondary', onclick: leaveRoom }, '← Lämna'), h('span', null, 'Spelet är slut'), soundBtn()),
      h('div', { class: 'modal', style: 'margin:0 auto' },
        h('div', { class: 'big' }, solo ? '🎯' : '🏆'),
        h('h2', null, solo ? `${sorted[0]?.score || 0} poäng!` : w ? (w.id === me ? 'Du vann!' : `${w.name} vann!`) : 'Spelet är slut'),
        h('p', { class: 'muted' }, solo ? 'Bra jobbat! Kan du slå det?' : 'Sist kvar med liv. Så här gick det:'),
        h('div', { class: 'podium' }, sorted.map((p, i) => h('div', { class: 'pl' },
          h('div', { class: 'rank' }, i === 0 && !solo ? '👑' : i + 1), av(p),
          h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, p.name),
            h('div', { class: 'bestw' }, p.best ? `Bästa ord: ${p.best.text} (${p.best.tierName})` : 'Inga ord')),
          h('div', { class: 'score' }, p.score)))),
        h('div', { class: 'stack', style: 'margin-top:18px' },
          isHost() ? h('button', { class: 'btn block', onclick: () => sendMsg({ t: 'start' }) }, 'Spela igen') : h('p', { class: 'muted', style: 'font-weight:800' }, 'Väntar på värden…'),
          isHost() ? h('button', { class: 'btn secondary block', onclick: () => sendMsg({ t: 'lobby' }) }, 'Till lobbyn') : null)),
    );
  }

  function confetti() {
    const em = ['🎉', '⭐', '🎊', '✨', '🟡', '🟣'];
    for (let i = 0; i < 40; i++) {
      const c = h('div', { class: 'confetti', style: `left:${Math.random() * 100}vw;animation-duration:${2 + Math.random() * 2}s;animation-delay:${Math.random() * 0.8}s` }, em[i % em.length]);
      document.body.append(c);
      setTimeout(() => c.remove(), 5000);
    }
  }

  if (urlCode && urlCode.length === 4 && profile.name) roomCode = urlCode; // återanslut direkt
  render();
  connect();
})();
