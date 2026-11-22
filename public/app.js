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
        h('li', null, 'Sist kvar vinner. Okända ord ', h('b', null, 'röstar'), ' de andra om.')));
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
        toggle('Strikt läge', s.strict, () => setS({ strict: !s.strict }), 'Bara ord från ordlistan, ingen röstning')),
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
    const R = n <= 2 ? 38 : n <= 4 ? 40 : 41;
    order.forEach((p, i) => {
      const angle = 90 + (i * 360) / n; // du sitter längst ner
      const rad = (angle * Math.PI) / 180;
      const x = 50 + R * Math.cos(rad);
      const y = 50 + R * Math.sin(rad);
      const below = Math.sin(rad) < -0.3; // övre platser visar bubblan under sig
      const side = x < 30 ? ' left' : x > 70 ? ' right' : '';
      const bubble = h('div', { class: 'sbubble' + (below ? ' below' : '') + side });
      const el = h('div', { class: 'seat2', 'data-pid': p.id, style: `left:${x}%;top:${y}%` },
        h('div', { class: 'spot' }),
        h('div', { class: 'blob', style: `--c:${p.color}` }, h('span', { class: 'face' }, p.avatar)),
        h('div', { class: 'tag' }, h('span', { class: 'nm' }), h('span', { class: 'hearts' })),
        h('div', { class: 'pts' }),
        bubble);
      seats.set(p.id, { el, angle, bubble, pos: (below ? ' below' : '') + side });
      ring.append(el);
    });
    const timerRing = svgRing();
    const pointer = h('div', { class: 'pointer' }, h('div', { class: 'arrow' }));
    const tiger = buildTiger();
    const center = h('div', { class: 'tcenter' }, tiger, h('div', { class: 'csecs' }));
    const tbl = h('div', { class: 'table' }, timerRing.el, pointer, center);
    ring.prepend(tbl);
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
      const pts = s.el.querySelector('.pts');
      if (pts.textContent !== p.score + ' p') pts.textContent = p.score + ' p';
    }

    // Pilen i mitten pekar på den som har turen
    const seat = active && table.seats.get(active);
    table.pointer.classList.toggle('on', !!seat);
    if (seat) {
      let target = seat.angle;
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
    tl.textContent = state.phase === 'turn' ? (myTurn ? '✨ Din tur! ✨' : `${cur ? cur.name : ''} tänker…`)
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

  function renderHearts(s, p) {
    const el = s.el.querySelector('.hearts');
    if (p.spectator) { el.textContent = '👀'; s.lives = null; return; }
    const total = state.settings.lives;
    const lost = s.lives != null && p.lives < s.lives;
    if (s.lives === p.lives && el.childElementCount === total) return;
    el.replaceChildren(...Array.from({ length: total }, (_, i) => {
      const alive = i < p.lives;
      const justLost = lost && i >= p.lives && i < s.lives;
      return h('span', { class: 'heart' + (alive ? '' : ' gone') + (justLost ? ' breaking' : '') }, alive ? '❤️' : justLost ? '💔' : '🖤');
    }));
    s.lives = p.lives;
  }

  // ---------- Tigern ----------
  // Egenritad tiger i SVG. Humöret styrs med data-mood: calm, alert, angry, furious.
  const TIGER_SVG = `
<svg viewBox="0 0 200 200" class="tiger-svg" aria-hidden="true">
  <g class="ears">
    <circle cx="52" cy="52" r="26" class="fur"/><circle cx="52" cy="54" r="14" fill="#ffb3a7"/>
    <circle cx="148" cy="52" r="26" class="fur"/><circle cx="148" cy="54" r="14" fill="#ffb3a7"/>
  </g>
  <ellipse cx="100" cy="108" rx="78" ry="72" class="fur head"/>
  <g class="stripes" fill="#2b1a10">
    <path d="M100 38 q-6 14 0 26 q6 -12 0 -26z"/>
    <path d="M78 42 q-2 12 6 20 q0 -12 -6 -20z"/><path d="M122 42 q2 12 -6 20 q0 -12 6 -20z"/>
    <path d="M24 98 q16 2 26 10 q-14 2 -26 -10z"/><path d="M22 120 q16 0 26 6 q-14 4 -26 -6z"/>
    <path d="M176 98 q-16 2 -26 10 q14 2 26 -10z"/><path d="M178 120 q-16 0 -26 6 q14 4 26 -6z"/>
  </g>
  <ellipse cx="72" cy="142" rx="32" ry="26" fill="#fff6e8"/><ellipse cx="128" cy="142" rx="32" ry="26" fill="#fff6e8"/>
  <ellipse cx="100" cy="160" rx="22" ry="16" fill="#fff6e8"/>
  <g class="eyes">
    <g class="eye eye-l"><ellipse cx="72" cy="100" rx="15" ry="16" fill="#fff"/><g class="pupil"><circle cx="72" cy="101" r="8" class="iris"/><circle cx="75" cy="98" r="2.6" fill="#fff"/></g></g>
    <g class="eye eye-r"><ellipse cx="128" cy="100" rx="15" ry="16" fill="#fff"/><g class="pupil"><circle cx="128" cy="101" r="8" class="iris"/><circle cx="131" cy="98" r="2.6" fill="#fff"/></g></g>
    <path class="lid lid-l" d="M55 84 h34 v18 h-34z"/><path class="lid lid-r" d="M111 84 h34 v18 h-34z"/>
  </g>
  <path class="brow brow-l" d="M56 80 q16 -6 30 0" />
  <path class="brow brow-r" d="M114 80 q14 -6 30 0" />
  <path d="M90 128 h20 q0 10 -10 13 q-10 -3 -10 -13z" fill="#e8637a"/>
  <g class="mouth-closed"><path d="M100 141 v8 M100 149 q-10 9 -20 2 M100 149 q10 9 20 2" /></g>
  <g class="mouth-open">
    <path d="M78 150 q22 -6 44 0 q-4 26 -22 26 q-18 0 -22 -26z" fill="#5a0f1a"/>
    <path d="M80 151 l5 12 l5 -11z M120 151 l-5 12 l-5 -11z" fill="#fff"/>
    <path d="M90 170 q10 -6 20 0 q-4 6 -10 6 q-6 0 -10 -6z" fill="#e8637a"/>
  </g>
  <g class="whiskers"><path d="M58 146 l-36 -6 M58 154 l-34 4 M142 146 l36 -6 M142 154 l34 4"/></g>
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
    const dx = (Math.cos(rad) * 5).toFixed(1), dy = (Math.sin(rad) * 4).toFixed(1);
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
