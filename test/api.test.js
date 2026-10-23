// End-to-end API test against a running server.
// Run with: BASE_URL=http://localhost:8090 DATABASE_URL=postgres://... npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.BASE_URL;
const skip = !BASE || !process.env.DATABASE_URL ? 'set BASE_URL and DATABASE_URL to run' : false;

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, raw } = {}) => {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...raw },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const uniq = () => `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

test('full game flow, scoring and stats', { skip }, async () => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const secretOf = async (id) => (await db.query('SELECT secret FROM games WHERE id = $1', [id])).rows[0].secret;
  const wrongFor = (secret) => secret.map((c) => (c + 1) % 6);

  try {
    const alice = client();
    const name = uniq();

    assert.equal((await alice('/games/current')).status, 401, 'needs login');
    assert.equal((await alice('/register', { method: 'POST', body: { username: 'ab', password: 'longenough' } })).status, 400);
    assert.equal((await alice('/register', { method: 'POST', body: { username: name, password: 'short' } })).status, 400);
    assert.equal((await alice('/register', { method: 'POST', body: { username: name, password: 'password123' } })).status, 201);
    assert.equal((await client()('/register', { method: 'POST', body: { username: name.toUpperCase(), password: 'password123' } })).status, 409, 'usernames are case-insensitive unique');
    assert.equal((await client()('/login', { method: 'POST', body: { username: name, password: 'wrong-password' } })).status, 401);
    assert.equal((await client()('/login', { method: 'POST', body: { username: name.toUpperCase(), password: 'password123' } })).status, 200);
    assert.equal((await alice('/me')).body.user.username, name);
    assert.equal((await alice('/games', { method: 'POST', raw: { 'Content-Type': 'text/plain' } })).status, 415, 'JSON only');

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
    const resumed = (await alice('/games/current')).body.game;
    assert.equal(resumed.guesses.length, 2, 'game survives a reload');
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
    // Another player can't touch it.
    const mallory = client();
    await mallory('/register', { method: 'POST', body: { username: uniq(), password: 'password123' } });
    assert.equal((await mallory(`/games/${abandonedId}/guesses`, { method: 'POST', body: { guess: [0, 0, 0, 0] } })).status, 404);
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

    // Leaderboard needs 5 finished games.
    const onBoard = async () => (await alice('/leaderboard')).body.bestAverage.some((p) => p.username === name);
    assert.equal(await onBoard(), false);
    ({ body: { game } } = await alice('/games', { method: 'POST', body: {} }));
    await alice(`/games/${game.id}/guesses`, { method: 'POST', body: { guess: await secretOf(game.id) } });
    assert.equal(await onBoard(), true);

    await alice('/logout', { method: 'POST', body: {} });
    assert.equal((await alice('/games/current')).status, 401, 'logout ends the session');
  } finally {
    await db.end();
  }
});
