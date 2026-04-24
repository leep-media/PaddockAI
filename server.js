const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const { google } = require('googleapis');

const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'paddockai2026';
const ADMIN_SESSION_COOKIE = 'paddockai_admin';

// ===== Convex HTTP Client (Direct fetch — dropped broken ESM library) =====
let convexInitError = null;
const CONVEX_URL = process.env.CONVEX_URL || 'https://blessed-lemur-987.eu-west-1.convex.cloud';

async function convexQuery(path, args = {}) {
  if (!CONVEX_URL) { convexInitError = 'No CONVEX_URL'; return null; }
  try {
    const resp = await fetch(`${CONVEX_URL}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, args })
    });
    if (!resp.ok) {
      const text = await resp.text();
      convexInitError = `HTTP ${resp.status}: ${text.substring(0,200)}`;
      return null;
    }
    const json = await resp.json();
    return json.value !== undefined ? json.value : json;
  } catch (e) {
    convexInitError = `convexQuery error: ${e.message}`;
    return null;
  }
}

async function convexMutation(path, args = {}) {
  if (!CONVEX_URL) { convexInitError = 'No CONVEX_URL'; return null; }
  try {
    const resp = await fetch(`${CONVEX_URL}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, args })
    });
    if (!resp.ok) {
      const text = await resp.text();
      convexInitError = `HTTP ${resp.status}: ${text.substring(0,200)}`;
      return null;
    }
    const json = await resp.json();
    return json.value !== undefined ? json.value : json;
  } catch (e) {
    convexInitError = `convexMutation error: ${e.message}`;
    return null;
  }
}

function getConvex() {
  return CONVEX_URL ? { query: convexQuery, mutation: convexMutation } : null;
}

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

async function upgradeToPro(email, subscriptionId) {
  // Opdater i Convex hvis tilgængeligt
  const c = getConvex();
  if (c) {
    await c.mutation("users:updatePlan", { email, plan: 'pro', subscriptionId: subscriptionId || '' });
  } else {
    // JSON fallback
    const users = loadUsers();
    const u = users.find(u => u.email === email.toLowerCase());
    if (u) { u.plan = 'pro'; u.subscriptionId = subscriptionId; saveUsers(users); }
  }
}

async function downgradeFromPro(subscriptionId) {
  const c = getConvex();
  if (c) {
    await c.mutation("users:downgradeBySubscription", { subscriptionId });
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
// På Railway: brug /data volume hvis tilgængeligt, ellers lokal data/
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
  : path.join(__dirname, 'data');
const OPENCLAW_SESSIONS_DIR = path.join(process.env.HOME || '', '.openclaw', 'agents', 'main', 'sessions');
const EQUIPE_BASE = 'https://online.equipe.com';

// POST /api/stripe-webhook — Stripe webhook
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Betaling ikke konfigureret' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.metadata?.email || session.customer_email;
    if (email) {
      // Opdater bruger til PRO i Convex eller JSON
      await upgradeToPro(email, session.subscription);
    }
  }
  
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    // Downgrade bruger — find via subscription ID
    await downgradeFromPro(sub.id);
  }
  
  res.json({ received: true });
});

app.use(express.json());

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const idx = part.indexOf('=');
    return idx === -1 ? [part, ''] : [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
  }));
}

function isAdminSessionValid(req) {
  const cookies = parseCookies(req);
  const expected = crypto.createHash('sha256').update(`${ADMIN_USER}:${ADMIN_PASSWORD}`).digest('hex');
  return cookies[ADMIN_SESSION_COOKIE] === expected;
}

function setAdminSession(res) {
  const value = crypto.createHash('sha256').update(`${ADMIN_USER}:${ADMIN_PASSWORD}`).digest('hex');
  res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 12}`);
}

function clearAdminSession(res) {
  res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

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

function getAppBaseUrl(req) {
  const configured = process.env.APP_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  const proto = req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http';
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || `localhost:${PORT}`;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function buildGoogleOAuthClient(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${getAppBaseUrl(req)}/auth/google/callback`;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function buildFacebookRedirectUri(req) {
  return `${getAppBaseUrl(req)}/auth/facebook/callback`;
}

function buildOAuthState(req) {
  const statePayload = {
    returnTo: typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/') ? req.query.returnTo : '/',
    nonce: crypto.randomBytes(16).toString('hex')
  };
  return Buffer.from(JSON.stringify(statePayload)).toString('base64url');
}

function parseOAuthReturnTo(state) {
  let returnTo = '/';
  if (typeof state === 'string') {
    try {
      const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
      if (parsed?.returnTo && String(parsed.returnTo).startsWith('/')) returnTo = String(parsed.returnTo);
    } catch {}
  }
  return returnTo;
}

function upsertJsonUserFromProvider(profile, provider) {
  const users = loadUsers();
  const email = String(profile.email || '').toLowerCase();
  if (!email) throw new Error(`${provider} login kræver en email`);

  let user = users.find(u => u.email === email);
  const name = profile.name || profile.given_name || email.split('@')[0];
  const avatarData = profile.picture || profile.avatarUrl || null;
  const providerId = profile.sub || profile.id || '';

  if (user) {
    user.name = user.name || name;
    if (provider === 'google') user.googleId = user.googleId || providerId;
    if (provider === 'facebook') user.facebookId = user.facebookId || providerId;
    if (provider === 'apple') user.appleId = user.appleId || providerId;
    user.authProvider = user.authProvider || provider;
    if (avatarData && !user.avatarData) user.avatarData = avatarData;
  } else {
    user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash: null,
      authProvider: provider,
      googleId: provider === 'google' ? providerId : null,
      facebookId: provider === 'facebook' ? providerId : null,
      appleId: provider === 'apple' ? providerId : null,
      avatarData,
      plan: 'free',
      createdAt: new Date().toISOString()
    };
    users.push(user);
  }

  saveUsers(users);
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

async function upsertUserFromProviderProfile(profile, provider) {
  const email = String(profile.email || '').toLowerCase();
  if (!email) throw new Error(`${provider} login kræver en email`);

  if (getConvex()) {
    const user = await getConvex().mutation("users:upsert", {
      name: profile.name || profile.given_name || email.split('@')[0],
      email,
      avatarData: profile.picture || profile.avatarUrl || undefined,
      googleId: provider === 'google' ? (profile.sub || undefined) : undefined,
      facebookId: provider === 'facebook' ? (profile.id || undefined) : undefined,
      appleId: provider === 'apple' ? (profile.sub || undefined) : undefined,
      authProvider: provider
    });
    return user;
  }

  return upsertJsonUserFromProvider(profile, provider);
}

// POST /api/users — create or find user
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, passwordHash, login } = req.body;
    if (!email) return res.status(400).json({ error: 'Email er påkrævet' });
    if (!login && !name) return res.status(400).json({ error: 'Navn er påkrævet ved oprettelse' });

    // Convex path (note: Convex doesn't have passwordHash logic yet, falling back to JSON for this feature)
    if (getConvex() && !passwordHash) {
      const user = await getConvex().mutation("users:upsert", { name, email });
      return res.json(user);
    }

    // JSON fallback
    const users = loadUsers();
    const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    
    if (existing) {
      // Validate password if user has one
      if (existing.passwordHash) {
        if (!passwordHash) return res.status(401).json({ error: 'Password påkrævet' });
        if (existing.passwordHash !== passwordHash) return res.status(401).json({ error: 'Forkert password' });
      } else if (passwordHash) {
        // First time setting password for legacy user
        existing.passwordHash = passwordHash;
      }
      
      if (name && existing.name !== name) { 
        existing.name = name; 
      }
      saveUsers(users);
      const { passwordHash: _, ...safeExisting } = existing;
      return res.json(safeExisting);
    }
    
    if (login) return res.status(404).json({ error: 'Bruger ikke fundet' });

    const user = {
      id: crypto.randomUUID(),
      name,
      email: email.toLowerCase(),
      passwordHash: passwordHash || null,
      plan: 'free',
      createdAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers(users);
    const { passwordHash: __, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/google
app.get('/auth/google', async (req, res) => {
  try {
    const oauth2Client = buildGoogleOAuthClient(req);
    if (!oauth2Client) return res.redirect('/?auth_error=google_not_configured');

    const state = buildOAuthState(req);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('Google auth start error:', err.message);
    res.redirect('/?auth_error=google_start_failed');
  }
});

// GET /auth/google/callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const oauth2Client = buildGoogleOAuthClient(req);
    if (!oauth2Client) return res.redirect('/?auth_error=google_not_configured');

    const { code, state, error } = req.query;
    if (error) return res.redirect(`/?auth_error=${encodeURIComponent(String(error))}`);
    if (!code) return res.redirect('/?auth_error=missing_google_code');

    const returnTo = parseOAuthReturnTo(state);

    const { tokens } = await oauth2Client.getToken(String(code));
    oauth2Client.setCredentials(tokens);

    let payload = null;
    if (tokens.id_token) {
      const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    }

    if (!payload?.email && tokens.access_token) {
      const userInfoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!userInfoRes.ok) {
        throw new Error(`Google userinfo fejlede (${userInfoRes.status})`);
      }
      payload = await userInfoRes.json();
    }

    if (!payload?.email) throw new Error('Google profile mangler email');

    const user = await upsertUserFromProviderProfile({
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      given_name: payload.given_name,
      picture: payload.picture,
    }, 'google');

    const userPayload = Buffer.from(JSON.stringify(user)).toString('base64url');
    const sep = returnTo.includes('?') ? '&' : '?';
    res.redirect(`${returnTo}${sep}auth_success=google&user=${encodeURIComponent(userPayload)}`);
  } catch (err) {
    console.error('Google callback error:', err.message, err.stack || '');
    res.redirect('/?auth_error=google_login_failed');
  }
});

// GET /auth/facebook
app.get('/auth/facebook', (req, res) => {
  const appId = process.env.FACEBOOK_APP_ID || '';
  if (!appId) return res.redirect('/?auth_error=facebook_not_configured');

  const redirectUri = encodeURIComponent(buildFacebookRedirectUri(req));
  const state = buildOAuthState(req);
  res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}&scope=email,public_profile`);
});

// GET /auth/facebook/callback
app.get('/auth/facebook/callback', async (req, res) => {
  try {
    const { code, state, error, error_reason, error_description } = req.query;
    const returnTo = parseOAuthReturnTo(state);

    if (error) {
      const authError = String(error_reason || error_description || error);
      return res.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}auth_error=${encodeURIComponent(authError)}`);
    }
    if (!code) return res.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}auth_error=missing_facebook_code`);

    const appId = process.env.FACEBOOK_APP_ID || '';
    const appSecret = process.env.FACEBOOK_APP_SECRET || '';
    if (!appId || !appSecret) return res.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}auth_error=facebook_not_configured`);

    const redirectUri = buildFacebookRedirectUri(req);

    const tokenRes = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(String(code))}`);
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
      throw new Error(tokenData?.error?.message || `Facebook token fejlede (${tokenRes.status})`);
    }

    const profileRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(tokenData.access_token)}`);
    const profile = await profileRes.json();
    if (!profileRes.ok || profile.error) {
      throw new Error(profile?.error?.message || `Facebook profile fejlede (${profileRes.status})`);
    }
    if (!profile.email) {
      throw new Error('Facebook profile mangler email. Tjek at appen har email-tilladelse og at kontoen deler email.');
    }

    const user = await upsertUserFromProviderProfile({
      id: profile.id,
      name: profile.name,
      email: profile.email,
      picture: profile.picture?.data?.url
    }, 'facebook');

    const payload = Buffer.from(JSON.stringify(user)).toString('base64url');
    const sep = returnTo.includes('?') ? '&' : '?';
    res.redirect(`${returnTo}${sep}auth_success=facebook&user=${encodeURIComponent(payload)}`);
  } catch (err) {
    console.error('Facebook callback error:', err.message, err.stack || '');
    res.redirect('/?auth_error=facebook_login_failed');
  }
});


// GET /api/users/:email — get user by email
app.get('/api/users/:email', async (req, res) => {
  try {
    // Convex path
    if (getConvex()) {
      const user = await getConvex().query("users:getByEmail", { email: req.params.email });
      if (!user) return res.status(404).json({ error: 'Bruger ikke fundet' });
      return res.json(user);
    }

    // JSON fallback
    const users = loadUsers();
    const user = users.find(u => u.email.toLowerCase() === req.params.email.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Bruger ikke fundet' });
    
    // Don't send password hash to client
    const { passwordHash, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/:email — update user (plan, name)
app.patch('/api/users/:email', async (req, res) => {
  try {
    // Convex path
    if (getConvex()) {
      const user = await getConvex().mutation("users:updatePlan", {
        email: req.params.email,
        plan: req.body.plan || 'free'
      });
      return res.json(user);
    }

    // JSON fallback
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

// POST /api/checkout — opret Stripe checkout session
app.post('/api/checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Betaling ikke konfigureret endnu' });
    }
    const { email } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'dkk',
          product_data: { name: 'PaddockAI PRO', description: 'Ubegrænsede hold, push-notifikationer og meget mere' },
          recurring: { interval: 'month' },
          unit_amount: 4900, // 49 kr
        },
        quantity: 1,
      }],
      success_url: `${process.env.APP_URL || 'https://web-production-83b1b3.up.railway.app'}/?pro_success=1`,
      cancel_url: `${process.env.APP_URL || 'https://web-production-83b1b3.up.railway.app'}/?pro_cancel=1`,
      metadata: { email },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function renderAdminLogin(error = '') {
  return `<!DOCTYPE html>
<html lang="da">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PaddockAI Admin Login</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif; background:#0c0c0e; color:#ede9e0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { width:100%; max-width:420px; background:#161618; border:1px solid #2a2a2d; border-radius:24px; padding:28px; box-shadow:0 20px 60px rgba(0,0,0,.35); }
    h1 { margin:0 0 8px; font-size:2rem; }
    p { margin:0 0 22px; color:#8a8578; }
    label { display:block; margin:0 0 6px; font-size:.82rem; color:#8a8578; text-transform:uppercase; letter-spacing:.04em; font-weight:600; }
    input { width:100%; box-sizing:border-box; margin:0 0 14px; padding:12px 16px; border-radius:12px; border:1px solid #2a2a2d; background:#1e1e21; color:#ede9e0; font-size:1rem; }
    button { width:100%; padding:12px 16px; border:0; border-radius:12px; background:#c9a96e; color:#0c0c0e; font-weight:700; font-size:1rem; cursor:pointer; }
    .error { margin:0 0 16px; padding:12px 14px; border-radius:12px; background:rgba(184,92,92,.12); border:1px solid rgba(184,92,92,.35); color:#ffb4b4; }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/admin/login">
    <h1>Admin login</h1>
    <p>Log ind for at administrere PaddockAI.</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <label for="username">Brugernavn</label>
    <input id="username" name="username" autocomplete="username" required>
    <label for="password">Kodeord</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Log ind</button>
  </form>
</body>
</html>`;
}

// Middleware til admin routes
function requireAdmin(req, res, next) {
  if (isAdminSessionValid(req)) return next();
  return res.status(401).send(renderAdminLogin());
}

app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    setAdminSession(res);
    return res.redirect('/admin');
  }
  return res.status(401).send(renderAdminLogin('Forkert brugernavn eller kodeord.'));
});

app.post('/admin/logout', (req, res) => {
  clearAdminSession(res);
  res.redirect('/admin');
});

// GET /admin — admin panel
app.get('/admin', requireAdmin, async (req, res) => {
  // Hent alle brugere
  let users = [];
  const c = getConvex();
  if (c) {
    users = await c.query("users:getAll");
  } else {
    users = loadUsers();
  }
  
  const roadmap = loadRoadmap();
  const html = `<!DOCTYPE html>
<html lang="da">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<title>PaddockAI Admin</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0c0c0e; color: #f5f5f7; padding: 24px; max-width: 960px; margin: 0 auto; }
  h1 { color: #c9a96e; margin-bottom: 4px; }
  h2 { color: #c9a96e; margin: 40px 0 16px; font-size: 1.2rem; }
  nav { display: flex; gap: 16px; margin-bottom: 32px; border-bottom: 1px solid #2c2c2e; padding-bottom: 12px; }
  nav a { color: #86868b; text-decoration: none; font-size: 0.9rem; }
  nav a:hover { color: #f5f5f7; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #2c2c2e; font-size: 0.9rem; }
  th { color: #86868b; font-size: 0.75rem; text-transform: uppercase; }
  .badge-pro { background: linear-gradient(135deg, #c9a96e, #a0783c); color: #000; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 700; }
  .badge-free { background: #2c2c2e; color: #86868b; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
  .btn { padding: 6px 14px; border-radius: 8px; border: none; cursor: pointer; font-size: 0.82rem; font-weight: 500; }
  .btn-upgrade { background: #c9a96e; color: #000; }
  .btn-downgrade { background: #3a3a3c; color: #86868b; }
  .btn-delete { background: #3a1a1a; color: #ff453a; }
  .btn-add { background: #c9a96e; color: #000; padding: 10px 20px; font-size: 0.9rem; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
  .stat { background: #1c1c1e; padding: 16px 20px; border-radius: 12px; }
  .stat-num { font-size: 2rem; font-weight: 700; color: #c9a96e; }
  .stat-label { color: #86868b; font-size: 0.82rem; margin-top: 2px; }
  .roadmap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; margin-top: 16px; }
  .roadmap-card { background: #1c1c1e; border-radius: 12px; padding: 16px 18px; position: relative; }
  .roadmap-card h3 { margin: 0 0 6px; font-size: 0.95rem; color: #f5f5f7; padding-right: 32px; }
  .roadmap-card p { margin: 0; font-size: 0.82rem; color: #86868b; line-height: 1.5; }
  .roadmap-card .source { font-size: 0.7rem; color: #48484a; margin-top: 8px; }
  .roadmap-card form { position: absolute; top: 12px; right: 12px; }
  .roadmap-card .btn-delete { padding: 4px 8px; font-size: 0.75rem; }
  .add-form { background: #1c1c1e; border-radius: 12px; padding: 20px; margin-top: 16px; }
  .add-form input, .add-form textarea { width: 100%; background: #2c2c2e; border: 1px solid #3a3a3c; border-radius: 8px; color: #f5f5f7; padding: 10px 12px; font-size: 0.9rem; box-sizing: border-box; margin-bottom: 10px; font-family: inherit; }
  .add-form textarea { height: 80px; resize: vertical; }
  .add-form label { font-size: 0.8rem; color: #86868b; display: block; margin-bottom: 4px; }
</style>
</head>
<body>
<div style="display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap;">
  <div>
    <h1>🐴 PaddockAI Admin</h1>
  </div>
  <form method="POST" action="/admin/logout" style="margin:0;">
    <button class="btn" type="submit">Log ud</button>
  </form>
</div>
<nav>
  <a href="#users">Brugere</a>
  <a href="#roadmap">Roadmap</a>
</nav>
<div class="stats">
  <div class="stat"><div class="stat-num">${users.length}</div><div class="stat-label">Brugere i alt</div></div>
  <div class="stat"><div class="stat-num">${users.filter(u => u.plan === 'pro').length}</div><div class="stat-label">PRO brugere</div></div>
  <div class="stat"><div class="stat-num">${users.filter(u => u.plan === 'free').length}</div><div class="stat-label">Gratis brugere</div></div>
</div>
<h2 id="users">👥 Brugere (${users.length})</h2>
<table>
  <tr><th>Navn</th><th>Email</th><th>Plan</th><th>Oprettet</th><th>Handling</th></tr>
  ${users.map(u => `
  <tr>
    <td>${u.name}</td>
    <td>${u.email}</td>
    <td><span class="badge-${u.plan}">${u.plan.toUpperCase()}</span></td>
    <td>${new Date(u.createdAt).toLocaleDateString('da-DK')}</td>
    <td>
      ${u.plan === 'free' 
        ? `<form method="POST" action="/admin/upgrade" style="display:inline"><input type="hidden" name="email" value="${u.email}"><button class="btn btn-upgrade">→ PRO gratis</button></form>`
        : `<form method="POST" action="/admin/downgrade" style="display:inline"><input type="hidden" name="email" value="${u.email}"><button class="btn btn-downgrade">→ Gratis</button></form>`
      }
    </td>
  </tr>`).join('')}
</table>

  <!-- ROADMAP -->
  <h2 id="roadmap">📋 Roadmap (${roadmap.length} features)</h2>
  <div class="roadmap-grid">
    ${roadmap.map(item => `
    <div class="roadmap-card">
      <form method="POST" action="/admin/roadmap/delete">
        <input type="hidden" name="id" value="${item.id}">
        <button class="btn btn-delete" title="Fjern">✕</button>
      </form>
      <h3>${item.title}</h3>
      <p>${item.description}</p>
      <div class="source">Tilføjet: ${new Date(item.createdAt).toLocaleDateString('da-DK')} · ${item.source}</div>
    </div>`).join('')}
  </div>

  <div class="add-form">
    <h3 style="margin: 0 0 16px; font-size: 1rem;">+ Tilføj ny feature</h3>
    <form method="POST" action="/admin/roadmap/add">
      <label>Titel</label>
      <input type="text" name="title" placeholder="f.eks. Notifikationer ved klasseændring" required>
      <label>Beskrivelse</label>
      <textarea name="description" placeholder="Beskriv hvad featuren gør og hvorfor den er nyttig..."></textarea>
      <label>Kilde (valgfrit)</label>
      <input type="text" name="source" placeholder="f.eks. Dan / bruger-feedback / idé">
      <button type="submit" class="btn btn-add">Tilføj til roadmap</button>
    </form>
  </div>

</body>
</html>`;
  res.send(html);
});

// ===== ROADMAP STORAGE =====
const ROADMAP_FILE = path.join(DATA_DIR, 'roadmap.json');

function loadRoadmap() {
  try {
    if (fs.existsSync(ROADMAP_FILE)) return JSON.parse(fs.readFileSync(ROADMAP_FILE, 'utf8'));
  } catch {}
  return [
    { id: '1', title: 'Google & Apple login', description: 'Log ind med din Google- eller Apple-konto i stedet for email + password.', source: 'leepster', createdAt: new Date().toISOString() },
    { id: '2', title: 'Push-notifikationer', description: 'Få besked på telefonen 20 og 5 minutter før en rytter starter. PRO-feature.', source: 'leepster', createdAt: new Date().toISOString() },
    { id: '3', title: 'Mine heste', description: 'Opret profiler for dine heste med vaccinationer, skoprogram, sundhedslogbog og billeder.', source: 'leepster', createdAt: new Date().toISOString() },
    { id: '4', title: 'Kalender & stævneoversigt', description: 'Se alle kommende stævner du er tilmeldt i én samlet kalender med notifikationer.', source: 'leepster', createdAt: new Date().toISOString() },
    { id: '5', title: 'Del med rytter', description: 'Send din rytter et link med deres personlige startplan — de ser kun deres egne tider.', source: 'leepster', createdAt: new Date().toISOString() },
    { id: '6', title: 'Eksportér til PDF', description: 'Download startplanen som PDF — perfekt til print eller deling.', source: 'leepster', createdAt: new Date().toISOString() },
    { id: '7', title: 'Multi-stævne overblik', description: 'Træner flere ryttere på samme dag på forskellige stævner? Se dem alle i ét overblik.', source: 'leepster', createdAt: new Date().toISOString() },
    { id: '8', title: 'Træningslogbog', description: 'Log træninger, noter og fremskridt for dine ryttere og heste over tid.', source: 'leepster', createdAt: new Date().toISOString() },
    { id: '9', title: 'Automatisk klasseskema-opdatering', description: 'Appen henter automatisk ændringer i startlisten og notificerer dig hvis din rytters tid ændrer sig.', source: 'leepster', createdAt: new Date().toISOString() },
    { id: '10', title: 'Stallregnskab', description: 'Hold styr på udgifter og indtægter for stald og heste — foder, dyrlæge, stævner m.m.', source: 'leepster', createdAt: new Date().toISOString() },
  ];
}

function saveRoadmap(items) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ROADMAP_FILE, JSON.stringify(items, null, 2));
}

// POST /admin/roadmap/add
app.post('/admin/roadmap/add', requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
  const { title, description, source } = req.body;
  if (!title) return res.redirect('/admin#roadmap');
  const items = loadRoadmap();
  items.push({ id: Date.now().toString(), title, description: description || '', source: source || 'admin', createdAt: new Date().toISOString() });
  saveRoadmap(items);
  res.redirect('/admin#roadmap');
});

// POST /admin/roadmap/delete
app.post('/admin/roadmap/delete', requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  const { id } = req.body;
  const items = loadRoadmap().filter(i => i.id !== id);
  saveRoadmap(items);
  res.redirect('/admin#roadmap');
});

// POST /admin/upgrade — giv gratis PRO
app.post('/admin/upgrade', requireAdmin, express.urlencoded({ extended: false }), async (req, res) => {
  const { email } = req.body;
  await upgradeToPro(email, 'manual');
  res.redirect('/admin');
});

// POST /admin/downgrade — fjern PRO
app.post('/admin/downgrade', requireAdmin, express.urlencoded({ extended: false }), async (req, res) => {
  const { email } = req.body;
  const c = getConvex();
  if (c) {
    await c.mutation("users:updatePlan", { email, plan: 'free', subscriptionId: '' });
  } else {
    const users = loadUsers();
    const u = users.find(u => u.email === email.toLowerCase());
    if (u) { u.plan = 'free'; delete u.subscriptionId; saveUsers(users); }
  }
  res.redirect('/admin');
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

// Express 5 no longer exposes express.static.mime, and modern setups already
// serve .webmanifest correctly enough for our use here.
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
          entryKey: `${csId}:${s.start_no || ''}:${s.horse_combination_no || ''}:${s.position || ''}`,
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
app.post('/api/lists', async (req, res) => {
  try {
    const { showId, showName, startDate, endDate, riderIds, selections, listName, userId, email } = req.body;

    // Convex path
    if (getConvex()) {
      let ownerId = userId;
      if (!ownerId && email) {
        const owner = await getConvex().query("users:getByEmail", { email });
        ownerId = owner?._id;
      }
      const list = await getConvex().mutation("lists:create", {
        userId: ownerId,
        showId, showName,
        listName: listName || showName,
        startDate, endDate,
        riderIds: riderIds || [],
        selections: selections || undefined,
      });
      return res.json(list);
    }

    // JSON fallback
    const id = crypto.randomUUID();
    const list = {
      id,
      userId: userId || null,
      email: email ? String(email).toLowerCase() : null,
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

    // GET /api/debug - Debug info
app.get('/api/debug', (req, res) => {
  try {
    const convex = getConvex();
    res.json({
      hasConvex: !!convex,
      convexUrl: process.env.CONVEX_URL || '(not set)',
      initError: convexInitError,
      hasFs: typeof fs === 'object',
      dataDir: DATA_DIR,
      filesInDir: fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'))
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

    // GET /api/lists - Saved lists for current user
app.get('/api/lists', async (req, res) => {
  try {
    const convex = getConvex();
    const userId = req.query.userId ? String(req.query.userId) : '';
    let email = req.query.email ? String(req.query.email).toLowerCase() : '';

    // Convex path
    if (convex) {
      const allLists = await convex.query("lists:getAll", {});
      
      return res.json(allLists.map(l => ({
        id: l._id,
        listName: l.listName || l.showName,
        showName: l.showName,
        startDate: l.startDate,
        endDate: l.endDate,
        riderCount: (l.riderIds || []).length,
        createdAt: l.createdAt
      })));
    }

    // JSON fallback
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const allLists = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; }
    })
    .filter(l => l && l.id && l.showId && typeof l.showId === 'string');

    let lists = allLists.filter(l => {
      if (userId && l.userId) return l.userId === userId;
      if (email && l.email) return (l.email || '').toLowerCase() === email;
      return false;
    });

    if (!lists.length && email) {
      lists = allLists.filter(l => !l.userId && !l.email);
    }

    lists = lists.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json(lists.map(l => ({ id: l.id, listName: l.listName || l.showName, showName: l.showName, startDate: l.startDate, endDate: l.endDate, riderCount: (l.riderIds || []).length, createdAt: l.createdAt })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/lists/:id - Rename list
app.patch('/api/lists/:id', async (req, res) => {
  try {
    // Convex path
    if (getConvex()) {
      const list = await getConvex().mutation("lists:rename", {
        id: req.params.id,
        listName: req.body.listName || ''
      });
      return res.json(list);
    }

    // JSON fallback
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
app.delete('/api/lists/:id', async (req, res) => {
  try {
    // Convex path
    if (getConvex()) {
      await getConvex().mutation("lists:remove", { id: req.params.id });
      return res.json({ ok: true });
    }

    // JSON fallback
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lists/:id - Get film list
app.get('/api/lists/:id', async (req, res) => {
  try {
    // Convex path
    if (getConvex()) {
      const list = await getConvex().query("lists:getById", { id: req.params.id });
      if (!list) return res.status(404).json({ error: 'List not found' });
      return res.json({ ...list, id: list._id });
    }

    // JSON fallback
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/lists/:id/riders - Update riders in list
app.put('/api/lists/:id/riders', async (req, res) => {
  try {
    const riderIds = req.body.riderIds || [];
    const selections = req.body.selections;

    // Convex path
    if (getConvex()) {
      const list = await getConvex().mutation("lists:updateRiders", {
        id: req.params.id,
        riderIds,
        selections: selections !== undefined ? selections : undefined,
      });
      notifyListClients(req.params.id, 'riders-updated', { riderIds: list.riderIds, selections: list.selections });
      return res.json({ ...list, id: list._id });
    }

    // JSON fallback
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    list.riderIds = riderIds;
    if (selections !== undefined) list.selections = selections;
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    notifyListClients(req.params.id, 'riders-updated', { riderIds: list.riderIds, selections: list.selections });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/lists/:id/share - Generate share token
app.post('/api/lists/:id/share', async (req, res) => {
  try {
    // Convex path
    if (getConvex()) {
      // Check if list already has a share token
      const existing = await getConvex().query("lists:getById", { id: req.params.id });
      if (!existing) return res.status(404).json({ error: 'List not found' });
      if (existing.shareToken) {
        return res.json({ shareToken: existing.shareToken, listId: existing._id });
      }
      const token = crypto.randomBytes(6).toString('base64url');
      const list = await getConvex().mutation("lists:addShareToken", { id: req.params.id, token });
      return res.json({ shareToken: list.shareToken, listId: list._id });
    }

    // JSON fallback
    const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!list.shareToken) {
      list.shareToken = crypto.randomBytes(6).toString('base64url');
    }
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    res.json({ shareToken: list.shareToken, listId: list.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shared/:token - Resolve share token to list
app.get('/api/shared/:token', async (req, res) => {
  try {
    // Convex path
    if (getConvex()) {
      const list = await getConvex().query("lists:getByShareToken", { token: req.params.token });
      if (!list) return res.status(404).json({ error: 'Delt liste ikke fundet' });
      return res.json({ listId: list._id });
    }

    // JSON fallback
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
    let list;
    if (getConvex()) {
      list = await getConvex().query("lists:getById", { id: req.params.id });
      if (!list) return res.status(404).json({ error: 'List not found' });
      list.id = list._id; // normalize
    } else {
      const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'List not found' });
      list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
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
