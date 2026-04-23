#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
    process.exitCode = 1;
  }
}

test('Google auth route exists', () => {
  assert(source.includes("app.get('/auth/google'"), 'Missing /auth/google route');
});

test('Google callback route exists', () => {
  assert(source.includes("app.get('/auth/google/callback'"), 'Missing /auth/google/callback route');
});

test('Google callback verifies id_token or falls back to userinfo', () => {
  assert(source.includes('verifyIdToken'), 'Expected verifyIdToken call in Google callback');
  assert(source.includes('openidconnect.googleapis.com/v1/userinfo'), 'Expected Google userinfo fallback in callback');
});

test('Google callback upserts google provider user', () => {
  assert(source.includes("}, 'google');"), 'Expected Google user upsert');
});

test('Google auth requests openid email profile scopes', () => {
  assert(source.includes("scope: ['openid', 'email', 'profile']"), 'Missing expected Google scopes');
});

test('Facebook auth route exists', () => {
  assert(source.includes("app.get('/auth/facebook'"), 'Missing /auth/facebook route');
});

test('Facebook callback route exists', () => {
  assert(source.includes("app.get('/auth/facebook/callback'"), 'Missing /auth/facebook/callback route');
});

test('Facebook auth carries state and requests email scope', () => {
  assert(source.includes('state=${encodeURIComponent(state)}'), 'Expected Facebook state parameter');
  assert(source.includes('scope=email,public_profile'), 'Expected Facebook email scope');
});

test('Facebook callback upserts facebook provider user', () => {
  assert(source.includes("}, 'facebook');"), 'Expected Facebook user upsert');
});

test('Shared OAuth helpers exist for returnTo state handling', () => {
  assert(source.includes('function buildOAuthState(req)'), 'Missing buildOAuthState helper');
  assert(source.includes('function parseOAuthReturnTo(state)'), 'Missing parseOAuthReturnTo helper');
});

test('Login buttons point to auth routes with returnTo', () => {
  assert(html.includes('function loginWithGoogle()'), 'Missing loginWithGoogle function');
  assert(html.includes('/auth/google?returnTo='), 'Expected returnTo redirect to /auth/google');
  assert(html.includes('/auth/facebook?returnTo='), 'Expected returnTo redirect to /auth/facebook');
});

test('.env.example uses paddockai.net redirect', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert(envExample.includes('GOOGLE_REDIRECT_URI=https://paddockai.net/auth/google/callback'), 'Wrong Google redirect URI in .env.example');
  assert(envExample.includes('APP_URL=https://paddockai.net'), 'Wrong APP_URL in .env.example');
});

process.on('exit', () => {
  if (!process.exitCode) {
    console.log(`\nAuth regression tests passed: ${passed}`);
  }
});
