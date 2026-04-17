#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

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

test('Google callback verifies id_token', () => {
  assert(source.includes('verifyIdToken'), 'Expected verifyIdToken call in Google callback');
});

test('Google callback upserts google provider user', () => {
  assert(source.includes("}, 'google');"), 'Expected Google user upsert');
});

test('Google auth requests openid email profile scopes', () => {
  assert(source.includes("scope: ['openid', 'email', 'profile']"), 'Missing expected Google scopes');
});

test('Google login button points to auth route', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert(html.includes('function loginWithGoogle()'), 'Missing loginWithGoogle function');
  assert(html.includes("/auth/google?returnTo="), 'Expected returnTo redirect to /auth/google');
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
