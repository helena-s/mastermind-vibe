import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, migrate, tx } from './db.js';
import { identify, TOKEN_HEADER } from './auth.js';
import {
  CODE_LENGTH, COLOURS, MAX_GUESSES, LOSS_SCORE,
  newSecret, isValidGuess, scoreGuess, pointsFor,
} from './game.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;
const LEADERBOARD_MIN_GAMES = 5;

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  });
  next();
});

// State-changing requests must be JSON. Browsers can't send that cross-site
// without a CORS preflight, which together with SameSite cookies covers CSRF.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Expected application/json' });
  }
  next();
});

// Wrap async handlers so a rejected promise reaches the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Who is calling: the Elastx account the gateway logged in. The first visit
// creates the player; later visits keep name and email in sync with SSO.
app.use('/api', h(async (req, res, next) => {
  let identity;
  try {
    identity = await identify(req.get(TOKEN_HEADER));
  } catch (err) {
    console.warn(`identity check failed: ${err.code || ''} ${err.message}`);
    return res.status(401).json({ error: 'Could not confirm your Elastx login. Try reloading the page.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO users (sub, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       WHERE users.email IS DISTINCT FROM EXCLUDED.email OR users.name IS DISTINCT FROM EXCLUDED.name
     RETURNING id, name`,
    [identity.sub, identity.email, identity.name]
  );
  // RETURNING is empty when nothing changed, so fall back to a lookup.
  req.user = rows[0] || (await pool.query('SELECT id, name FROM users WHERE sub = $1', [identity.sub])).rows[0];
  next();
}));

app.get('/api/me', (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/config', (req, res) => {
  res.json({ codeLength: CODE_LENGTH, colours: COLOURS, maxGuesses: MAX_GUESSES, lossScore: LOSS_SCORE });
});

// --- Games ---
async function gameView(db, game) {
  const { rows: guesses } = await db.query(
    'SELECT n, guess, black, white FROM guesses WHERE game_id = $1 ORDER BY n',
    [game.id]
  );
  const finished = game.status !== 'in_progress';
  return {
    id: game.id,
    status: game.status,
    startedAt: game.started_at,
    finishedAt: game.finished_at,
    score: game.score,
    points: game.points,
    guesses,
    secret: finished ? game.secret : undefined,
    serverNow: new Date().toISOString(),
  };
}

app.get('/api/games/current', h(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM games WHERE user_id = $1 AND status = 'in_progress'",
    [req.user.id]
  );
  res.json({ game: rows[0] ? await gameView(pool, rows[0]) : null });
}));

// Starting a new game abandons any unfinished one; it counts as a loss.
app.post('/api/games', h(async (req, res) => {
  const game = await tx(async (db) => {
    // Serialise per user so two quick clicks can't race on the active-game index.
    await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    await db.query(
      `UPDATE games SET status = 'abandoned', finished_at = now(), score = $2, points = 0
       WHERE user_id = $1 AND status = 'in_progress'`,
      [req.user.id, LOSS_SCORE]
    );
    const { rows } = await db.query(
      'INSERT INTO games (user_id, secret) VALUES ($1, $2) RETURNING *',
      [req.user.id, newSecret()]
    );
    return gameView(db, rows[0]);
  });
  res.status(201).json({ game });
}));

app.post('/api/games/:id/guesses', h(async (req, res) => {
  const guess = req.body?.guess;
  if (!isValidGuess(guess)) {
    return res.status(400).json({ error: `A guess is ${CODE_LENGTH} colours, each 0–${COLOURS - 1}` });
  }
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'No such game' });

  const result = await tx(async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM games WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, req.user.id]
    );
    const game = rows[0];
    if (!game) return { status: 404, body: { error: 'No such game' } };
    if (game.status !== 'in_progress') return { status: 409, body: { error: 'This game is over' } };

    const { rows: [{ count }] } = await db.query(
      'SELECT count(*)::int AS count FROM guesses WHERE game_id = $1',
      [game.id]
    );
    const n = count + 1;
    const { black, white } = scoreGuess(game.secret, guess);
    await db.query(
      'INSERT INTO guesses (game_id, n, guess, black, white) VALUES ($1, $2, $3, $4, $5)',
      [game.id, n, guess, black, white]
    );

    let finished;
    if (black === CODE_LENGTH) finished = { status: 'won', score: n };
    else if (n >= MAX_GUESSES) finished = { status: 'lost', score: LOSS_SCORE };
    if (finished) {
      const { rows: [updated] } = await db.query(
        `UPDATE games SET status = $2, score = $3, points = $4, finished_at = now()
         WHERE id = $1 RETURNING *`,
        [game.id, finished.status, finished.score, pointsFor(finished.score)]
      );
      return { status: 200, body: { game: await gameView(db, updated) } };
    }
    return { status: 200, body: { game: await gameView(db, game) } };
  });
  res.status(result.status).json(result.body);
}));

// --- Stats ---
const FINISHED = "status IN ('won', 'lost', 'abandoned')";

app.get('/api/stats/me', h(async (req, res) => {
  const uid = req.user.id;
  const { rows: [summary] } = await pool.query(
    `SELECT count(*)::int AS games,
            count(*) FILTER (WHERE status = 'won')::int AS wins,
            count(*) FILTER (WHERE status = 'lost')::int AS losses,
            count(*) FILTER (WHERE status = 'abandoned')::int AS abandoned,
            avg(score)::float8 AS avg_score,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY score)::float8 AS median_score,
            coalesce(sum(points), 0)::int AS points,
            min(score) FILTER (WHERE status = 'won')::int AS best_score,
            avg(extract(epoch FROM finished_at - started_at)) FILTER (WHERE status = 'won')::float8 AS avg_win_seconds,
            min(extract(epoch FROM finished_at - started_at)) FILTER (WHERE status = 'won')::float8 AS fastest_win_seconds
     FROM games WHERE user_id = $1 AND ${FINISHED}`,
    [uid]
  );
  const { rows: hist } = await pool.query(
    `SELECT s AS score, count(g.id)::int AS count
     FROM generate_series(1, $2::int) s
     LEFT JOIN games g ON g.score = s AND g.user_id = $1 AND g.${FINISHED}
     GROUP BY s ORDER BY s`,
    [uid, LOSS_SCORE]
  );
  const { rows: recent } = await pool.query(
    `SELECT id, status, score, points, finished_at,
            extract(epoch FROM finished_at - started_at)::float8 AS seconds
     FROM games WHERE user_id = $1 AND ${FINISHED}
     ORDER BY finished_at DESC LIMIT 10`,
    [uid]
  );
  res.json({ summary, histogram: hist, recent });
}));

app.get('/api/leaderboard', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.name,
            count(*)::int AS games,
            count(*) FILTER (WHERE g.status = 'won')::int AS wins,
            avg(g.score)::float8 AS avg_score,
            sum(g.points)::int AS points,
            min(g.score) FILTER (WHERE g.status = 'won')::int AS best_score
     FROM games g JOIN users u ON u.id = g.user_id
     WHERE g.${FINISHED}
     GROUP BY u.id, u.name
     HAVING count(*) >= $1`,
    [LEADERBOARD_MIN_GAMES]
  );
  const top = (sorted) => sorted.slice(0, 10);
  res.json({
    minGames: LEADERBOARD_MIN_GAMES,
    me: req.user.id,
    bestAverage: top([...rows].sort((a, b) => a.avg_score - b.avg_score || b.games - a.games)),
    mostPoints: top([...rows].sort((a, b) => b.points - a.points || a.avg_score - b.avg_score)),
  });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// --- Static frontend ---
app.use('/fonts', express.static(join(root, 'node_modules/@fontsource/poppins/files'), { maxAge: '30d', immutable: true }));
app.use(express.static(join(root, 'public'), { maxAge: '5m' }));
app.get('/healthz', (req, res) => res.send('ok'));
app.get('*', (req, res) => res.sendFile(join(root, 'public/index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

await migrate();

const server = app.listen(PORT, () => console.log(`mastermind listening on :${PORT}`));

// Running as PID 1 in a container: Node won't exit on SIGTERM unless told to.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
