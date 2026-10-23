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
-- One row per Elastx account; sub is the identity provider's stable user ID.
CREATE TABLE IF NOT EXISTS users (
  id         BIGSERIAL PRIMARY KEY,
  sub        TEXT NOT NULL UNIQUE,
  email      TEXT,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  const client = await pool.connect();
  try {
    // Replicas start together; only one may migrate at a time.
    await client.query('SELECT pg_advisory_lock(727001)');
    // v1 had username/password accounts. Those users can't be mapped to Elastx
    // accounts, so the old data is discarded (agreed when switching to SSO).
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_hash'`
    );
    if (rows.length) {
      console.log('migrate: dropping v1 password-based tables');
      await client.query('DROP TABLE IF EXISTS guesses, games, sessions, users CASCADE');
    }
    await client.query(SCHEMA);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
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
