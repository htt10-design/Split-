'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'split.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id           INTEGER PRIMARY KEY,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  from_user    INTEGER REFERENCES users(id),   -- wer zahlt (NULL = ausgeglichen)
  to_user      INTEGER REFERENCES users(id),   -- wer bekommt
  amount_cents INTEGER NOT NULL,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS expenses (
  id            INTEGER PRIMARY KEY,
  description   TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_by       INTEGER NOT NULL REFERENCES users(id),
  payer_share   INTEGER NOT NULL DEFAULT 50 CHECK (payer_share BETWEEN 0 AND 100), -- Anteil (%) den der Zahler selbst trägt
  category      TEXT NOT NULL DEFAULT 'Sonstiges',
  date          TEXT NOT NULL,              -- YYYY-MM-DD
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  settlement_id INTEGER REFERENCES settlements(id)
);

CREATE INDEX IF NOT EXISTS idx_expenses_open ON expenses(settlement_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
`);

module.exports = db;
