// Normalisering, matchning och uppbyggnad av kategorier.
const { COUNTRIES, ANIMALS, CITIES, FIXED } = require('./data');
const MORE = require('./data2');
const { SMALL, RETIRED } = require('./data3');
const MAX_LETTER = 35; // bokstavskategorier större än så blir för långa

const TIERS = ['c', 'u', 'r', 'l'];
const TIER_INFO = {
  c: { name: 'Vanlig', points: 10 },
  u: { name: 'Ovanlig', points: 25 },
  r: { name: 'Sällsynt', points: 50 },
  l: { name: 'Legendarisk', points: 100 },
};

function clean(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, ' och ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(en|ett|the|a) /, '');
}

// Nyckel för jämförelse: utan diakritiska tecken och mellanslag.
function key(s) {
  return clean(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ /g, '');
}

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const SUFFIXES = ['', 'n', 'en', 't', 'et', 'r', 'ar', 'er', 'or', 'na', 'arna', 'erna', 'orna', 'a', 's', 'e'];

// Poäng för hur väl ett svar matchar en nyckel (lägre = bättre, null = ingen match).
function matchScore(input, k) {
  if (input === k) return 0;
  if (k.length >= 2) {
    for (const suf of SUFFIXES) {
      if (!suf) continue;
      if (input === k + suf) return 1;
      if (k === input + suf && input.length >= 3) return 1;
      // fjäder/fjädrar, vinge/vingar: byt sista vokal
      if (k.length > 2 && /[aeiouyåäö]$/.test(k) && input === k.slice(0, -1) + suf) return 1;
      if (input.length > 2 && /[aeiouyåäö]$/.test(input) && k === input.slice(0, -1) + suf) return 1;
    }
  }
  const max = k.length >= 8 ? 2 : k.length >= 4 ? 1 : 0;
  if (max > 0) {
    const d = lev(input, k, max);
    if (d <= max) return 1 + d;
  }
  return null;
}

function parseTier(str) {
  return String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const [names, region] = raw.split('#');
      const aliases = names.split('/').map((a) => a.trim()).filter(Boolean);
      return { aliases, region: region ? region.trim() : null };
    });
}

function buildEntries(group, filter) {
  const out = [];
  const seen = new Set();
  for (const t of TIERS) {
    for (const e of parseTier(group[t])) {
      let aliases = e.aliases;
      if (filter) {
        aliases = filter(e, aliases);
        if (!aliases || !aliases.length) continue;
      }
      const id = key(e.aliases[0]);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, display: aliases[0], keys: [...new Set(aliases.map(key))], tier: t });
    }
  }
  return out;
}

const startsWith = (letter) => (e, aliases) => aliases.filter((a) => clean(a).startsWith(letter.toLowerCase()));

const LETTERS = 'ABCDEFGHIJKLMNOPRSTUVYÅÄÖ'.split('');
const REGIONS = [
  ['eu', 'Länder i Europa', '🇪🇺'],
  ['af', 'Länder i Afrika', '🌍'],
  ['as', 'Länder i Asien', '🌏'],
  ['sa', 'Länder i Sydamerika', '🌎'],
  ['na', 'Länder i Nord- och Centralamerika', '🌎'],
];

function buildCategories() {
  const cats = [];
  for (const f of [...FIXED, ...MORE, ...SMALL]) {
    cats.push({ id: f.id, name: f.name, emoji: f.emoji, pack: 'teman', entries: buildEntries(f) });
  }
  cats.push({ id: 'lander', name: 'Länder', emoji: '🗺️', pack: 'lander', entries: buildEntries(COUNTRIES) });
  for (const [reg, name, emoji] of REGIONS) {
    cats.push({ id: 'lander-' + reg, name, emoji, pack: 'lander',
      entries: buildEntries(COUNTRIES, (e, a) => (e.region === reg ? a : null)) });
  }
  const lettered = [
    ['lander', 'Länder på', '🗺️', COUNTRIES, 7],
    ['djur', 'Djur på', '🐾', ANIMALS, 12],
    ['orter', 'Svenska orter på', '🇸🇪', CITIES, 10],
  ];
  cats.push({ id: 'djur', name: 'Djur', emoji: '🐾', pack: 'djur', entries: buildEntries(ANIMALS) });
  cats.push({ id: 'orter', name: 'Svenska städer och orter', emoji: '🇸🇪', pack: 'orter', entries: buildEntries(CITIES) });
  for (const [pack, label, emoji, group, min] of lettered) {
    for (const L of LETTERS) {
      const entries = buildEntries(group, startsWith(L));
      if (entries.length >= min && entries.length <= MAX_LETTER) {
        cats.push({ id: `${pack}-${L}`, name: `${label} ${L}`, emoji, pack, letter: L.toLowerCase(), entries });
      }
    }
  }
  const kept = cats.filter((c) => !RETIRED.includes(c.id));
  cats.length = 0;
  cats.push(...kept);
  for (const c of cats) {
    c.byKey = new Map();
    for (const e of c.entries) for (const k of e.keys) if (!c.byKey.has(k)) c.byKey.set(k, e);
  }
  return cats;
}

// Hitta bästa posten i kategorin för ett svar.
function findEntry(cat, text) {
  const k = key(text);
  if (!k) return null;
  const exact = cat.byKey.get(k);
  if (exact) return exact;
  let best = null;
  let bestScore = 99;
  for (const e of cat.entries) {
    for (const ek of e.keys) {
      const s = matchScore(k, ek);
      if (s !== null && s < bestScore) {
        best = e;
        bestScore = s;
      }
    }
  }
  return best;
}

module.exports = { buildCategories, findEntry, key, clean, matchScore, TIER_INFO, TIERS };
