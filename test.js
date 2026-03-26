#!/usr/bin/env node
/**
 * PaddockAI — Automatisk testsuite
 * Kør: node test.js [BASE_URL]
 */

const BASE = process.argv[2] || 'https://web-production-83b1b3.up.railway.app';
const https = require('https');
const http = require('http');

let passed = 0, failed = 0, warned = 0;
const results = [];

// ===== HTTP HELPER =====
function request(method, path, body = null, expectJson = true) {
  return new Promise((resolve) => {
    const url = new URL(BASE + path);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 10000,
    };
    if (body) {
      const b = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(b);
    }
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: expectJson ? JSON.parse(data) : data, raw: data });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'Timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ===== TEST HELPERS =====
function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    results.push({ status: '✅', name, detail });
  } else {
    failed++;
    results.push({ status: '❌', name, detail: detail || 'FEJL' });
  }
}

function warn(name, detail) {
  warned++;
  results.push({ status: '⚠️ ', name, detail });
}

// ===== TESTS =====
async function run() {
  console.log(`\n🐴 PaddockAI Testsuite`);
  console.log(`📡 Target: ${BASE}`);
  console.log(`${'─'.repeat(60)}\n`);

  const testEmail = `test_${Date.now()}@paddockai.com`;

  // --- 1. FORSIDE ---
  console.log('[ Forside & statiske filer ]');
  const home = await request('GET', '/', null, false);
  ok('Forside svarer 200', home.status === 200, `Status: ${home.status}`);
  ok('Forside er HTML', home.raw?.includes('<html'), 'Mangler <html>');
  ok('App titel korrekt', home.raw?.includes('PaddockAI'), 'PaddockAI ikke i HTML');

  const css = await request('GET', '/style.css', null, false);
  ok('style.css tilgængelig', css.status === 200, `Status: ${css.status}`);

  const manifest = await request('GET', '/manifest.json');
  ok('manifest.json tilgængelig', manifest.status === 200, `Status: ${manifest.status}`);
  ok('manifest.json har korrekt navn', manifest.body?.name === 'PaddockAI', `navn: ${manifest.body?.name}`);

  const sw = await request('GET', '/sw.js', null, false);
  ok('Service worker tilgængelig', sw.status === 200, `Status: ${sw.status}`);

  // --- 2. BRUGER API ---
  console.log('\n[ Bruger API ]');

  // Opret ny bruger
  const createUser = await request('POST', '/api/users', { name: 'Test Træner', email: testEmail });
  ok('Opret bruger returnerer 200', createUser.status === 200, `Status: ${createUser.status}`);
  ok('Bruger har id', !!createUser.body?.id, `id: ${createUser.body?.id}`);
  ok('Bruger har korrekt email', createUser.body?.email === testEmail, `email: ${createUser.body?.email}`);
  ok('Bruger starter på free plan', createUser.body?.plan === 'free', `plan: ${createUser.body?.plan}`);
  ok('Bruger har createdAt', !!createUser.body?.createdAt, `createdAt: ${createUser.body?.createdAt}`);

  // Login eksisterende bruger (samme email)
  const loginUser = await request('POST', '/api/users', { name: 'Test Træner', email: testEmail });
  ok('Login eksisterende bruger virker', loginUser.status === 200, `Status: ${loginUser.status}`);
  ok('Samme bruger returneres', loginUser.body?.id === createUser.body?.id, 'Forskelligt id ved genfund');

  // Hent bruger
  const getUser = await request('GET', `/api/users/${encodeURIComponent(testEmail)}`);
  ok('GET /api/users/:email virker', getUser.status === 200, `Status: ${getUser.status}`);
  ok('Korrekt bruger returneres', getUser.body?.email === testEmail, `email: ${getUser.body?.email}`);

  // Ukendt bruger
  const notFound = await request('GET', '/api/users/ingen@test.com');
  ok('404 for ukendt bruger', notFound.status === 404, `Status: ${notFound.status}`);

  // Manglende felter
  const badUser = await request('POST', '/api/users', { name: 'Ingen email' });
  ok('400 ved manglende email', badUser.status === 400, `Status: ${badUser.status}`);

  // --- 3. LISTER API ---
  console.log('\n[ Lister API ]');

  const allLists = await request('GET', '/api/lists');
  ok('GET /api/lists svarer 200', allLists.status === 200, `Status: ${allLists.status}`);
  ok('Lister er et array', Array.isArray(allLists.body), `Type: ${typeof allLists.body}`);

  // Tjek ingen undefined i liste
  const hasUndefined = Array.isArray(allLists.body) && allLists.body.some(l => !l.id || l.id === 'undefined');
  ok('Ingen undefined i liste', !hasUndefined, hasUndefined ? `Undefined lister fundet: ${JSON.stringify(allLists.body?.filter(l => !l.id))}` : 'OK');

  // Hent ukendt liste
  const badList = await request('GET', '/api/lists/ikke-eksisterende-id');
  ok('404 for ukendt liste', badList.status === 404, `Status: ${badList.status}`);

  // --- 4. STÆVNER (EQUIPE API) ---
  console.log('\n[ Equipe Stævne API ]');

  const shows = await request('GET', '/api/shows');
  ok('GET /api/shows svarer 200', shows.status === 200, `Status: ${shows.status}`);
  ok('Stævner er et array', Array.isArray(shows.body), `Type: ${typeof shows.body}`);
  ok('Mindst 10 stævner', (shows.body?.length || 0) >= 10, `Antal: ${shows.body?.length}`);
  ok('Stævner har navn', shows.body?.[0]?.name, `Første: ${shows.body?.[0]?.name}`);
  ok('Stævner har id', shows.body?.[0]?.id, `id: ${shows.body?.[0]?.id}`);

  if (shows.body?.length > 0) {
    const firstShow = shows.body[0];
    const showDetail = await request('GET', `/api/shows/${firstShow.id}`);
    ok('GET /api/shows/:id svarer 200', showDetail.status === 200, `Status: ${showDetail.status}`);

    // Ryttere for første stævne
    const riders = await request('GET', `/api/shows/${firstShow.id}/riders`);
    ok('GET ryttere svarer 200', riders.status === 200, `Status: ${riders.status}`);
    ok('Ryttere er et array', Array.isArray(riders.body), `Type: ${typeof riders.body}`);
    if (Array.isArray(riders.body) && riders.body.length > 0) {
      ok('Rytter har navn', !!riders.body[0]?.name, `Første: ${riders.body[0]?.name}`);
    } else {
      warn('Ingen ryttere i første stævne', `Stævne: ${firstShow.name}`);
    }
  }

  // Stævnesøgning
  const searchShows = await request('GET', '/api/shows?q=spring');
  ok('Søgning på stævner virker', searchShows.status === 200, `Status: ${searchShows.status}`);

  // --- 5. PERFORMANCE ---
  console.log('\n[ Performance ]');

  const t1 = Date.now();
  await request('GET', '/');
  const homeTime = Date.now() - t1;
  ok('Forside under 3 sek', homeTime < 3000, `${homeTime}ms`);
  if (homeTime > 1000) warn('Forside langsom', `${homeTime}ms — overvej caching`);

  const t2 = Date.now();
  await request('GET', '/api/shows');
  const showsTime = Date.now() - t2;
  ok('Stævner API under 5 sek', showsTime < 5000, `${showsTime}ms`);
  if (showsTime > 2000) warn('Stævner API langsom', `${showsTime}ms — Equipe API kan være træg`);

  // --- 6. SIKKERHED ---
  console.log('\n[ Sikkerhed & Edge Cases ]');

  // XSS forsøg
  const xssUser = await request('POST', '/api/users', { name: '<script>alert(1)</script>', email: `xss_${Date.now()}@test.com` });
  ok('XSS i navn håndteres', xssUser.status === 200 || xssUser.status === 400, `Status: ${xssUser.status}`);

  // Tom body
  const emptyBody = await request('POST', '/api/users', {});
  ok('Tom body giver 400', emptyBody.status === 400, `Status: ${emptyBody.status}`);

  // ===== RESULTAT =====
  console.log(`\n${'─'.repeat(60)}`);
  for (const r of results) {
    const detail = r.detail ? ` — ${r.detail}` : '';
    console.log(`  ${r.status} ${r.name}${detail}`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Bestået:  ${passed}`);
  console.log(`  Fejlet:   ${failed}`);
  console.log(`  Advarsler: ${warned}`);
  console.log(`${'─'.repeat(60)}\n`);

  if (failed > 0) {
    console.log(`❌ ${failed} test(s) fejlede\n`);
    process.exit(1);
  } else {
    console.log(`✅ Alle tests bestået!\n`);
  }
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
