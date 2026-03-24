#!/usr/bin/env node
// build-arbejdsplan.js
// Builds and updates the Danish Warmblood arbejdsplan in Google Doc

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SHOW_ID = 77244;
const DOC_ID = '1aqwphHcnFygtZ0G_93jT3s5XIz0N653kuUXA2ruzRcw';
const SHEET_ID = '1YBCTRWSd96H63NntQJDgW5DV_LqkYmfkeQCOIbL6y-c';
const GOG_ACCOUNT = 'dan@leep-media.com';
const SERVER = 'http://localhost:3000';
const MARKER_START = '~~~ ARBEJDSPLAN DW2026 START ~~~';
const MARKER_END   = '~~~ ARBEJDSPLAN DW2026 SLUT ~~~';

// App share link (Danish Warmblood list)
const APP_LIST_ID   = '0b9e3038-aeec-48f7-a764-e0b526d015aa';
const APP_SHARE_TOKEN = 'WtDiexIH';
const APP_LOCAL_URL = `http://192.168.1.214:3000/?share=${APP_SHARE_TOKEN}`;

function getAppUrl() {
  try {
    const log = fs.readFileSync('/tmp/cloudflared.log', 'utf8');
    const m = log.match(/https:\/\/[a-z-]+\.trycloudflare\.com/g);
    if (m) return `${m[m.length - 1]}/?share=${APP_SHARE_TOKEN}`;
  } catch {}
  return APP_LOCAL_URL;
}

// Google Docs API credentials (from gog)
const GOG_CREDS_FILE  = path.join(process.env.HOME, 'Library/Application Support/gogcli/credentials.json');
const GOG_TOKEN_FILE  = '/tmp/gog-token-export.json';

// ── Helpers ──────────────────────────────────────────────────────────────────

function apiGet(path) {
  return new Promise((resolve, reject) => {
    http.get(SERVER + path, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function gog(args, opts = {}) {
  const result = spawnSync('bash', ['-c', `GOG_ACCOUNT=${GOG_ACCOUNT} gog ${args} --json --no-input 2>/dev/null`],
    { maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0 && !opts.ignoreError) {
    const err = result.stderr?.toString() || '';
    if (err) console.error('gog error:', err.slice(0, 300));
  }
  const out = result.stdout?.toString() || '';
  try { return JSON.parse(out); } catch { return {}; }
}

function gogRaw(args) {
  const result = spawnSync('bash', ['-c', `GOG_ACCOUNT=${GOG_ACCOUNT} gog ${args} 2>/dev/null`],
    { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout?.toString() || '';
}

function normName(s) {
  return (s || '').toLowerCase()
    .replace(/[áàäã]/g,'a').replace(/[éèëê]/g,'e').replace(/[íìî]/g,'i')
    .replace(/[óòöô]/g,'o').replace(/[úùüû]/g,'u')
    .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/å/g,'aa')
    .replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
}

function matchRider(name, riders) {
  const n = normName(name);
  let m = riders.find(r => normName(r.name) === n);
  if (m) return m;
  const words = n.split(' ').filter(w => w.length > 1);
  m = riders.find(r => { const rn = normName(r.name); return words.every(w => rn.includes(w)); });
  if (m) return m;
  if (words.length >= 2) {
    const [first, last] = [words[0], words[words.length - 1]];
    m = riders.find(r => { const rn = normName(r.name); return rn.includes(first) && rn.includes(last); });
    if (m) return m;
  }
  return null;
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['Søndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag'];
  const months = ['januar','februar','marts','april','maj','juni','juli','august','september','oktober','november','december'];
  return `${days[d.getDay()]} d. ${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtArena(arena) {
  if (!arena) return '';
  if (/MASTERLIST|DELTAGER/i.test(arena)) return '';
  const m = arena.match(/ARENA\s+(\S+)/i);
  if (m) return ` [Arena ${m[1].toUpperCase()}]`;
  if (/BOXEN/i.test(arena)) return ' [Boxen]';
  return '';
}

function fmtTime(ts) {
  if (!ts) return '??:??';
  const m = ts.match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}.${m[2]}` : '??:??';
}

// Parse which show-dates an order applies to.
// Returns: { dates: Set<string>|null, uncertain: bool, reason: string }
// dates=null means "all dates" (no restriction)
const DAY_MAP = {
  torsdag: '2026-03-05',
  fredag:  '2026-03-06',
  lørdag:  '2026-03-07',
  søndag:  '2026-03-08',
};
const ALL_DAYS_KEYWORDS = [
  'alle ture', 'alle dage', 'en af hver', 'begge heste', 'alle heste',
  'af hver hest', 'hver dag', 'afventer', 'vender tilbage',
  'ikke bekræftet',
];
const CERTAIN_ALL = (d) => ALL_DAYS_KEYWORDS.some(k => d.toLowerCase().includes(k));

function parseOrderDays(details, riderDates) {
  const d = (details || '').toLowerCase();

  if (!details) return { dates: null, uncertain: false, reason: '' };

  // Day mentions take FIRST priority (overrides "all days" keywords)
  const mentioned = Object.entries(DAY_MAP)
    .filter(([day]) => d.includes(day))
    .map(([, date]) => date);

  if (mentioned.length > 0) {
    return { dates: new Set(mentioned), uncertain: false, reason: '' };
  }

  // No day mentioned but explicit "all days" → no filter
  if (CERTAIN_ALL(d)) {
    return { dates: null, uncertain: false, reason: '' };
  }

  // No day mentioned + rider rides on multiple days → uncertain
  if (riderDates && riderDates.size > 1) {
    const dayNames = [...riderDates]
      .sort()
      .map(date => Object.entries(DAY_MAP).find(([,v]) => v === date)?.[0] || date)
      .join(', ');
    return {
      dates: null,
      uncertain: true,
      reason: `Rider ${dayNames} – bestilling: "${details}"`
    };
  }

  return { dates: null, uncertain: false, reason: '' };
}

// ── Manual overrides ─────────────────────────────────────────────────────────
// Tilpas her uden at ændre Google Sheets-bestillingerne.
// Matcher på normaliseret navn (lowercase, æøå erstattet, ingen tegnsætning).
// keys: normaliseret navn
// horseFilter: kun film ryttere på disse heste (normaliserede)
// maxClasses: kun inkludér rytterens første N klasser pr. dag
// note: vises i planen
// skipDays: array af datoer der IKKE skal inkluderes, fx ['2026-03-06']
// onlyDays: kun inkludér disse datoer, fx ['2026-03-05','2026-03-07']
// pending: true = marker med ⏳ i planen (afventer besked)
const MANUAL_OVERRIDES = {
  // Josefine: afventer besked om hvilke(n) dag(e)
  'josefine sandgaard': { pending: true, note: 'Afventer — vender tilbage med dage' },

  // Cille: film snarest muligt, stop når 2 reels er optaget
  'cille ramlow':       { note: 'Film snarest — stop efter 2 reels' },
  'cille ramlow jensen':{ note: 'Film snarest — stop efter 2 reels' },

  // Johanna: torsdag og lørdag (endnu ikke endeligt bekræftet)
  'johanna magnusson':  { onlyDays: ['2026-03-05','2026-03-07'], note: 'Tors + lør (bekræftes)' },

  // Astrid: filmes kun på hesten Ninja
  'astrid wisholm':     { horseFilter: ['ninja'], note: 'Kun Ninja' },
};

// ── Ekstra noter per dag (ikke-ryttere, BTS, specielle opgaver) ──────────────
// Format: { 'YYYY-MM-DD': ['Note linje 1', 'Note linje 2', ...] }
const EXTRA_NOTES = {
  '2026-03-05': [
    'BTS: Andreas Kreuzer (træner) — kursusvandring, opvarmning + efter runden med Zascha Nygaard & Alexa Stais',
  ],
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function buildPlan() {
  // 1. Equipe riders
  console.log('Henter ryttere fra Equipe...');
  const equipeRiders = await apiGet(`/api/shows/${SHOW_ID}/riders`);
  console.log(`  ${equipeRiders.length} ryttere`);

  // 2. Orders from Sheets
  console.log('Henter bestillinger fra Google Sheets...');
  const sheetsData = gog(`sheets get ${SHEET_ID} "Marts 2026!B5:J90"`);
  const rows = sheetsData.values || [];

  const NON_RIDERS = ['SD Design Stand', 'Møder', 'Kontaktperson',
    'Dato for event', 'Lokation', 'Projekt', 'Specifikationer',
    'Henvendelse', 'Noter'];
  const orders = [];
  for (const row of rows) {
    const name = (row[0] || '').replace(/^0/, '').trim();
    if (!name || NON_RIDERS.includes(name)) continue;
    // Skip lines that look like notes, not rider names (e.g. "Søndag Pidgley, Krohn")
    if (name.match(/^(Søndag|Mandag|Tirsdag|Onsdag|Torsdag|Fredag|Lørdag)\s/i)) continue;
    // Skip if multiple names separated by comma (meeting notes)
    if (name.includes(',') && name.split(',').length > 1 && !name.match(/^[A-ZÆØÅ]/)) continue;
    orders.push({
      name,
      instagram: (row[1] || '').trim(),
      details:   (row[2] || '').trim(),
    });
  }
  console.log(`  ${orders.length} bestillinger`);

  // 3. Match
  const matched = [], unmatched = [];
  for (const order of orders) {
    const rider = matchRider(order.name, equipeRiders);
    if (rider) matched.push({ order, rider });
    else       { unmatched.push(order); console.log(`  Ingen Equipe-match: "${order.name}"`); }
  }
  console.log(`  ${matched.length} matchet, ${unmatched.length} ikke matchet`);

  // 4. Arena lookup
  const showData = await apiGet(`/api/shows/${SHOW_ID}`);
  const arenaMap = {};
  for (const classes of Object.values(showData.classesByDate || {}))
    for (const cls of classes)
      if (cls.classNo) arenaMap[cls.classNo] = cls.arena || '';

  // 5. Build day map with day-filtering
  const dayMap = {};
  const uncertainCases = []; // { name, details, reason }

  for (const { order, rider } of matched) {
    // Get the dates this rider appears on in the show
    const riderShowDates = new Set(
      (rider.entries || [])
        .filter(e => e.date >= '2026-03-05')
        .map(e => e.date)
    );

    const { dates: allowedDates, uncertain, reason } = parseOrderDays(order.details, riderShowDates);

    if (uncertain) {
      uncertainCases.push({ name: order.name, details: order.details, reason });
    }

    // Manual overrides for specific riders
    const overrideKey = normName(order.name);
    const override = MANUAL_OVERRIDES[overrideKey] || {};

    // Track classes-per-day for maxClasses
    const classCountPerDay = {};

    const sortedEntries = [...(rider.entries || [])].sort((a, b) =>
      ((a.date || '') + (a.classStartAt || '')).localeCompare((b.date || '') + (b.classStartAt || '')));

    for (const e of sortedEntries) {
      if (!e.date || e.date < '2026-03-05') continue;
      if (!e.classNo || /MASTERLIST|DELTAGER/i.test(e.className || '')) continue;

      // Apply Sheets day filter
      if (allowedDates && !allowedDates.has(e.date)) continue;

      // Apply onlyDays override
      if (override.onlyDays && !override.onlyDays.includes(e.date)) continue;

      // Apply skipDays override
      if (override.skipDays && override.skipDays.includes(e.date)) continue;

      // Apply horseFilter override
      if (override.horseFilter) {
        const hn = normName(e.horseName || '');
        if (!override.horseFilter.some(hf => hn.includes(hf))) continue;
      }

      // Apply maxClasses override (per day)
      if (override.maxClasses) {
        classCountPerDay[e.date] = (classCountPerDay[e.date] || 0);
        if (classCountPerDay[e.date] >= override.maxClasses) continue;
        // Ensure we only count a classSectionId once per day
        if (!dayMap[e.date]?.[e.classSectionId]) {
          classCountPerDay[e.date]++;
        }
      }

      if (!dayMap[e.date]) dayMap[e.date] = {};
      if (!dayMap[e.date][e.classSectionId]) {
        dayMap[e.date][e.classSectionId] = {
          classSectionId: e.classSectionId,
          className: e.className,
          classNo: e.classNo,
          time: e.classStartAt,
          arena: arenaMap[e.classNo] || '',
          riders: []
        };
      }
      dayMap[e.date][e.classSectionId].riders.push({
        order, riderName: rider.name,
        startNo: e.startNo, horseName: e.horseName,
        startAt: e.startAt || null,
        uncertain,
        pending: !!override.pending,
        riderNote: override.note || ''
      });
    }
  }

  // Log uncertain cases
  if (uncertainCases.length > 0) {
    console.log('\n⚠️  Tvivlstilfælde (inkluderet på alle dage indtil afklaring):');
    for (const u of uncertainCases) console.log(`  - ${u.name}: ${u.reason}`);
  }
  // Store for later return
  buildPlan._uncertainCases = uncertainCases;

  // 6. Generate text
  const now = new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen', hour12: false });
  const lines = [
    'DANISH WARMBLOOD STALLION SHOW 2026',
    'D. 3. - 8. marts 2026, Herning',
    `Opdateret: ${now}`,
    '',
    'RYTTERE:',
  ];

  for (const { order } of matched) {
    let l = order.name;
    if (order.details) l += ` (${order.details})`;
    lines.push(l);
  }

  const realUnmatched = unmatched.filter(u => !NON_RIDERS.includes(u.name));
  if (realUnmatched.length > 0) {
    lines.push('');
    lines.push('Ikke fundet i Equipe endnu:');
    for (const u of realUnmatched) lines.push(`${u.name}${u.details ? ' (' + u.details + ')' : ''}`);
  }

  // App link – placed just below rider list
  lines.push('');
  lines.push(`Åbn filmplan i app: ${getAppUrl()}`);

  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Copenhagen' });
  const SKIP_DATES = ['2026-03-04']; // Dage vi ikke filmer

  const allDates      = Object.keys(dayMap).sort().filter(d => !SKIP_DATES.includes(d));
  const upcomingDates = allDates.filter(d => d >= todayStr);
  const pastDates     = allDates.filter(d => d <  todayStr);
  const sortedDates   = [...upcomingDates, ...pastDates];

  for (const date of sortedDates) {
    const isPast = date < todayStr;
    lines.push('');
    lines.push('________________________________');
    const dayHeader = fmtDate(date).toUpperCase();
    lines.push(isPast ? `${dayHeader} (AFSLUTTET)` : dayHeader);
    lines.push('');

    const classes = Object.values(dayMap[date])
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    for (const cls of classes) {
      const arena = fmtArena(cls.arena);
      lines.push(`Kl. ${fmtTime(cls.time)} / Klasse ${cls.classNo} - ${cls.className}${arena}`);

      const sorted = [...cls.riders].sort((a, b) =>
        (parseInt(a.startNo) || 999) - (parseInt(b.startNo) || 999));
      for (const r of sorted) {
        let flag = r.uncertain ? ' ⚠️' : '';
        if (r.pending) flag += ' ⏳';
        const noteStr = r.riderNote ? ` [${r.riderNote}]` : '';
        const timeStr = r.startAt ? ` kl. ${fmtTime(r.startAt)}` : '';
        lines.push(`Nr. ${r.startNo || '?'}${timeStr} - ${r.riderName} / ${r.horseName}${flag}${noteStr}`);
      }
      lines.push('');
    }

    // Ekstra noter for denne dag
    const dayNotes = EXTRA_NOTES[date] || [];
    if (dayNotes.length > 0) {
      lines.push('NOTER:');
      for (const note of dayNotes) lines.push(`- ${note}`);
      lines.push('');
    }
  }

  return { text: lines.join('\n'), matched, unmatched, uncertainCases: buildPlan._uncertainCases || [] };
}

// ── Font formatting via Google Docs API ──────────────────────────────────────

function getDocsClient() {
  if (!fs.existsSync(GOG_TOKEN_FILE)) {
    // Auto-export token from gog keyring
    console.log('Token-fil mangler — eksporterer fra gog keyring...');
    const r = spawnSync('bash', ['-c',
      `GOG_ACCOUNT=${GOG_ACCOUNT} gog auth tokens export ${GOG_ACCOUNT} --out ${GOG_TOKEN_FILE} --overwrite --no-input 2>/dev/null`
    ], { timeout: 10000 });
    if (!fs.existsSync(GOG_TOKEN_FILE)) {
      console.log('⚠️  Token-eksport fejlede — springer font-formatering over');
      return null;
    }
    console.log('  Token eksporteret ✓');
  }
  try {
    const { google } = require('googleapis');
    const tokenData = JSON.parse(fs.readFileSync(GOG_TOKEN_FILE));
    const credsData = JSON.parse(fs.readFileSync(GOG_CREDS_FILE));
    const auth = new google.auth.OAuth2(credsData.client_id, credsData.client_secret);
    auth.setCredentials({ refresh_token: tokenData.refresh_token });
    return google.docs({ version: 'v1', auth });
  } catch (e) {
    console.log('⚠️  Docs API klient fejlede:', e.message);
    return null;
  }
}

async function formatDocSection(docs) {
  if (!docs) return;
  try {
    console.log('Formaterer afsnit (Montserrat, korrekte størrelser)...');
    const res = await docs.documents.get({ documentId: DOC_ID });
    const content = res.data.body?.content || [];

    const requests = [];
    let inSection = false;

    for (const el of content) {
      if (!el.paragraph) continue;
      const si = el.startIndex;
      const ei = el.endIndex;
      const rawText = el.paragraph.elements?.map(e => e.textRun?.content || '').join('') || '';
      const text = rawText.replace(/\n$/, '');

      if (text.includes(MARKER_START)) inSection = true;
      if (!inSection) continue;
      if (text.includes(MARKER_END)) { inSection = false; }

      if (si === undefined || !rawText.trim()) continue;

      // Determine font size
      let fontSize = 8;
      const t = text.trim();
      if (/^DANISH WARMBLOOD/i.test(t)) fontSize = 10;
      if (/^_{10,}/.test(t)) fontSize = 10;
      if (/^(TORSDAG|FREDAG|LØRDAG|SØNDAG|MANDAG|TIRSDAG|ONSDAG)\s/i.test(t)) fontSize = 10;

      requests.push({
        updateTextStyle: {
          range: { startIndex: si, endIndex: ei - 1 },
          textStyle: {
            weightedFontFamily: { fontFamily: 'Montserrat', weight: 400 },
            fontSize: { magnitude: fontSize, unit: 'PT' },
          },
          fields: 'weightedFontFamily,fontSize',
        },
      });

      // Make app URL a hyperlink
      const urlMatch = text.match(/https?:\/\/\S+/);
      if (urlMatch) {
        const urlOffset = text.indexOf(urlMatch[0]);
        requests.push({
          updateTextStyle: {
            range: { startIndex: si + urlOffset, endIndex: si + urlOffset + urlMatch[0].length },
            textStyle: { link: { url: urlMatch[0] } },
            fields: 'link',
          },
        });
      }
    }

    if (requests.length === 0) { console.log('  Ingen paragrafer fundet til formatering'); return; }

    // Send in batches of 100
    for (let i = 0; i < requests.length; i += 100) {
      await docs.documents.batchUpdate({
        documentId: DOC_ID,
        requestBody: { requests: requests.slice(i, i + 100) },
      });
    }
    console.log(`  Formatering færdig (${requests.length} requests) ✓`);
  } catch (e) {
    console.log('⚠️  Formatering fejlede:', e.message);
  }
}

async function writeToDoc(newText) {
  const section = `${MARKER_START}\n${newText}\n${MARKER_END}`;

  // Get current doc
  console.log('Henter nuværende dokument...');
  const currentText = gogRaw(`docs cat ${DOC_ID}`);

  const startIdx = currentText.indexOf(MARKER_START);
  const endIdx   = currentText.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Update existing section: delete old, insert new
    const endPos = endIdx + MARKER_END.length + 1; // +1 for trailing newline

    // Character positions are 1-indexed in Google Docs API
    // gog docs cat returns text with 1-based indexing matching API
    const startPos = startIdx + 1;
    const endPosApi = endPos;

    console.log(`Sletter gammel sektion (pos ${startPos}-${endPosApi})...`);
    gog(`docs delete --start=${startPos} --end=${endPosApi} ${DOC_ID}`, { ignoreError: true });

    console.log('Indsætter ny sektion...');
    fs.writeFileSync('/tmp/arbejdsplan-insert.txt', section + '\n\n');
    gog(`docs insert ${DOC_ID} --file /tmp/arbejdsplan-insert.txt --index=${startPos}`, { ignoreError: true });
  } else {
    // First time: insert at beginning
    console.log('Første gang — indsætter øverst i dokumentet...');
    fs.writeFileSync('/tmp/arbejdsplan-insert.txt', section + '\n\n');
    gog(`docs insert ${DOC_ID} --file /tmp/arbejdsplan-insert.txt --index=1`);
  }
  console.log('Dokument opdateret ✓');
}

const UNCERTAIN_STATE = '/tmp/arbejdsplan-uncertain-state.json';

async function main() {
  console.log('=== Bygger arbejdsplan', new Date().toISOString(), '===');
  const { text, matched, uncertainCases } = await buildPlan();
  fs.writeFileSync('/tmp/arbejdsplan-preview.txt', text);
  const docs = getDocsClient();
  await writeToDoc(text);
  await formatDocSection(docs);
  console.log(`\nFærdig. ${matched.length} ryttere i planen.`);

  // Check for new uncertain cases since last run
  if (uncertainCases.length > 0) {
    const prevRaw = fs.existsSync(UNCERTAIN_STATE)
      ? fs.readFileSync(UNCERTAIN_STATE, 'utf8') : '[]';
    const prevNames = new Set(JSON.parse(prevRaw).map(u => u.name));
    const newCases = uncertainCases.filter(u => !prevNames.has(u.name));

    fs.writeFileSync(UNCERTAIN_STATE, JSON.stringify(uncertainCases));

    if (newCases.length > 0) {
      // Print in a format the cron monitor can detect and forward
      console.log('\n⚠️ NYE TVIVLSTILFÆLDE – spørg Dan:');
      for (const u of newCases) {
        console.log(`  • ${u.name}: ${u.reason}`);
      }
      // Write to a trigger file so the monitoring agent can pick it up
      fs.writeFileSync('/tmp/arbejdsplan-ask-dan.txt',
        `Disse ryttere er lagt på alle dage med ⚠️ fordi det er uklart hvilke(n) dag(e) de skal filmes:\n\n` +
        newCases.map(u => `• ${u.name} – bestilling: "${u.details}"\n  Rider: ${u.reason}`).join('\n\n') +
        `\n\nSkal jeg beholde dem på alle dage, eller specificer hvilke dage?`
      );
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
