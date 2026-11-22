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
      const inp = document.getElementById('answer');
      if (inp) inp.select();
    } else if (m.kind === 'rejectOther') {
      const p = player(m.pid);
      if (p) toast(`${p.name}: ${m.msg}`);
    } else if (m.kind === 'accepted') {
      sfx.accept(m.answer.tier);
      if (m.answer.tier === 'l') toast(`🌟 Legendariskt! ”${m.answer.text}”`, 'good');
    } else if (m.kind === 'lifeLost') {
      sfx.lose();
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
    renderedKey = 'home';
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
    renderedKey = 'lobby';
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
        toggle('Tempoökning', s.speedup, () => setS({ speedup: !s.speedup }), 'Tiden krymper för varje varv'),
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

  // Spelvyn byggs om när fas/tur ändras; timer och skrivande uppdateras löpande.
  function renderGame() {
    const r = state.round;
    const myTurn = state.phase === 'turn' && r.turnPid === me;
    const key = ['game', state.phase, r.num, r.turnPid, r.answers.length, myTurn, JSON.stringify(state.players.map((p) => [p.lives, p.connected, p.alive, p.score])), r.vote && JSON.stringify(r.vote.votes)].join('|');
    if (key === renderedKey) return;
    renderedKey = key;
    const prevInput = document.getElementById('answer');
    const keepValue = prevInput && myTurn ? prevInput.value : '';
    const cur = player(r.turnPid);

    const seats = h('div', { class: 'ring' }, state.players.filter((p) => !p.spectator || p.connected).map((p) =>
      h('div', { class: 'seat' + (p.id === r.turnPid && ['turn', 'vote'].includes(state.phase) ? ' turn' : '') + (p.alive ? '' : ' dead') + (p.connected ? '' : ' off'), 'data-pid': p.id },
        av(p),
        h('div', { class: 'nm' }, p.id === me ? 'Du' : p.name),
        h('div', { class: 'hearts' }, hearts(p)),
        h('div', { class: 'pts' }, p.score + ' p'))));

    const feed = h('div', { class: 'feed' }, [...r.answers].reverse().map((a) => {
      const p = player(a.pid) || { color: '#666', avatar: '❔' };
      return h('div', { class: 'ans' }, av(p), h('div', { class: 'w' }, a.text, a.unknown ? h('span', { class: 'new' }, 'NYTT ORD') : null),
        h('span', { class: 'tier ' + a.tier }, a.tierName, h('span', { class: 'p' }, '+' + a.points)));
    }));

    let bottom;
    if (myTurn) {
      const inp = h('input', { class: 'input', id: 'answer', maxlength: 40, placeholder: 'Skriv ditt svar…', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'send', value: keepValue });
      let lastSent = 0;
      inp.addEventListener('input', () => {
        const t = Date.now();
        if (t - lastSent > 120) { lastSent = t; sendMsg({ t: 'typing', text: inp.value }); }
        else setTimeout(() => sendMsg({ t: 'typing', text: inp.value }), 130);
      });
      bottom = h('div', { class: 'answerbox' }, h('form', { onsubmit: (e) => { e.preventDefault(); if (inp.value.trim()) sendMsg({ t: 'answer', text: inp.value }); } },
        h('div', { class: 'grow', style: 'flex:1' }, inp), h('button', { class: 'btn', type: 'submit' }, 'Skicka')));
    } else {
      bottom = h('div', { class: 'reacts' }, REACTS.map((e) => h('button', { onclick: () => sendMsg({ t: 'react', emoji: e }), 'aria-label': 'Reagera ' + e }, e)));
    }

    const meP = player(me);
    const turnLine = h('div', { class: 'turnline', id: 'turnline' });
    if (state.phase === 'turn' || state.phase === 'vote') {
      turnLine.append(myTurn ? 'Din tur!' : state.phase === 'vote' ? `Röstning om ${cur ? cur.name : ''}s ord…` : `${cur ? cur.name : ''}s tur`, h('span', { class: 'secs', id: 'secs' }));
    }

    app.replaceChildren(
      h('div', { class: 'topbar' },
        h('button', { class: 'btn small secondary', onclick: () => { if (confirmLeave()) leaveRoom(); } }, '← Lämna'),
        h('span', null, `Runda ${r.num}`, meP && meP.spectator ? ' · Du tittar på' : ''),
        soundBtn()),
      h('div', { class: 'category' },
        h('div', { class: 'emoji' }, r.category.emoji),
        h('h2', null, r.category.name),
        h('div', { class: 'sub' }, `${r.answers.length} svar hittills`)),
      seats,
      h('div', { class: 'timer', id: 'timer' }, h('div')),
      turnLine,
      h('div', { class: 'typing', id: 'typing' }),
      bottom,
      feed,
      ...[overlayFor()].filter(Boolean),
    );
    updateTyping();
    tickTimer();
    const inp = document.getElementById('answer');
    if (inp && !inp.matches(':focus')) { inp.focus({ preventScroll: true }); }
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
        h('div', { class: 'big' }, r.category.emoji),
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
      return h('div', { class: 'overlay' }, h('div', { class: 'modal' },
        h('div', { class: 'big' }, lr.out ? '💀' : '💔'),
        h('h2', null, you ? (lr.out ? 'Du är ute!' : 'Du tappade ett liv!') : `${p ? p.name : 'Någon'} ${lr.out ? 'är ute!' : 'tappade ett liv!'}`),
        h('p', { class: 'muted' }, `Ni hittade ${lr.found} av ${lr.total} möjliga i ”${lr.category}”.`),
        lr.missed.length ? h('div', null, h('p', { class: 'label', style: 'margin-top:14px' }, 'Vanliga svar ni missade'), h('div', { class: 'chips' }, lr.missed.map((w) => h('span', { class: 'chip' }, w)))) : null,
        lr.rare.length ? h('div', null, h('p', { class: 'label', style: 'margin-top:14px' }, 'Legendariska svar'), h('div', { class: 'chips' }, lr.rare.map((w) => h('span', { class: 'chip l' }, w)))) : null,
        h('p', { class: 'muted', style: 'margin-top:16px;font-size:14px' }, 'Nästa runda börjar strax…')));
    }
    return null;
  }

  function updateTyping() {
    const el = document.getElementById('typing');
    if (!el || !state || !state.round) return;
    const r = state.round;
    if (state.phase === 'turn' && r.turnPid !== me && lastTypingPid === r.turnPid) {
      el.replaceChildren(typingText, h('span', { class: 'caret' }));
    } else if (state.phase === 'turn' && r.turnPid !== me) {
      el.replaceChildren(h('span', { class: 'caret' }));
    } else el.replaceChildren();
  }

  function tickTimer() {
    if (!state || !state.round) return;
    const r = state.round;
    const bar = document.getElementById('timer');
    const secs = document.getElementById('secs');
    if (bar && state.phase === 'turn' && r.deadline) {
      const left = Math.max(0, r.deadline - now());
      const frac = Math.min(1, left / (r.turnTime * 1000));
      bar.firstChild.style.width = (frac * 100).toFixed(1) + '%';
      bar.className = 'timer' + (left < 3000 ? ' crit' : left < 6000 ? ' warn' : '');
      const s = Math.ceil(left / 1000);
      if (secs) secs.textContent = s + ' s';
      if (s <= 3 && s > 0 && s !== lastTickSec && r.turnPid === me) sfx.tick();
      lastTickSec = s;
    } else if (bar && state.phase !== 'turn') {
      bar.firstChild.style.width = state.phase === 'vote' ? bar.firstChild.style.width : '0%';
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
    const seat = document.querySelector(`.seat[data-pid="${pid}"]`);
    if (!seat) return;
    const b = h('div', { class: 'bubble' }, emoji);
    seat.append(b);
    setTimeout(() => b.remove(), 1700);
  }

  function renderOver() {
    renderedKey = 'over';
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
