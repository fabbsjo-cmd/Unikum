# Unikum 🐙

**Kom på ordet ingen annan tänker på.** Ett ordspel för 1–8 spelare på var sin mobil eller dator.

## Så spelar man

1. En person skapar ett rum och delar länken eller den fyrbokstäviga koden.
2. Alla får samma kategori, till exempel *Länder på S* eller *Saker djur har men inte människor*.
3. Ni svarar i tur och ordning innan tiden tar slut. Ett ord som redan sagts går inte att ta igen.
4. Varje svar får en sällsynthet: **Vanlig** (10 p), **Ovanlig** (25 p), **Sällsynt** (50 p) eller **Legendarisk** (100 p).
5. Hinner du inte svara tappar du ett av dina liv och en ny kategori kommer. Sist kvar med liv vinner.
6. Skriver någon ett ord som inte finns i ordlistan röstar de andra om det godkänns. Godkända ord sparas och räknas som giltiga nästa gång.

Värden kan ställa in tid per tur, antal liv, vilka kategoripaket som används, tempoökning och strikt läge (bara ordlistan, ingen röstning).

Sällsyntheten börjar från en handskriven bedömning och justeras automatiskt efter hur ofta ord faktiskt används när ni spelar.

## Köra lokalt

```bash
npm install
npm start          # http://localhost:3000
npm test           # snabbtest med tre låtsasspelare
```

## Lägga upp gratis på Render

1. Logga in på [render.com](https://render.com) med ditt GitHub-konto.
2. Välj **New → Blueprint** och peka på det här repot. Render läser `render.yaml` och skapar tjänsten.
3. När den är klar får du en adress som `https://unikum-xxxx.onrender.com`. Dela den med dina vänner!

Bra att veta om gratisnivån: tjänsten somnar efter cirka 15 minuter utan besökare och tar ungefär en minut att vakna. Öppna länken en stund innan ni ska spela. Statistiken över ordens sällsynthet nollställs när tjänsten startas om.

## Lägga till kategorier

Alla kategorier finns i `lib/data.js`. Svar skrivs kommaseparerade per nivå (`c` vanlig, `u` ovanlig, `r` sällsynt, `l` legendarisk), och alternativa stavningar med `/`, till exempel `Nederländerna/Holland`.
