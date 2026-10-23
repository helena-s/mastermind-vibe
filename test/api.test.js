// End-to-end API test. Starts the real server against a test database and a
// fake identity provider, so token verification runs exactly as in production.
// Run with: DATABASE_URL=postgres://... npm test
// WARNING: wipes the database it is pointed at.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const DB_URL = process.env.DATABASE_URL;
const skip = DB_URL ? false : 'set DATABASE_URL to run';
const ISSUER = 'https://idp.test/realms/elastx';
const AUDIENCE = 'vibe-gateway';
const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;

let db, jwksServer, app, key, otherKey;

async function token(claims = {}, { signWith = key, iat, exp, aud = AUDIENCE, iss = ISSUER } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ name: 'Test Player', email: 'test@elastx.se', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: signWith === key ? 'test' : 'other' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt(iat ?? now)
    .setExpirationTime(exp ?? now + 300)
    .sign(signWith.privateKey);
}

function as(tok) {
  return async (path, { method = 'GET', body, headers } = {}) => {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(tok ? { 'x-auth-request-id-token': tok } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

async function startApp() {
  const proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      OIDC_ISSUER: ISSUER,
      OIDC_AUDIENCE: AUDIENCE,
      OIDC_JWKS_URL: `http://127.0.0.1:${jwksServer.address().port}/certs`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stderr.on('data', (d) => { output += d; });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { output += d; if (/listening/.test(output)) resolve(); });
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
  });
  proc.output = () => output;
  return proc;
}

before(async () => {
  if (skip) return;
  key = await generateKeyPair('RS256');
  otherKey = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  }).listen(0, '127.0.0.1');
  await once(jwksServer, 'listening');

  // Start from a v1 (password-based) schema to exercise the migration.
  db = new pg.Pool({ connectionString: DB_URL });
  await db.query('DROP TABLE IF EXISTS guesses, games, sessions, users CASCADE');
  await db.query(`CREATE TABLE users (id BIGSERIAL PRIMARY KEY, username TEXT, password_hash TEXT);
                  INSERT INTO users (username, password_hash) VALUES ('old', 'x');`);
  app = await startApp();
});

after(async () => {
  app?.kill();
  jwksServer?.close();
  await db?.end();
});

test('v1 password tables are replaced', { skip }, async () => {
  const { rows } = await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY 1"
  );
  assert.deepEqual(rows.map((r) => r.column_name), ['created_at', 'email', 'id', 'name', 'sub']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  assert.match(app.output(), /dropping v1 password-based tables/);
});

test('requests without a valid identity token are refused', { skip }, async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await as(null)('/me')).status, 401, 'no token');
  assert.equal((await as(null)('/me', { headers: { 'x-auth-request-email': 'boss@elastx.se', 'x-auth-request-user': 'x' } })).status, 401, 'plain headers alone are not trusted');
  assert.equal((await as('not.a.jwt')('/me')).status, 401, 'garbage');
  assert.equal((await as(await token({ sub: 'u1' }, { signWith: otherKey }))('/me')).status, 401, 'forged signature');
  assert.equal((await as(await token({ sub: 'u1' }, { aud: 'some-other-app' }))('/me')).status, 401, 'wrong audience');
  assert.equal((await as(await token({ sub: 'u1' }, { iss: 'https://evil.test' }))('/me')).status, 401, 'wrong issuer');
  assert.equal((await as(await token({ sub: 'u1' }, { iat: now - 9 * 86400, exp: now - 9 * 86400 + 300 }))('/me')).status, 401, 'older than a gateway session');
  assert.equal((await as(await token({}))('/me')).status, 401, 'no subject');
});

test('a gateway session token stays valid after its short expiry', { skip }, async () => {
  const now = Math.floor(Date.now() / 1000);
  const stale = await token({ sub: 'stale-user', name: 'Stale' }, { iat: now - 3600, exp: now - 3300 });
  const r = await as(stale)('/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.name, 'Stale');
});

test('first visit creates the player; name follows SSO', { skip }, async () => {
  const sub = `user-${Date.now()}`;
  let r = await as(await token({ sub, name: 'Ada Lovelace' }))('/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.name, 'Ada Lovelace');
  r = await as(await token({ sub, name: 'Ada King' }))('/me');
  assert.equal(r.body.user.name, 'Ada King');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE sub = $1', [sub]);
  assert.equal(rows[0].n, 1, 'same account, not a new player');
});

test('full game flow, scoring and stats', { skip }, async () => {
  const secretOf = async (id) => (await db.query('SELECT secret FROM games WHERE id = $1', [id])).rows[0].secret;
  const wrongFor = (secret) => secret.map((c) => (c + 1) % 6);
  const name = `Alice ${Date.now()}`;
  const alice = as(await token({ sub: `alice-${Date.now()}`, name }));

  assert.equal((await alice('/games', { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415, 'JSON only');

  // Game 1: win on guess 3 -> score 3, 8 points.
  let { body: { game } } = await alice('/games', { method: 'POST', body: {} });
  assert.equal(game.secret, undefined, 'secret hidden while playing');
  const secret = await secretOf(game.id);
  assert.equal((await alice(`/games/${game.id}/guesses`, { method: 'POST', body: { guess: [0, 1, 2] } })).status, 400);
  for (let i = 0; i < 2; i++) {
    const r = await alice(`/games/${game.id}/guesses`, { method: 'POST', body: { guess: wrongFor(secret) } });
    assert.equal(r.body.game.status, 'in_progress');
    assert.equal(r.body.game.guesses[i].black, 0);
  }
  assert.equal((await alice('/games/current')).body.game.guesses.length, 2, 'game survives a reload');
  let r = await alice(`/games/${game.id}/guesses`, { method: 'POST', body: { guess: secret } });
  assert.equal(r.body.game.status, 'won');
  assert.equal(r.body.game.score, 3);
  assert.equal(r.body.game.points, 8);
  assert.deepEqual(r.body.game.secret, secret);
  assert.equal((await alice(`/games/${game.id}/guesses`, { method: 'POST', body: { guess: secret } })).status, 409);

  // Game 2: lose -> score 11, 0 points.
  ({ body: { game } } = await alice('/games', { method: 'POST', body: {} }));
  const s2 = await secretOf(game.id);
  for (let i = 0; i < 10; i++) r = await alice(`/games/${game.id}/guesses`, { method: 'POST', body: { guess: wrongFor(s2) } });
  assert.equal(r.body.game.status, 'lost');
  assert.equal(r.body.game.score, 11);
  assert.equal(r.body.game.points, 0);

  // Game 3: abandoned by starting game 4 -> score 11, 0 points.
  ({ body: { game } } = await alice('/games', { method: 'POST', body: {} }));
  const abandonedId = game.id;
  const mallory = as(await token({ sub: `mallory-${Date.now()}`, name: 'Mallory' }));
  assert.equal((await mallory(`/games/${abandonedId}/guesses`, { method: 'POST', body: { guess: [0, 0, 0, 0] } })).status, 404, "can't play someone else's game");
  ({ body: { game } } = await alice('/games', { method: 'POST', body: {} }));
  assert.equal((await alice(`/games/${abandonedId}/guesses`, { method: 'POST', body: { guess: [0, 0, 0, 0] } })).status, 409);

  // Game 4: win on guess 1 -> 10 points.
  r = await alice(`/games/${game.id}/guesses`, { method: 'POST', body: { guess: await secretOf(game.id) } });
  assert.equal(r.body.game.points, 10);

  const { body: stats } = await alice('/stats/me');
  assert.equal(stats.summary.games, 4);
  assert.equal(stats.summary.wins, 2);
  assert.equal(stats.summary.losses, 1);
  assert.equal(stats.summary.abandoned, 1);
  assert.equal(stats.summary.avg_score, (3 + 11 + 11 + 1) / 4);
  assert.equal(stats.summary.median_score, 7);
  assert.equal(stats.summary.points, 18);
  assert.equal(stats.summary.best_score, 1);
  assert.equal(stats.histogram.length, 11);
  assert.deepEqual(stats.histogram.filter((h) => h.count).map((h) => [h.score, h.count]), [[1, 1], [3, 1], [11, 2]]);

  // Leaderboard needs 5 finished games, and shows SSO names.
  const onBoard = async () => (await alice('/leaderboard')).body.bestAverage.some((p) => p.name === name);
  assert.equal(await onBoard(), false);
  ({ body: { game } } = await alice('/games', { method: 'POST', body: {} }));
  await alice(`/games/${game.id}/guesses`, { method: 'POST', body: { guess: await secretOf(game.id) } });
  assert.equal(await onBoard(), true);
});

test('removed password endpoints are gone', { skip }, async () => {
  const alice = as(await token({ sub: 'someone' }));
  for (const path of ['/login', '/register', '/logout']) {
    assert.equal((await alice(path, { method: 'POST', body: {} })).status, 404, path);
  }
});
