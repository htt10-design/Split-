'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const CATEGORIES = ['Lebensmittel', 'Drogerie', 'Haushalt', 'Wohnen', 'Restaurant', 'Freizeit', 'Urlaub', 'Transport', 'Geschenke', 'Sonstiges'];

auth.syncUsersFromEnv();

// ---------- Hilfsfunktionen ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  return process.env.COOKIE_SECURE === '1' || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return reject(Object.assign(new Error('Content-Type muss application/json sein'), { status: 415 }));
    }
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100_000) { req.destroy(); reject(Object.assign(new Error('Zu groß'), { status: 413 })); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error('Ungültiges JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function badRequest(msg) { return Object.assign(new Error(msg), { status: 400 }); }

function validateExpense(b) {
  const description = String(b.description || '').trim();
  if (!description) throw badRequest('Beschreibung fehlt');
  if (description.length > 200) throw badRequest('Beschreibung zu lang');

  const amount = Math.round(Number(String(b.amount).replace(',', '.')) * 100);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Ungültiger Betrag');
  if (amount > 10_000_000) throw badRequest('Betrag zu groß');

  const paidBy = Number(b.paid_by);
  if (![1, 2].includes(paidBy)) throw badRequest('Ungültiger Zahler');

  const payerShare = b.payer_share === undefined ? 50 : Math.round(Number(b.payer_share));
  if (!Number.isInteger(payerShare) || payerShare < 0 || payerShare > 100) throw badRequest('Ungültige Aufteilung');

  const category = CATEGORIES.includes(b.category) ? b.category : 'Sonstiges';

  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Ungültiges Datum');

  return { description, amount, paidBy, payerShare, category, date };
}

/** Was schuldet die jeweils andere Person für diese Ausgabe? (in Cent) */
function owedByOther(e) {
  return Math.round(e.amount_cents * (100 - e.payer_share) / 100);
}

function computeBalance(expenses) {
  // net > 0  => Person 2 schuldet Person 1
  let net = 0;
  const paid = { 1: 0, 2: 0 };
  const consumed = { 1: 0, 2: 0 };
  const byCategory = {};
  for (const e of expenses) {
    const owed = owedByOther(e);
    const other = e.paid_by === 1 ? 2 : 1;
    paid[e.paid_by] += e.amount_cents;
    consumed[e.paid_by] += e.amount_cents - owed;
    consumed[other] += owed;
    net += e.paid_by === 1 ? owed : -owed;
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount_cents;
  }
  return {
    from_user: net > 0 ? 2 : net < 0 ? 1 : null,
    to_user: net > 0 ? 1 : net < 0 ? 2 : null,
    amount_cents: Math.abs(net),
    paid,
    consumed,
    total_cents: paid[1] + paid[2],
    by_category: byCategory,
    count: expenses.length,
  };
}

const openExpenses = () => db.prepare('SELECT * FROM expenses WHERE settlement_id IS NULL ORDER BY date DESC, id DESC').all();

// ---------- Statische Dateien ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA-Fallback
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
        if (err2) return send(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const cookies = parseCookies(req);

  if (route === 'POST /api/login') {
    const body = await readJson(req);
    const result = auth.login(body.name, body.password, clientIp(req));
    if (result.error) return send(res, result.status, { error: result.error });
    const secure = isHttps(req) ? '; Secure' : '';
    return send(res, 200, { user: result.user }, {
      'Set-Cookie': `sid=${result.session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${result.session.maxAge}${secure}`,
    });
  }

  const user = auth.getSessionUser(cookies.sid);
  if (!user) return send(res, 401, { error: 'Nicht angemeldet' });

  if (route === 'POST /api/logout') {
    auth.deleteSession(cookies.sid);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  if (route === 'GET /api/me') {
    const users = db.prepare('SELECT id, name FROM users ORDER BY id').all();
    return send(res, 200, { user, users, categories: CATEGORIES });
  }

  if (route === 'GET /api/overview') {
    const expenses = openExpenses();
    return send(res, 200, { expenses, balance: computeBalance(expenses) });
  }

  if (route === 'POST /api/expenses') {
    const e = validateExpense(await readJson(req));
    const r = db.prepare(`
      INSERT INTO expenses (description, amount_cents, paid_by, payer_share, category, date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e.description, e.amount, e.paidBy, e.payerShare, e.category, e.date, user.id);
    return send(res, 201, db.prepare('SELECT * FROM expenses WHERE id = ?').get(r.lastInsertRowid));
  }

  const m = url.pathname.match(/^\/api\/expenses\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!existing) return send(res, 404, { error: 'Nicht gefunden' });
    if (existing.settlement_id) return send(res, 409, { error: 'Bereits abgerechnete Ausgaben können nicht geändert werden' });

    if (req.method === 'PUT') {
      const e = validateExpense(await readJson(req));
      db.prepare(`
        UPDATE expenses SET description = ?, amount_cents = ?, paid_by = ?, payer_share = ?, category = ?, date = ?
        WHERE id = ?
      `).run(e.description, e.amount, e.paidBy, e.payerShare, e.category, e.date, id);
      return send(res, 200, db.prepare('SELECT * FROM expenses WHERE id = ?').get(id));
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  if (route === 'POST /api/settle') {
    const body = await readJson(req);
    const expenses = openExpenses();
    if (expenses.length === 0) return send(res, 400, { error: 'Keine offenen Ausgaben' });
    const b = computeBalance(expenses);
    db.exec('BEGIN');
    try {
      const r = db.prepare(`
        INSERT INTO settlements (created_by, from_user, to_user, amount_cents, note) VALUES (?, ?, ?, ?, ?)
      `).run(user.id, b.from_user, b.to_user, b.amount_cents, String(body.note || '').slice(0, 200) || null);
      db.prepare('UPDATE expenses SET settlement_id = ? WHERE settlement_id IS NULL').run(r.lastInsertRowid);
      db.exec('COMMIT');
      return send(res, 201, { id: Number(r.lastInsertRowid), ...b });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (route === 'GET /api/settlements') {
    const rows = db.prepare(`
      SELECT s.*, COUNT(e.id) AS count, COALESCE(SUM(e.amount_cents), 0) AS total_cents,
             MIN(e.date) AS first_date, MAX(e.date) AS last_date
      FROM settlements s LEFT JOIN expenses e ON e.settlement_id = s.id
      GROUP BY s.id ORDER BY s.id DESC
    `).all();
    return send(res, 200, rows);
  }

  const sm = url.pathname.match(/^\/api\/settlements\/(\d+)$/);
  if (req.method === 'GET' && sm) {
    const id = Number(sm[1]);
    const settlement = db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
    if (!settlement) return send(res, 404, { error: 'Nicht gefunden' });
    const expenses = db.prepare('SELECT * FROM expenses WHERE settlement_id = ? ORDER BY date DESC, id DESC').all(id);
    return send(res, 200, { settlement, expenses, balance: computeBalance(expenses) });
  }

  if (route === 'GET /api/export.csv') {
    const users = Object.fromEntries(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    const rows = db.prepare('SELECT * FROM expenses ORDER BY date, id').all();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Datum', 'Beschreibung', 'Kategorie', 'Betrag', 'Bezahlt von', 'Anteil Zahler %', 'Abrechnung'].map(esc).join(';')];
    for (const e of rows) {
      lines.push([e.date, e.description, e.category, (e.amount_cents / 100).toFixed(2).replace('.', ','),
        users[e.paid_by], e.payer_share, e.settlement_id ?? 'offen'].map(esc).join(';'));
    }
    return send(res, 200, '﻿' + lines.join('\r\n'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="split-export.csv"',
    });
  }

  return send(res, 404, { error: 'Unbekannte Route' });
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'");

  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Serverfehler' : err.message });
  }
});

// Abgelaufene Sessions regelmäßig aufräumen
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600_000).unref();

server.listen(PORT, () => console.log(`Split läuft auf http://localhost:${PORT}`));
