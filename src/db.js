import pg from 'pg';

// The platform's exact variable names aren't documented, so accept the common
// shapes: a single URL, or the PG* variables that node-postgres reads itself.
function connectionConfig(env = process.env) {
  const url = env.DATABASE_URL || env.DB_URI || env.POSTGRES_URL || env.PG_URI;
  if (url) return { connectionString: url };
  if (env.PGHOST) return {};
  const hints = Object.keys(env).filter((k) => /PG|POSTGRES|DATABASE|DB/i.test(k));
  throw new Error(
    `No database configuration found. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE. ` +
      `Database-looking variables present: ${hints.join(', ') || 'none'}`
  );
}

export const pool = new pg.Pool({ ...connectionConfig(), max: 10 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- score: guesses needed to win (1-10), or 11 for a loss or abandoned game.
-- points: 11 - score. Both are NULL while the game is in progress.
CREATE TABLE IF NOT EXISTS games (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret      SMALLINT[] NOT NULL,
  status      TEXT NOT NULL DEFAULT 'in_progress'
              CHECK (status IN ('in_progress', 'won', 'lost', 'abandoned')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  score       SMALLINT,
  points      SMALLINT
);
CREATE INDEX IF NOT EXISTS games_user_status ON games (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS games_one_active ON games (user_id) WHERE status = 'in_progress';

CREATE TABLE IF NOT EXISTS guesses (
  game_id    BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  n          SMALLINT NOT NULL,
  guess      SMALLINT[] NOT NULL,
  black      SMALLINT NOT NULL,
  white      SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, n)
);
`;

export async function migrate() {
  await pool.query(SCHEMA);
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
