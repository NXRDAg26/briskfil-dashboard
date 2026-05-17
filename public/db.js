// ─────────────────────────────────────────────────────────────────────────────
// db.js — Postgres connection and schema for the Briskfil dashboard
//
// Uses Neon (or any Postgres provider) via the DATABASE_URL env var.
// On boot the schema is created if it does not already exist.
// ─────────────────────────────────────────────────────────────────────────────

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Add it as an environment variable on Render.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon and most hosted Postgres providers require SSL
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=disable')
    ? false
    : { rejectUnauthorized: false }
});

// Single client slug for this deployment. Change CLIENT_SLUG when spinning up
// the same dashboard for another client (Earl Kendrick, Archway, etc.) — every
// row is scoped by this value so data never crosses clients.
const CLIENT = process.env.CLIENT_SLUG || 'briskfil';

async function initSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      client TEXT NOT NULL DEFAULT 'briskfil',
      title TEXT,
      copy TEXT,
      format TEXT,
      status TEXT,
      date TEXT,
      time TEXT,
      hashtags TEXT,
      link TEXT,
      notes TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_posts_client ON posts(client);

    CREATE TABLE IF NOT EXISTS tech_checklist (
      client TEXT NOT NULL,
      item_id TEXT NOT NULL,
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (client, item_id)
    );

    CREATE TABLE IF NOT EXISTS bf_actions (
      client TEXT NOT NULL,
      action_id TEXT NOT NULL,
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (client, action_id)
    );

    CREATE TABLE IF NOT EXISTS copy_clients (
      id TEXT PRIMARY KEY,
      client TEXT NOT NULL DEFAULT 'briskfil',
      name TEXT NOT NULL,
      sector TEXT,
      description TEXT,
      audience TEXT,
      proof TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_copy_clients_client ON copy_clients(client);

    CREATE TABLE IF NOT EXISTS copy_history (
      id TEXT PRIMARY KEY,
      client TEXT NOT NULL DEFAULT 'briskfil',
      copy_client_name TEXT,
      format TEXT,
      topic TEXT,
      lang TEXT,
      en TEXT,
      pt TEXT,
      date TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_copy_history_client ON copy_history(client);

    CREATE TABLE IF NOT EXISTS ai_visibility (
      id BIGINT PRIMARY KEY,
      client TEXT NOT NULL DEFAULT 'briskfil',
      platform TEXT,
      query TEXT,
      cited BOOLEAN,
      notes TEXT,
      date TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_visibility_client ON ai_visibility(client);

    CREATE TABLE IF NOT EXISTS linkedin_log (
      id BIGINT PRIMARY KEY,
      client TEXT NOT NULL DEFAULT 'briskfil',
      type TEXT,
      topic TEXT,
      impressions INTEGER,
      engagement REAL,
      followers INTEGER,
      date TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_linkedin_log_client ON linkedin_log(client);
  `;

  try {
    await pool.query(sql);
    console.log('Schema initialised on client slug:', CLIENT);
  } catch (err) {
    console.error('Schema init error:', err.message);
    throw err;
  }
}

module.exports = { pool, initSchema, CLIENT };
