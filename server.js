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
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const OPENCLAW_SESSIONS_DIR = path.join(process.env.HOME || '', '.openclaw', 'agents', 'main', 'sessions');
const EQUIPE_BASE = 'https://online.equipe.com';

app.use(express.json());

// Set proper MIME type for manifest.json
express.static.mime.define({'application/manifest+json': ['webmanifest', 'json']});

app.use(express.static(path.join(__dirname, 'public')));

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Helper: fetch JSON from Equipe API
async function equipeGet(apiPath) {
  const url = `${EQUIPE_BASE}${apiPath}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'EquipeFilmlist/1.0' }
  });
  if (!res.ok) throw new Error(`Equipe API ${res.status}: ${url}`);
  return res.json();
}

// GET /api/shows - Danish shows
app.get('/api/shows', async (req, res) => {
  try {
    const meetings = await equipeGet('/api/v1/meetings/recent');
    const danish = meetings.filter(m => m.venue_country === 'DEN');
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

// GET /api/shows/:id/riders - All riders in a show (aggregated from all class sections)
app.get('/api/shows/:id/riders', async (req, res) => {
  try {
    const schedule = await equipeGet(`/api/v1/meetings/${req.params.id}/schedule`);
    const classSectionIds = [];
    for (const mc of (schedule.meeting_classes || [])) {
      for (const cs of (mc.class_sections || [])) {
        classSectionIds.push({ csId: cs.id, mcName: mc.name, mcClassNo: mc.class_no, mcDate: mc.date, mcStartAt: mc.start_at });
      }
    }

    // Fetch all class sections in parallel (batched)
    const ridersMap = {}; // rider_id -> { name, club, entries: [...] }
    const BATCH = 10;
    for (let i = 0; i < classSectionIds.length; i += BATCH) {
      const batch = classSectionIds.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async ({ csId, mcName, mcClassNo, mcDate, mcStartAt }) => {
          try {
            const csData = await equipeGet(`/api/v1/class_sections/${csId}`);
            return { csId, mcName, mcClassNo, mcDate, mcStartAt, starts: csData.starts || [] };
          } catch {
            return { csId, mcName, mcClassNo, mcDate, mcStartAt, starts: [] };
          }
        })
      );
      for (const { csId, mcName, mcClassNo, mcDate, mcStartAt, starts } of results) {
        for (const s of starts) {
          const rid = s.rider_id;
          if (!rid) continue;
          if (!ridersMap[rid]) {
            ridersMap[rid] = {
              id: rid,
              name: s.rider_name,
              club: s.club_name,
              entries: []
            };
          }
          ridersMap[rid].entries.push({
            classSectionId: csId,
            className: mcName,
            classNo: mcClassNo,
            date: mcDate,
            classStartAt: mcStartAt,
            startNo: s.start_no,
            startAt: s.start_at,
            horseName: s.horse_name,
            combinationNo: s.horse_combination_no
          });
        }
      }
    }

    const riders = Object.values(ridersMap).sort((a, b) => a.name.localeCompare(b.name, 'da'));
    res.json(riders);
  } catch (err) {
    console.error('Error fetching riders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/lists - Create film list
app.post('/api/lists', (req, res) => {
  try {
    const { showId, showName, startDate, endDate, riderIds } = req.body;
    const id = crypto.randomUUID();
    const list = {
      id,
      showId,
      showName,
      startDate,
      endDate,
      riderIds: riderIds || [],
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify(list, null, 2));
    res.json(list);
  } catch (err) {
    console.error('Error creating list:', err.message);
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
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lists/:id/schedule - Get the formatted schedule for a film list
app.get('/api/lists/:id/schedule', async (req, res) => {
  try {
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const riderIdSet = new Set(list.riderIds.map(Number));

    // Get schedule
    const schedule = await equipeGet(`/api/v1/meetings/${list.showId}/schedule`);

    // For each class section, get starts and filter for our riders
    const dayMap = {}; // date -> [ { time, className, classNo, riders: [...] } ]

    for (const mc of (schedule.meeting_classes || [])) {
      for (const cs of (mc.class_sections || [])) {
        let csData;
        try {
          csData = await equipeGet(`/api/v1/class_sections/${cs.id}`);
        } catch { continue; }

        const matchingStarts = (csData.starts || []).filter(s => riderIdSet.has(s.rider_id));
        if (matchingStarts.length === 0) continue;

        const date = mc.date || 'unknown';
        if (!dayMap[date]) dayMap[date] = [];

        dayMap[date].push({
          time: mc.start_at,
          className: mc.name,
          classNo: mc.class_no,
          classSectionId: cs.id,
          riders: matchingStarts.map(s => ({
            startNo: s.start_no || s.horse_combination_no,
            riderName: s.rider_name,
            horseName: s.horse_name,
            startAt: s.start_at
          })).sort((a, b) => (a.startNo || 0) - (b.startNo || 0))
        });
      }
    }

    // Sort each day's classes by time
    for (const d of Object.keys(dayMap)) {
      dayMap[d].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    }

    res.json({
      showName: schedule.display_name || schedule.name,
      startDate: schedule.start_on,
      endDate: schedule.end_on,
      schedule: dayMap
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

app.listen(PORT, () => {
  console.log(`Equipe Filmlist running on http://localhost:${PORT}`);
});
