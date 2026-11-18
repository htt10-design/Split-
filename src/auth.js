'use strict';
const crypto = require('node:crypto');
const db = require('./db');

const SESSION_DAYS = 180;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Legt die beiden Benutzer aus den Umgebungsvariablen an bzw. aktualisiert
 * deren Passwort, falls es sich geändert hat.
 */
function syncUsersFromEnv() {
  const defs = [
    { id: 1, name: process.env.USER1_NAME, password: process.env.USER1_PASSWORD },
    { id: 2, name: process.env.USER2_NAME, password: process.env.USER2_PASSWORD },
  ];
  for (const u of defs) {
    if (!u.name || !u.password) {
      throw new Error(`USER${u.id}_NAME und USER${u.id}_PASSWORD müssen gesetzt sein (siehe .env.example)`);
    }
    if (u.password.length < 8) {
      throw new Error(`USER${u.id}_PASSWORD muss mindestens 8 Zeichen lang sein`);
    }
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    if (!existing) {
      db.prepare('INSERT INTO users (id, name, password_hash) VALUES (?, ?, ?)').run(u.id, u.name, hashPassword(u.password));
    } else {
      if (existing.name !== u.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(u.name, u.id);
      if (!verifyPassword(u.password, existing.password_hash)) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(u.password), u.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); // alte Logins ungültig machen
      }
    }
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, maxAge: SESSION_DAYS * 24 * 3600 };
}

function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, name: row.name };
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Einfacher Brute-Force-Schutz: max. 10 Fehlversuche pro IP in 15 Minuten
const failed = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const entry = failed.get(ip);
  if (!entry || now - entry.first > 15 * 60 * 1000) return true;
  return entry.count < 10;
}
function registerFailure(ip) {
  const now = Date.now();
  const entry = failed.get(ip);
  if (!entry || now - entry.first > 15 * 60 * 1000) failed.set(ip, { first: now, count: 1 });
  else entry.count++;
}

function login(name, password, ip) {
  if (!loginAllowed(ip)) return { error: 'Zu viele Fehlversuche – bitte 15 Minuten warten.', status: 429 };
  const user = db.prepare('SELECT * FROM users WHERE lower(name) = lower(?)').get(String(name || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    registerFailure(ip);
    return { error: 'Name oder Passwort falsch.', status: 401 };
  }
  failed.delete(ip);
  return { user: { id: user.id, name: user.name }, session: createSession(user.id) };
}

module.exports = { syncUsersFromEnv, getSessionUser, deleteSession, login };
