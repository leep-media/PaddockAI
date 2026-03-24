const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 5 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message || String(err)).toString();
        return reject(new Error(msg));
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
// På Railway: brug /data volume hvis tilgængeligt, ellers lokal data/
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
  : path.join(__dirname, 'data');
const OPENCLAW_SESSIONS_DIR = path.join(process.env.HOME || '', '.openclaw', 'agents', 'main', 'sessions');
const EQUIPE_BASE = 'https://online.equipe.com';

app.use(express.json());

// ===== USERS: JSON file storage =====
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveUsers(users) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// POST /api/users — create or find user
app.post('/api/users', (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Navn og email er påkrævet' });
    const users = loadUsers();
    const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      // Update name if changed
      if (existing.name !== name) { existing.name = name; saveUsers(users); }
      return res.json(existing);
    }
    const user = {
      id: crypto.randomUUID(),
      name,
      email: email.toLowerCase(),
      plan: 'free',
      createdAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers(users);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:email — get user by email
app.get('/api/users/:email', (req, res) => {
  try {
    const users = loadUsers();
    const user = users.find(u => u.email.toLowerCase() === req.params.email.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Bruger ikke fundet' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/:email — update user (plan, name)
app.patch('/api/users/:email', (req, res) => {
  try {
    const users = loadUsers();
    const user = users.find(u => u.email.toLowerCase() === req.params.email.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Bruger ikke fundet' });
    if (req.body.name) user.name = req.body.name;
    if (req.body.plan) user.plan = req.body.plan;
    saveUsers(users);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SSE: live sync for shared lists =====
const listClients = {}; // listId -> Set of res objects

function addSSEClient(listId, res) {
  if (!listClients[listId]) listClients[listId] = new Set();
  listClients[listId].add(res);
  res.on('close', () => {
    listClients[listId]?.delete(res);
    if (listClients[listId]?.size === 0) delete listClients[listId];
  });
}

function notifyListClients(listId, event, data) {
  const clients = listClients[listId];
  if (!clients) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.write(msg); } catch {}
  }
}

// SSE endpoint
app.get('/api/lists/:id/events', (req, res) => {
  const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('event: connected\ndata: {}\n\n');
  addSSEClient(req.params.id, res);
  // Heartbeat every 30s to keep connection alive
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 30000);
  res.on('close', () => clearInterval(hb));
});

// Set proper MIME type for manifest.json
express.static.mime.define({'application/manifest+json': ['webmanifest', 'json']});

app.use(express.static(path.join(__dirname, 'public')));

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Helper: fetch JSON from Equipe API
// Simple in-memory cache for Equipe API responses
const _equipeCache = new Map(); // path -> { data, expires }
const CACHE_TTL = {
  class_sections: 10 * 60 * 1000,  // 10 min — startlists can update
  schedule:        5 * 60 * 1000,  // 5 min  — class list changes rarely during day
  default:         2 * 60 * 1000,  // 2 min
};

async function equipeGet(apiPath, { bustCache = false } = {}) {
  const now = Date.now();
  if (!bustCache && _equipeCache.has(apiPath)) {
    const entry = _equipeCache.get(apiPath);
    if (entry.expires > now) return entry.data;
  }
  const url = `${EQUIPE_BASE}${apiPath}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'EquipeFilmlist/1.0' }
  });
  if (!res.ok) throw new Error(`Equipe API ${res.status}: ${url}`);
  const data = await res.json();
  const ttlKey = apiPath.includes('class_sections') ? 'class_sections'
               : apiPath.includes('schedule') ? 'schedule' : 'default';
  _equipeCache.set(apiPath, { data, expires: now + CACHE_TTL[ttlKey] });
  return data;
}

// GET /api/shows - Danish shows
app.get('/api/shows', async (req, res) => {
  try {
    const meetings = await equipeGet('/api/v1/meetings/recent');
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const danish = meetings.filter(m => m.venue_country === 'DEN' && m.start_on >= cutoffStr);
    const shows = danish.map(m => ({
      id: m.id,
      name: m.display_name || m.name,
      startDate: m.start_on,
      endDate: m.end_on,
      discipline: m.discipline,
      disciplines: m.disciplines,
      country: m.venue_country
    }));
    res.json(shows);
  } catch (err) {
    console.error('Error fetching shows:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shows/:id - Show details (schedule with classes per day)
app.get('/api/shows/:id', async (req, res) => {
  try {
    const schedule = await equipeGet(`/api/v1/meetings/${req.params.id}/schedule`);
    const classes = (schedule.meeting_classes || []).map(mc => ({
      id: mc.id,
      name: mc.name,
      classNo: mc.class_no,
      discipline: mc.discipline,
      date: mc.date,
      startAt: mc.start_at,
      description: mc.description,
      arena: mc.arena,
      classSections: (mc.class_sections || []).map(cs => ({
        id: cs.id,
        state: cs.state,
        total: cs.total,
        remains: cs.remains,
        finishAt: cs.finish_at
      }))
    }));

    // Group by date
    const byDate = {};
    for (const cls of classes) {
      const d = cls.date || 'unknown';
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(cls);
    }
    // Sort each day by startAt
    for (const d of Object.keys(byDate)) {
      byDate[d].sort((a, b) => (a.startAt || '').localeCompare(b.startAt || ''));
    }

    res.json({
      id: schedule.id,
      name: schedule.display_name || schedule.name,
      startDate: schedule.start_on,
      endDate: schedule.end_on,
      discipline: schedule.discipline,
      classesByDate: byDate
    });
  } catch (err) {
    console.error('Error fetching show:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Shared: fetch all riders for a show (with long-lived in-memory cache)
const _ridersCache = new Map(); // showId -> { riders, expires }
const RIDERS_TTL = 15 * 60 * 1000; // 15 min — startlists update at most a few times/day

async function getRidersForShow(showId) {
  const now = Date.now();
  if (_ridersCache.has(showId) && _ridersCache.get(showId).expires > now) {
    const cached = _ridersCache.get(showId);
    return { riders: cached.riders, csAnchors: cached.csAnchors || {}, csMeta: cached.csMeta || {} };
  }
  const schedule = await equipeGet(`/api/v1/meetings/${showId}/schedule`);
  const classSectionIds = [];
  for (const mc of (schedule.meeting_classes || [])) {
    for (const cs of (mc.class_sections || [])) {
      classSectionIds.push({ csId: cs.id, mcName: mc.name, mcClassNo: mc.class_no, mcDate: mc.date, mcStartAt: mc.start_at, mcArena: mc.arena });
    }
  }
  const ridersMap = {};
  const csAnchors = {}; // csId -> [{position, startAt, startNo}] — entries without rider_id but with start_at
  const csMeta = {};   // csId -> { secPerStart, finishAt, total, minPosition } — class section timing metadata
  const BATCH = 10;
  for (let i = 0; i < classSectionIds.length; i += BATCH) {
    const batch = classSectionIds.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async ({ csId, mcName, mcClassNo, mcDate, mcStartAt, mcArena }) => {
        try {
          const csData = await equipeGet(`/api/v1/class_sections/${csId}`);
          return { csId, mcName, mcClassNo, mcDate, mcStartAt, mcArena, starts: csData.starts || [], csData };
        } catch {
          return { csId, mcName, mcClassNo, mcDate, mcStartAt, mcArena, starts: [], csData: {} };
        }
      })
    );
    for (const { csId, mcName, mcClassNo, mcDate, mcStartAt, mcArena, starts, csData } of results) {
      // Capture class section timing metadata for position-based interpolation
      if (csData.sec_per_start || csData.finish_at) {
        const positions = starts.map(s => s.position).filter(p => p != null);
        csMeta[csId] = {
          secPerStart: csData.sec_per_start || null,
          finishAt: csData.finish_at || null,
          total: csData.total || starts.length,
          minPosition: positions.length ? Math.min(...positions) : 1000
        };
      }
      for (const s of starts) {
        const rid = s.rider_id;
        if (!rid) {
          // Rider-less entries (placeholders) often carry the authoritative start_at for their slot
          if (s.start_at) {
            if (!csAnchors[csId]) csAnchors[csId] = [];
            csAnchors[csId].push({ position: s.position || 9999, startAt: s.start_at, startNo: s.start_no });
          }
          continue;
        }
        if (!ridersMap[rid]) ridersMap[rid] = { id: rid, name: s.rider_name, club: s.club_name, entries: [] };
        ridersMap[rid].entries.push({
          classSectionId: csId, className: mcName, classNo: mcClassNo,
          date: mcDate, classStartAt: mcStartAt, startNo: s.start_no,
          startAt: s.start_at, horseName: s.horse_name,
          combinationNo: s.horse_combination_no, arena: mcArena,
          position: s.position
        });
      }
    }
  }
  const riders = Object.values(ridersMap).sort((a, b) => a.name.localeCompare(b.name, 'da'));
  _ridersCache.set(showId, { riders, csAnchors, csMeta, expires: now + RIDERS_TTL });
  return { riders, csAnchors, csMeta };
}

// GET /api/shows/:id/riders - All riders in a show
app.get('/api/shows/:id/riders', async (req, res) => {
  try {
    const { riders } = await getRidersForShow(req.params.id);
    res.json(riders);
  } catch (err) {
    console.error('Error fetching riders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: check if a start should be included based on granular selections
// selections format: { riderId: 'all' | { horseName: 'all' | [classSectionId, ...] } }
function shouldIncludeStart(start, selections, classSectionId) {
  if (!selections) return false;
  const sel = selections[String(start.rider_id)];
  if (!sel) return false;
  if (sel === 'all') return true;
  if (typeof sel === 'object') {
    const horseSel = sel[start.horse_name];
    if (!horseSel) return false;
    if (horseSel === 'all') return true;
    if (Array.isArray(horseSel)) return horseSel.includes(classSectionId);
  }
  return false;
}

// POST /api/lists - Create film list
app.post('/api/lists', (req, res) => {
  try {
    const { showId, showName, startDate, endDate, riderIds, selections, listName } = req.body;
    const id = crypto.randomUUID();
    const list = {
      id,
      showId,
      showName,
      listName: listName || showName,
      startDate,
      endDate,
      riderIds: riderIds || [],
      selections: selections || null,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify(list, null, 2));
    res.json(list);
  } catch (err) {
    console.error('Error creating list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lists - All saved lists
app.get('/api/lists', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const lists = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; }
    }).filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json(lists.map(l => ({ id: l.id, listName: l.listName || l.showName, showName: l.showName, startDate: l.startDate, endDate: l.endDate, riderCount: (l.riderIds || []).length, createdAt: l.createdAt })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/lists/:id - Rename list
app.patch('/api/lists/:id', (req, res) => {
  try {
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (req.body.listName) list.listName = req.body.listName;
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/lists/:id - Delete list
app.delete('/api/lists/:id', (req, res) => {
  try {
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lists/:id - Get film list
app.get('/api/lists/:id', (req, res) => {
  try {
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/lists/:id/riders - Update riders in list
app.put('/api/lists/:id/riders', (req, res) => {
  try {
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    list.riderIds = req.body.riderIds || [];
    if (req.body.selections !== undefined) list.selections = req.body.selections;
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    // Notify all SSE clients watching this list
    notifyListClients(req.params.id, 'riders-updated', { riderIds: list.riderIds, selections: list.selections });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/lists/:id/share - Generate share token
app.post('/api/lists/:id/share', (req, res) => {
  try {
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!list.shareToken) {
      list.shareToken = crypto.randomBytes(6).toString('base64url'); // short, URL-safe
    }
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    res.json({ shareToken: list.shareToken, listId: list.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shared/:token - Resolve share token to list
app.get('/api/shared/:token', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        if (list.shareToken === req.params.token) {
          return res.json({ listId: list.id });
        }
      } catch {}
    }
    res.status(404).json({ error: 'Delt liste ikke fundet' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: add N seconds to a class start time string like "2026-03-07 18:00:00 +0100"
// Returns ISO string with original timezone, e.g. "2026-03-07T18:08:45+01:00"
function addSecondsToClassTime(classStartAt, seconds) {
  if (!classStartAt || seconds == null) return null;
  const m = classStartAt.match(/^(\d{4}-\d{2}-\d{2})[\sT](\d{2}):(\d{2}):(\d{2})\s*([+-])(\d{2}):?(\d{2})/);
  if (!m) return null;
  const [, datePart, hh, mm, ss, sign, tzH, tzM] = m;
  const tzOffsetMin = (sign === '+' ? 1 : -1) * (parseInt(tzH) * 60 + parseInt(tzM));
  const tz = `${sign}${tzH}:${tzM.padStart(2, '0')}`;
  const baseDate = new Date(`${datePart}T${hh}:${mm}:${ss}${tz}`);
  if (isNaN(baseDate.getTime())) return null;
  // Shift by seconds and re-express in original timezone
  const localMs = baseDate.getTime() + seconds * 1000 + tzOffsetMin * 60 * 1000;
  const d = new Date(localMs);
  const rDate = d.toISOString().slice(0, 10);
  const rH = String(d.getUTCHours()).padStart(2, '0');
  const rM = String(d.getUTCMinutes()).padStart(2, '0');
  const rS = String(d.getUTCSeconds()).padStart(2, '0');
  return `${rDate}T${rH}:${rM}:${rS}${tz}`;
}

// GET /api/lists/:id/schedule - Get the formatted schedule for a film list
// Uses pre-fetched rider data (cached) instead of fetching each class section individually
app.get('/api/lists/:id/schedule', async (req, res) => {
  try {
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const selections = list.selections || null;
    const riderIdSet = selections ? new Set(Object.keys(selections).map(Number)) : new Set((list.riderIds || []).map(Number));

    // Use the riders cache — same data, no extra API calls
    const { riders: allRiders, csAnchors, csMeta } = await getRidersForShow(list.showId);
    const ourRiders = allRiders.filter(r => riderIdSet.has(r.id));

    const dayMap = {}; // date -> { csId -> { class info + riders[] } }

    for (const rider of ourRiders) {
      for (const e of (rider.entries || [])) {
        const date = e.date || 'unknown';
        const csId = e.classSectionId;

        // Check granular selection
        if (selections) {
          const sel = selections[String(rider.id)];
          if (!sel) continue;
          if (sel !== 'all') {
            const horseSel = sel[e.horseName];
            if (!horseSel) continue;
            if (horseSel !== 'all' && Array.isArray(horseSel) && !horseSel.includes(csId)) continue;
          }
        }

        if (!dayMap[date]) dayMap[date] = {};
        if (!dayMap[date][csId]) {
          dayMap[date][csId] = {
            time: e.classStartAt,
            className: e.className,
            classNo: e.classNo,
            arena: e.arena || null,
            classSectionId: csId,
            riders: []
          };
        }
        dayMap[date][csId].riders.push({
          startNo: e.startNo,
          riderName: rider.name,
          horseName: e.horseName,
          startAt: e.startAt,
          position: e.position
        });
      }
    }

    // Build full position-ordered startAt lookup from ALL show riders (for pair interpolation)
    // csId -> [ { startNo, position, startAt } ] sorted by position
    const csStartAtMap = {};
    // First: include rider-less anchor entries (they carry the authoritative start_at for H/UD/US classes)
    for (const [csId, anchors] of Object.entries(csAnchors || {})) {
      if (!csStartAtMap[csId]) csStartAtMap[csId] = [];
      for (const a of anchors) {
        csStartAtMap[csId].push({ startNo: a.startNo, position: a.position || 9999, startAt: a.startAt });
      }
    }
    // Then: add rider entries (they may also have start_at in some classes)
    for (const rider of allRiders) {
      for (const e of (rider.entries || [])) {
        if (!e.classSectionId) continue;
        const csId = e.classSectionId;
        const date = e.date || '';
        let fixedAt = e.startAt || null;
        if (fixedAt && !fixedAt.startsWith(date)) fixedAt = date + fixedAt.substring(10);
        if (!csStartAtMap[csId]) csStartAtMap[csId] = [];
        csStartAtMap[csId].push({ startNo: e.startNo, position: e.position || 9999, startAt: fixedAt });
      }
    }
    for (const arr of Object.values(csStartAtMap)) {
      arr.sort((a, b) => a.position - b.position);
    }

    // Convert to sorted arrays
    const scheduleOut = {};
    for (const [date, csMap] of Object.entries(dayMap)) {
      scheduleOut[date] = Object.values(csMap)
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      for (const cls of scheduleOut[date]) {
        // Initial sort by startNo for interpolation reference
        cls.riders.sort((a, b) => (parseInt(a.startNo) || 999) - (parseInt(b.startNo) || 999));

        // Fix startAt times with wrong date (Equipe sometimes stores yesterday's date)
        for (const r of cls.riders) {
          if (r.startAt && !r.startAt.startsWith(date)) {
            r.startAt = date + r.startAt.substring(10);
          }
        }

        // Interpolate + sort by startAt — only for UD/US championship classes (riders go two at a time)
        const isChampClass = /^(U[DS]|H\d)/i.test(cls.classNo || '');
        if (isChampClass) {
          const fullClass = csStartAtMap[cls.classSectionId] || [];
          const knownTimes = fullClass.filter(e => e.startAt).sort((a, b) => a.position - b.position);
          if (knownTimes.length >= 2) {
            const startNoToPos = {};
            for (const e of fullClass) startNoToPos[e.startNo] = e.position;
            for (const rider of cls.riders) {
              if (rider.startAt) continue;
              const rPos = startNoToPos[rider.startNo] || 9999;
              // "Floor" interpolation: find the highest-position anchor that is <= rider position
              // (H-classes: placeholder entry with start_at is always FIRST in each group slot)
              let best = null;
              for (const e of knownTimes) {
                if (e.position <= rPos) best = e.startAt;
                else break;
              }
              // Fallback: if no floor found (rider before first anchor), take the first anchor
              if (!best && knownTimes.length > 0) best = knownTimes[0].startAt;
              if (best) {
                // Fix date if anchor has wrong date (Equipe sometimes stores previous day)
                rider.startAt = best.startsWith(date) ? best : date + best.substring(10);
              }
            }
          }
          cls.riders.sort((a, b) => {
            if (a.startAt && b.startAt) return a.startAt.localeCompare(b.startAt);
            if (a.startAt) return -1;
            if (b.startAt) return 1;
            return (parseInt(a.startNo) || 999) - (parseInt(b.startNo) || 999);
          });
        } else {
          // Alle andre klasser: sorter efter startnummer som normalt
          cls.riders.sort((a, b) => (parseInt(a.startNo) || 999) - (parseInt(b.startNo) || 999));
        }

        // ── Position-based fallback ────────────────────────────────────────────
        // For classes where Equipe provides no individual start_at at all,
        // calculate times from classStartAt + sec_per_start × position offset.
        const missingTimes = cls.riders.filter(r => !r.startAt);
        if (missingTimes.length > 0) {
          const meta = csMeta[cls.classSectionId];
          const classStartAt = cls.time; // e.g. "2026-03-07 18:00:00 +0100"
          if (meta && meta.secPerStart && classStartAt) {
            for (const r of cls.riders) {
              if (r.startAt) continue;
              const posIndex = (r.position != null && meta.minPosition != null)
                ? r.position - meta.minPosition
                : null;
              if (posIndex != null && posIndex >= 0) {
                const computed = addSecondsToClassTime(classStartAt, posIndex * meta.secPerStart);
                if (computed) r.startAt = computed;
              }
            }
            // Re-sort by time now that all riders have startAt
            cls.riders.sort((a, b) => {
              if (a.startAt && b.startAt) return a.startAt.localeCompare(b.startAt);
              if (a.startAt) return -1;
              if (b.startAt) return 1;
              return (parseInt(a.startNo) || 999) - (parseInt(b.startNo) || 999);
            });
          }
        }

        // Strip internal position field from output
        for (const r of cls.riders) delete r.position;
      }
    }

    res.json({
      showName: list.showName || list.listName,
      startDate: list.startDate,
      endDate: list.endDate,
      schedule: scheduleOut
    });
  } catch (err) {
    console.error('Error fetching list schedule:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function cleanDesc(str) {
  let s = String(str || '');
  // Drop the untrusted metadata wrapper blocks (including the fenced JSON)
  s = s.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```[\s\S]*?```\s*/g, '');
  // Drop fenced code blocks (often JSON metadata)
  s = s.replace(/```[\s\S]*?```/g, '');
  // Drop leftover inline json preamble like: json { ... } ```
  s = s.replace(/^json\s*\{[\s\S]*?\}\s*```\s*/i, '');
  // Normalize media spam
  if (s.includes('[media attached')) return '📎 Vedhæftet media';
  // Drop leading System: noise
  s = s.replace(/^System:\s*/g, '');
  return s;
}

function safeFirstLine(str, maxLen = 120) {
  const s = cleanDesc(str).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

function findTranscriptPath(sessionId) {
  const direct = path.join(OPENCLAW_SESSIONS_DIR, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  // Fallback: look for deleted transcript
  try {
    const files = fs.readdirSync(OPENCLAW_SESSIONS_DIR);
    const prefix = `${sessionId}.jsonl.deleted.`;
    const match = files.find(f => f.startsWith(prefix));
    if (match) return path.join(OPENCLAW_SESSIONS_DIR, match);
  } catch {}
  return null;
}

function extractTaskFromTranscript(sessionId) {
  try {
    const p = findTranscriptPath(sessionId);
    if (!p) return '';
    const content = fs.readFileSync(p, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (evt.type === 'message' && evt.message?.role === 'user') {
        const txt = (evt.message?.content || []).map(c => c.text || '').join('\n');
        // Prefer the explicit [Subagent Task]: section if present
        const m = txt.match(/\[Subagent Task\]:\s*([\s\S]*)/);
        if (m && m[1]) return safeFirstLine(m[1], 140);
        return safeFirstLine(txt, 140);
      }
    }
  } catch {}
  return '';
}

function listRecentTaskTranscripts(limit = 80) {
  const out = [];
  try {
    const files = fs.readdirSync(OPENCLAW_SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl') || f.includes('.jsonl.deleted.'))
      .filter(f => !f.endsWith('.lock'));

    for (const f of files) {
      const full = path.join(OPENCLAW_SESSIONS_DIR, f);
      let modelId = '';
      let ts = 0;

      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n');
      let currentModel = '';
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }

        if (!ts && evt.timestamp) ts = Date.parse(evt.timestamp) || 0;

        if (evt.type === 'model_change') {
          currentModel = evt.modelId || currentModel;
          if (!modelId) modelId = currentModel;
        }

        if (evt.type === 'message' && evt.message?.role === 'user') {
          const txt = (evt.message?.content || []).map(c => c.text || '').join('\n');
          const isSubagent = txt.includes('[Subagent Context]') || txt.includes('[Subagent Task]');
          const m = txt.match(/\[Subagent Task\]:\s*([\s\S]*)/);
          const desc = safeFirstLine(m && m[1] ? m[1] : txt, 140);
          if (!desc) continue;
          out.push({
            when: Date.parse(evt.timestamp) || ts || fs.statSync(full).mtimeMs,
            model: currentModel || modelId || 'unknown',
            desc,
            file: f,
            kind: isSubagent ? 'subagent' : 'main'
          });
        }
      }
    }
  } catch {}

  out.sort((a, b) => b.when - a.when);
  return out.slice(0, limit);
}

// --- OpenClaw model/task dashboard (local) ---
app.get('/api/model-usage', async (req, res) => {
  try {
    const activeMinutes = String(req.query.activeMinutes || 60 * 24 * 7); // default 7 days
    const { stdout } = await execFileAsync('openclaw', ['sessions', '--active', activeMinutes, '--json']);
    const data = JSON.parse(stdout);

    const sessions = data.sessions || [];
    const byModel = {};
    for (const s of sessions) {
      const model = s.model || 'unknown';
      if (!byModel[model]) byModel[model] = { sessions: 0, input: 0, output: 0, total: 0 };
      byModel[model].sessions += 1;
      byModel[model].input += Number(s.inputTokens || 0);
      byModel[model].output += Number(s.outputTokens || 0);
      byModel[model].total += Number(s.totalTokens || 0);
    }

    // Recent subagents: keys starting with agent:main:subagent
    const recentSubagents = sessions
      .filter(s => String(s.key || '').includes(':subagent:'))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50)
      .map(s => ({
        key: s.key,
        sessionId: s.sessionId,
        model: s.model,
        totalTokens: s.totalTokens,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        updatedAt: s.updatedAt,
        desc: extractTaskFromTranscript(s.sessionId)
      }));

    // If session store is pruned, enrich subagent list from transcript files
    const transcriptTasks = listRecentTaskTranscripts(120);

    const merged = [];
    const seen = new Set();

    // Prefer session-backed subagent entries (have tokens)
    for (const s of recentSubagents) {
      const key = s.sessionId || s.key;
      seen.add(String(key));
      merged.push({
        when: s.updatedAt || 0,
        model: s.model,
        totalTokens: s.totalTokens,
        key: s.key,
        desc: s.desc || '',
        kind: 'subagent'
      });
    }
    // Add transcript-derived tasks (main + subagent), skipping duplicates
    for (const t of transcriptTasks) {
      const k = String(t.file) + '|' + String(t.when) + '|' + String(t.desc);
      if (seen.has(k)) continue;
      merged.push({
        when: t.when,
        model: t.model,
        totalTokens: null,
        key: t.file,
        desc: t.desc,
        kind: t.kind
      });
    }
    merged.sort((a, b) => (b.when || 0) - (a.when || 0));

    res.json({ byModel, recentTasks: merged.slice(0, 80), sessionsCount: sessions.length, activeMinutes: Number(activeMinutes) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/dashboard/models', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="da">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Model Dashboard</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;background:#000;color:#f5f5f7;margin:0;padding:16px}
    .container{max-width:900px;margin:0 auto}
    h1{font-size:20px;margin:8px 0 16px}
    .card{background:#1c1c1e;border:1px solid #38383a;border-radius:12px;padding:14px;margin:10px 0}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .pill{background:#2c2c2e;border:1px solid #38383a;border-radius:999px;padding:6px 10px;font-size:12px;color:#e5e5e5}
    table{width:100%;border-collapse:collapse}
    th,td{padding:10px 8px;border-bottom:1px solid #2c2c2e;font-size:13px;text-align:left}
    th{color:#86868b;font-weight:600}
    a{color:#0a84ff;text-decoration:none}
    button{background:#0a84ff;border:0;color:#fff;border-radius:10px;padding:10px 12px;font-weight:600}
    .muted{color:#86868b}
  </style>
</head>
<body>
  <div class="container">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h1>OpenClaw – Model Dashboard</h1>
      <button onclick="load()">Opdater</button>
    </div>
    <div class="card">
      <div class="row">
        <span class="pill" id="meta"></span>
        <span class="pill">Tip: /model opus | /model gpt | /model gemini-flash | /model deepseek</span>
      </div>
    </div>

    <div class="card">
      <h2 style="font-size:16px;margin:0 0 10px">Forbrug pr. model (sessions, tokens)</h2>
      <div id="byModel" class="muted">Indlæser…</div>
    </div>

    <div class="card">
      <h2 style="font-size:16px;margin:0 0 10px">Seneste opgaver</h2>
      <div class="muted" style="margin-bottom:8px">Viser både main- og sub-agent opgaver (udtrukket fra session-logs).</div>
      <div id="tasks" class="muted">Indlæser…</div>
    </div>
  </div>

<script>
async function load(){
  const res = await fetch('/api/model-usage');
  const data = await res.json();
  if(data.error){
    document.getElementById('byModel').textContent = data.error;
    document.getElementById('tasks').textContent = data.error;
    return;
  }
  document.getElementById('meta').textContent = 'Sessions: ' + data.sessionsCount + ' · Window: ' + data.activeMinutes + ' min';

  const entries = Object.entries(data.byModel).sort((a,b)=>b[1].total-a[1].total);
  const rows = entries.map(function(pair){
    const model = pair[0];
    const v = pair[1];
    return '<tr>'+
      '<td>' + model + '</td>'+
      '<td>' + v.sessions + '</td>'+
      '<td>' + v.input + '</td>'+
      '<td>' + v.output + '</td>'+
      '<td>' + v.total + '</td>'+
    '</tr>';
  }).join('');
  document.getElementById('byModel').innerHTML =
    '<table>'+
      '<thead><tr><th>Model</th><th>Sessions</th><th>In</th><th>Out</th><th>Total</th></tr></thead>'+
      '<tbody>' + rows + '</tbody>'+
    '</table>';

  function modelBadge(model){
    var m = (model||'').toLowerCase();
    var label = 'AI';
    var bg = '#2c2c2e';
    if(m.includes('claude')||m.includes('anthropic')){ label='OPUS'; bg='#ff9f0a'; }
    else if(m.includes('gemini')||m.includes('google')){ label='GEM'; bg='#0a84ff'; }
    else if(m.includes('deepseek')){ label='DS'; bg='#30d158'; }
    else if(m.includes('gpt')||m.includes('openai')){ label='GPT'; bg='#bf5af2'; }
    return '<span style="display:inline-flex;align-items:center;justify-content:center;min-width:42px;height:22px;padding:0 8px;border-radius:999px;background:'+bg+';color:#fff;font-weight:700;font-size:11px;letter-spacing:0.03em">'+label+'</span>';
  }

  const taskRows = (data.recentTasks||[]).map(function(s){
    const t = new Date(s.when || Date.now()).toLocaleString('da-DK');
    const tok = (s.totalTokens === null || typeof s.totalTokens === 'undefined') ? '—' : s.totalTokens;
    const kind = s.kind === 'subagent' ? 'sub' : 'main';
    return '<tr>'+
      '<td>' + t + '</td>'+
      '<td>' + modelBadge(s.model) + '</td>'+
      '<td>' + tok + '</td>'+
      '<td>' + (s.desc || '') + '<div class="muted" style="margin-top:4px">' + kind + ' · ' + s.key + '</div></td>'+
    '</tr>';
  }).join('');
  document.getElementById('tasks').innerHTML =
    '<table>'+
      '<thead><tr><th>Tid</th><th>Model</th><th>Tokens</th><th>Opgave</th></tr></thead>'+
      '<tbody>' + taskRows + '</tbody>'+
    '</table>';
}
load();
</script>
</body>
</html>`);
});

// ===== GLOBAL ERROR HANDLER — notificerer via OpenClaw =====
app.use((err, req, res, next) => {
  const msg = `🚨 PaddockAI fejl: ${err.message}\nURL: ${req.method} ${req.url}\nBody: ${JSON.stringify(req.body || {}).slice(0, 200)}`;
  console.error('[ERROR]', msg);
  // Send til Leepster via openclaw CLI
  const { exec } = require('child_process');
  exec(`openclaw system event --text "${msg.replace(/"/g, "'")}" --mode now`, () => {});
  res.status(500).json({ error: err.message || 'Intern serverfejl' });
});

// Uncaught exceptions
process.on('uncaughtException', (err) => {
  const msg = `🚨 PaddockAI crash: ${err.message}`;
  console.error('[CRASH]', err);
  const { exec } = require('child_process');
  exec(`openclaw system event --text "${msg.replace(/"/g, "'")}" --mode now`, () => {});
});

app.listen(PORT, () => {
  console.log(`PaddockAI running on http://localhost:${PORT}`);
});
