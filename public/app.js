'use strict';

/* =====================================================================
   Split – Frontend für PocketBase
   Collections: split_groups, split_members, split_expenses, split_settlements
   ===================================================================== */

const CFG = Object.assign({ apiUrl: '', authCollection: 'users' }, window.SPLIT_CONFIG || {});
const API = CFG.apiUrl.replace(/\/+$/, '');
const AUTH_KEY = 'split_auth';

const $ = (sel) => document.querySelector(sel);
const state = {
  token: null, me: null,          // eingeloggter PocketBase-User
  group: null,                    // aktueller Haushalt (split_groups)
  members: [],                    // [{ user, display_name }] – genau 2
  categories: ['Lebensmittel', 'Drogerie', 'Haushalt', 'Wohnen', 'Restaurant', 'Freizeit', 'Urlaub', 'Transport', 'Geschenke', 'Sonstiges'],
  expenses: [], balance: null, editing: null,
};

const CAT_ICONS = {
  Lebensmittel: '🛒', Drogerie: '🧴', Haushalt: '🏠', Wohnen: '🛋️', Restaurant: '🍽️',
  Freizeit: '🎬', Urlaub: '✈️', Transport: '🚗', Geschenke: '🎁', Sonstiges: '📦',
};

// ---------- Hilfsfunktionen ----------

const eur = (cents) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const userName = (id) => state.members.find((m) => m.user === id)?.display_name ?? '?';
const otherId = (id) => state.members.find((m) => m.user !== id)?.user;
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD lokal
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const q = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; // Wert für PocketBase-Filter
const owedByOther = (e) => Math.round(e.amount_cents * (100 - (e.payer_share ?? 0)) / 100);

function newId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  if (iso === today()) return 'Heute';
  if (iso === new Date(Date.now() - 86400000).toLocaleDateString('sv-SE')) return 'Gestern';
  return d.toLocaleDateString('de-DE', {
    weekday: 'short', day: 'numeric', month: 'long',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ---------- PocketBase-Client (minimal, ohne SDK) ----------

class ApiError extends Error {
  constructor(status, data) {
    const fieldMsgs = Object.entries(data?.data || {}).map(([k, v]) => `${k}: ${v.message}`);
    super([data?.message, ...fieldMsgs].filter(Boolean).join(' – ') || `Fehler ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function pb(method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(state.token ? { Authorization: state.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { message: 'Server nicht erreichbar – Internetverbindung prüfen.' });
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { logout(); throw new ApiError(401, { message: 'Bitte erneut anmelden.' }); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Alle Datensätze einer Collection laden (über alle Seiten). */
async function listAll(collection, { filter = '', sort = '', fields = '', expand = '' } = {}) {
  const items = [];
  for (let page = 1; ; page++) {
    const p = new URLSearchParams({ page, perPage: 500, skipTotal: 1 });
    if (filter) p.set('filter', filter);
    if (sort) p.set('sort', sort);
    if (fields) p.set('fields', fields);
    if (expand) p.set('expand', expand);
    const r = await pb('GET', `/api/collections/${collection}/records?${p}`);
    items.push(...r.items);
    if (r.items.length < 500) return items;
  }
}

const rec = {
  create: (c, body) => pb('POST', `/api/collections/${c}/records`, body),
  update: (c, id, body) => pb('PATCH', `/api/collections/${c}/records/${id}`, body),
  remove: (c, id) => pb('DELETE', `/api/collections/${c}/records/${id}`),
};

// ---------- Realtime (Live-Aktualisierung, wenn die andere Person etwas einträgt) ----------

const live = {
  es: null,
  start() {
    this.stop();
    if (!window.EventSource) return;
    const es = new EventSource(API + '/api/realtime');
    this.es = es;
    es.addEventListener('PB_CONNECT', async (ev) => {
      try {
        const { clientId } = JSON.parse(ev.data);
        await pb('POST', '/api/realtime', { clientId, subscriptions: ['split_expenses/*', 'split_settlements/*'] });
        $('#live').classList.add('on');
      } catch { $('#live').classList.remove('on'); }
    });
    const onChange = () => {
      clearTimeout(this._t);
      this._t = setTimeout(() => {
        if (!$('#tab-open').classList.contains('hidden')) loadOverview().catch(() => {});
        else if (!$('#tab-history').classList.contains('hidden')) loadHistory().catch(() => {});
      }, 300);
    };
    es.addEventListener('split_expenses/*', onChange);
    es.addEventListener('split_settlements/*', onChange);
    es.onerror = () => $('#live').classList.remove('on'); // EventSource verbindet sich selbst neu
  },
  stop() {
    if (this.es) this.es.close();
    this.es = null;
    $('#live').classList.remove('on');
  },
};

// ---------- Login ----------

function saveAuth(token, record) {
  state.token = token;
  state.me = record;
  try { localStorage.setItem(AUTH_KEY, JSON.stringify({ token, record })); } catch {}
}

function logout() {
  state.token = null;
  state.me = null;
  try { localStorage.removeItem(AUTH_KEY); } catch {}
  live.stop();
  $('#menu').classList.add('hidden');
  $('#view-app').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    const r = await pb('POST', `/api/collections/${CFG.authCollection}/auth-with-password`, {
      identity: String(f.get('identity')).trim(), password: f.get('password'),
    });
    saveAuth(r.token, r.record);
    ev.target.reset();
    await startApp();
  } catch (e) {
    err.textContent = e.status === 400 ? 'E-Mail oder Passwort falsch.' : e.message;
    err.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', logout);
$('#menu-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); });
document.addEventListener('click', () => $('#menu').classList.add('hidden'));

// ---------- Saldo ----------

function computeBalance(expenses) {
  const [a, b] = state.members.map((m) => m.user);
  let net = 0; // > 0: b schuldet a
  const paid = { [a]: 0, [b]: 0 };
  const consumed = { [a]: 0, [b]: 0 };
  const byCategory = {};
  for (const e of expenses) {
    const owed = owedByOther(e);
    const other = e.paid_by === a ? b : a;
    paid[e.paid_by] = (paid[e.paid_by] || 0) + e.amount_cents;
    consumed[e.paid_by] = (consumed[e.paid_by] || 0) + e.amount_cents - owed;
    consumed[other] = (consumed[other] || 0) + owed;
    net += e.paid_by === a ? owed : -owed;
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount_cents;
  }
  return {
    from_user: net > 0 ? b : net < 0 ? a : null,
    to_user: net > 0 ? a : net < 0 ? b : null,
    amount_cents: Math.abs(net),
    paid, consumed, by_category: byCategory,
    total_cents: expenses.reduce((s, e) => s + e.amount_cents, 0),
    count: expenses.length,
  };
}

// ---------- Rendering ----------

function renderBalance(el, b, { settled = false } = {}) {
  el.classList.toggle('even', !b.from_user);
  if (!b.from_user) {
    el.innerHTML = `
      <div class="label">${settled ? 'Abrechnung' : 'Aktueller Stand'}</div>
      <div class="amount">Ausgeglichen</div>
      <div class="sub">${b.count ? `${b.count} Ausgaben · ${eur(b.total_cents)} gesamt` : 'Noch keine offenen Ausgaben'}</div>`;
    return;
  }
  const iOwe = b.from_user === state.me.id;
  const label = settled
    ? `${esc(userName(b.from_user))} zahlte an ${esc(userName(b.to_user))}`
    : iOwe ? `Du schuldest ${esc(userName(b.to_user))}` : `${esc(userName(b.from_user))} schuldet dir`;
  el.innerHTML = `
    <div class="label">${label}</div>
    <div class="amount">${eur(b.amount_cents)}</div>
    <div class="sub">${b.count} Ausgaben · ${eur(b.total_cents)} gesamt</div>`;
}

function renderStats(el, b) {
  if (!b.count) { el.innerHTML = ''; return; }
  const cats = Object.entries(b.by_category).sort((x, y) => y[1] - x[1]);
  const max = cats[0]?.[1] || 1;
  el.innerHTML = `
    ${state.members.map((m) => `
      <div class="stat">
        <div class="k">${esc(m.display_name)} hat bezahlt</div>
        <div class="v">${eur(b.paid[m.user] || 0)}</div>
        <div class="k">Anteil: ${eur(b.consumed[m.user] || 0)}</div>
      </div>`).join('')}
    <div class="stat wide">
      <div class="k">Nach Kategorie</div>
      <div class="cat-bars">
        ${cats.map(([c, v]) => `
          <div class="cat-row">
            <span>${CAT_ICONS[c] || ''} ${esc(c)}</span>
            <span class="bar"><i data-w="${(v / max) * 100}"></i></span>
            <span class="num">${eur(v)}</span>
          </div>`).join('')}
      </div>
    </div>`;
  el.querySelectorAll('.bar > i').forEach((i) => { i.style.width = i.dataset.w + '%'; });
}

function renderExpenses(el, expenses, { editable }) {
  el.classList.toggle('settled', !editable);
  if (!expenses.length) {
    el.innerHTML = `<li class="empty">${editable ? 'Noch nichts eingetragen.<br>Tippe auf ＋ um loszulegen.' : 'Keine Ausgaben.'}</li>`;
    return;
  }
  let html = '';
  let lastDate = null;
  for (const e of expenses) {
    if (e.date !== lastDate) {
      html += `<li class="day-head">${esc(fmtDate(e.date))}</li>`;
      lastDate = e.date;
    }
    const owed = owedByOther(e);
    const iPaid = e.paid_by === state.me.id;
    const shareTxt = owed > 0 ? (iPaid ? `bekommst ${eur(owed)}` : `schuldest ${eur(owed)}`) : 'nur für Zahler';
    const shareCls = owed > 0 ? (iPaid ? 'pos' : 'neg') : '';
    const share = e.payer_share ?? 0;
    const splitTxt = share === 50 ? '50/50' : share === 0 ? `nur für ${userName(otherId(e.paid_by))}` : `${share}/${100 - share}`;
    html += `
      <li class="expense" data-id="${esc(e.id)}">
        <div class="ico">${CAT_ICONS[e.category] || '📦'}</div>
        <div class="mid">
          <div class="title">${esc(e.description)}</div>
          <div class="meta">${esc(userName(e.paid_by))} · ${esc(splitTxt)}</div>
        </div>
        <div class="right">
          <div class="amt">${eur(e.amount_cents)}</div>
          <div class="share ${shareCls}">${shareTxt}</div>
        </div>
      </li>`;
  }
  el.innerHTML = html;
  if (editable) {
    el.querySelectorAll('.expense').forEach((li) => {
      li.addEventListener('click', () => openSheet(state.expenses.find((x) => x.id === li.dataset.id)));
    });
  }
}

// ---------- Daten laden ----------

async function loadOverview() {
  const expenses = await listAll('split_expenses', {
    filter: `group = ${q(state.group.id)} && settlement = ''`,
    sort: '-date,-created',
  });
  state.expenses = expenses;
  state.balance = computeBalance(expenses);
  renderBalance($('#balance-card'), state.balance);
  renderStats($('#stats'), state.balance);
  renderExpenses($('#expense-list'), expenses, { editable: true });
  $('#settle-btn').disabled = expenses.length === 0;
  const uniq = [...new Set(expenses.map((e) => e.description))].slice(0, 30);
  $('#desc-suggestions').innerHTML = uniq.map((d) => `<option value="${esc(d)}">`).join('');
}

async function loadHistory() {
  const [rows, settled] = await Promise.all([
    listAll('split_settlements', { filter: `group = ${q(state.group.id)}`, sort: '-created' }),
    listAll('split_expenses', { filter: `group = ${q(state.group.id)} && settlement != ''`, fields: 'settlement,date' }),
  ]);
  const info = {};
  for (const e of settled) {
    const i = (info[e.settlement] ||= { count: 0, first: e.date, last: e.date });
    i.count++;
    if (e.date < i.first) i.first = e.date;
    if (e.date > i.last) i.last = e.date;
  }
  const el = $('#settlement-list');
  if (!rows.length) { el.innerHTML = '<li class="empty">Noch keine Abrechnungen.</li>'; return; }
  const dmy = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('de-DE');
  el.innerHTML = rows.map((s) => {
    const i = info[s.id] || { count: 0 };
    const created = new Date(s.created.replace(' ', 'T'));
    const who = s.from_user ? `${esc(userName(s.from_user))} → ${esc(userName(s.to_user))}` : 'Ausgeglichen';
    return `
      <li class="settlement" data-id="${esc(s.id)}">
        <div class="ico">✓</div>
        <div class="mid">
          <div class="title">${created.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
          <div class="meta">${i.count} Ausgaben${i.first ? ` · ${dmy(i.first)} – ${dmy(i.last)}` : ''}${s.note ? ' · ' + esc(s.note) : ''}</div>
        </div>
        <div class="right">
          <div class="amt">${eur(s.amount_cents)}</div>
          <div class="meta">${who}</div>
        </div>
      </li>`;
  }).join('');
  el.querySelectorAll('.settlement').forEach((li) => li.addEventListener('click', () => showSettlement(li.dataset.id)));
}

async function showSettlement(id) {
  const expenses = await listAll('split_expenses', { filter: `settlement = ${q(id)}`, sort: '-date,-created' });
  const b = computeBalance(expenses);
  renderBalance($('#settlement-balance'), b, { settled: true });
  renderStats($('#settlement-stats'), b);
  renderExpenses($('#settlement-expenses'), expenses, { editable: false });
  showTab('settlement');
}

// ---------- Tabs ----------

function showTab(name) {
  for (const t of ['open', 'history', 'settlement']) $(`#tab-${t}`).classList.toggle('hidden', t !== name);
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name || (name === 'settlement' && b.dataset.tab === 'history')));
  $('#add-btn').classList.toggle('hidden', name !== 'open');
  window.scrollTo(0, 0);
}

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (!state.group) return;
  showTab(b.dataset.tab);
  if (b.dataset.tab === 'history') loadHistory().catch((e) => toast(e.message));
  if (b.dataset.tab === 'open') loadOverview().catch((e) => toast(e.message));
}));
$('#back-btn').addEventListener('click', () => showTab('history'));

// ---------- Abrechnen (atomar über die PocketBase-Batch-API) ----------

$('#settle-btn').addEventListener('click', async () => {
  try {
    await loadOverview(); // frischer Stand, falls die andere Person gerade etwas eingetragen hat
    const b = state.balance;
    if (!b.count) return toast('Keine offenen Ausgaben.');
    const summary = b.from_user
      ? `${userName(b.from_user)} überweist ${userName(b.to_user)} ${eur(b.amount_cents)}`
      : 'Ihr seid ausgeglichen.';
    if (!confirm(`Jetzt abrechnen?\n\n${summary}\n\n${b.count} offene Ausgaben werden abgeschlossen und ins Archiv verschoben. Danach startet ihr wieder bei 0.`)) return;

    const sid = newId();
    const requests = [
      {
        method: 'POST',
        url: '/api/collections/split_settlements/records',
        body: {
          id: sid, group: state.group.id, created_by: state.me.id,
          from_user: b.from_user || '', to_user: b.to_user || '', amount_cents: b.amount_cents,
        },
      },
      ...state.expenses.map((e) => ({
        method: 'PATCH', url: `/api/collections/split_expenses/records/${e.id}`, body: { settlement: sid },
      })),
    ];
    try {
      await pb('POST', '/api/batch', { requests });
    } catch (e) {
      if (e.status === 403) throw new Error('Die Batch-API ist in PocketBase deaktiviert. Admin: Einstellungen → Application → „Batch API“ aktivieren.');
      throw e;
    }
    toast('Abgerechnet ✓');
    await loadOverview();
  } catch (e) { toast(e.message); }
});

// ---------- CSV-Export ----------

$('#export-btn').addEventListener('click', async () => {
  try {
    const rows = await listAll('split_expenses', { filter: `group = ${q(state.group.id)}`, sort: 'date,created' });
    const c = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Datum', 'Beschreibung', 'Kategorie', 'Betrag', 'Bezahlt von', 'Anteil Zahler %', 'Status'].map(c).join(';')];
    for (const e of rows) {
      lines.push([e.date, e.description, e.category, (e.amount_cents / 100).toFixed(2).replace('.', ','),
        userName(e.paid_by), e.payer_share ?? 0, e.settlement ? 'abgerechnet' : 'offen'].map(c).join(';'));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `split-${today()}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { toast(e.message); }
});

// ---------- Formular ----------

const form = $('#expense-form');
const sheetState = { paidBy: null, mode: 'half', category: 'Lebensmittel' };

function setSegment(container, attr, value) {
  container.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset[attr] === String(value)));
}

function updateSplitUi() {
  const other = otherId(sheetState.paidBy);
  $('#split-other-btn').textContent = `Nur für ${userName(other)}`;
  setSegment($('#split-mode'), 'mode', sheetState.mode);
  $('#custom-split').classList.toggle('hidden', sheetState.mode !== 'custom');
  const share = Number(form.payer_share.value);
  $('#split-label-payer').textContent = `${userName(sheetState.paidBy)}: ${share} %`;
  $('#split-label-other').textContent = `${userName(other)}: ${100 - share} %`;
}

function buildFormControls() {
  $('#paid-by').innerHTML = state.members.map((m) => `<button type="button" data-id="${esc(m.user)}">${esc(m.display_name)}</button>`).join('');
  $('#paid-by').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    sheetState.paidBy = b.dataset.id;
    setSegment($('#paid-by'), 'id', sheetState.paidBy);
    updateSplitUi();
  }));
  $('#category-chips').innerHTML = state.categories.map((c) => `<button type="button" data-cat="${esc(c)}">${CAT_ICONS[c] || ''} ${esc(c)}</button>`).join('');
  $('#category-chips').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    sheetState.category = b.dataset.cat;
    setSegment($('#category-chips'), 'cat', sheetState.category);
  }));
}

$('#split-mode').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  sheetState.mode = b.dataset.mode;
  updateSplitUi();
}));
form.payer_share.addEventListener('input', updateSplitUi);

function openSheet(expense = null) {
  state.editing = expense;
  form.reset();
  $('#form-error').classList.add('hidden');
  $('#sheet-title').textContent = expense ? 'Ausgabe bearbeiten' : 'Neue Ausgabe';
  $('#delete-btn').classList.toggle('hidden', !expense);
  if (expense) {
    form.amount.value = (expense.amount_cents / 100).toFixed(2).replace('.', ',');
    form.description.value = expense.description;
    form.date.value = expense.date;
    sheetState.paidBy = expense.paid_by;
    sheetState.category = expense.category;
    const share = expense.payer_share ?? 0;
    sheetState.mode = share === 50 ? 'half' : share === 0 ? 'other' : 'custom';
    form.payer_share.value = share;
  } else {
    form.date.value = today();
    sheetState.paidBy = state.me.id;
    sheetState.category = 'Lebensmittel';
    sheetState.mode = 'half';
    form.payer_share.value = 50;
  }
  setSegment($('#paid-by'), 'id', sheetState.paidBy);
  setSegment($('#category-chips'), 'cat', sheetState.category);
  updateSplitUi();
  $('#sheet').classList.remove('hidden');
  if (!expense) setTimeout(() => form.amount.focus(), 50);
}

function closeSheet() { $('#sheet').classList.add('hidden'); state.editing = null; }

$('#add-btn').addEventListener('click', () => openSheet());
$('#cancel-btn').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

function formError(msg) {
  $('#form-error').textContent = msg;
  $('#form-error').classList.remove('hidden');
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  let raw = form.amount.value.trim().replace(/\s|€/g, '');
  if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.'); // 1.234,56 → 1234.56 ; 12.99 bleibt 12.99
  const amount = Math.round(Number(raw) * 100);
  if (!Number.isFinite(amount) || amount <= 0) return formError('Bitte einen gültigen Betrag eingeben.');
  const description = form.description.value.trim();
  if (!description) return formError('Bitte angeben, wofür.');
  const payerShare = sheetState.mode === 'half' ? 50 : sheetState.mode === 'other' ? 0 : Number(form.payer_share.value);
  const body = {
    description, amount_cents: amount, paid_by: sheetState.paidBy, payer_share: payerShare,
    category: sheetState.category, date: form.date.value,
  };
  try {
    if (state.editing) {
      await rec.update('split_expenses', state.editing.id, body);
    } else {
      await rec.create('split_expenses', { ...body, group: state.group.id, created_by: state.me.id });
    }
    closeSheet();
    toast('Gespeichert ✓');
    await loadOverview();
  } catch (e) {
    formError(e.status === 404 ? 'Diese Ausgabe wurde inzwischen abgerechnet oder gelöscht.' : e.message);
  }
});

$('#delete-btn').addEventListener('click', async () => {
  if (!state.editing || !confirm(`„${state.editing.description}" wirklich löschen?`)) return;
  try {
    await rec.remove('split_expenses', state.editing.id);
    closeSheet();
    toast('Gelöscht');
    await loadOverview();
  } catch (e) { toast(e.message); }
});

// ---------- Start ----------

function showSetupError(msg) {
  $('#setup-error').textContent = msg;
  $('#setup-error').classList.remove('hidden');
  for (const id of ['#balance-card', '#stats', '#expense-list', '#settle-btn', '#add-btn']) $(id).classList.add('hidden');
}

async function startApp() {
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  $('#me-name').textContent = state.me.name || state.me.email || '';
  showTab('open');

  // Haushalt + Mitglieder ermitteln
  const mine = await listAll('split_members', { filter: `user = ${q(state.me.id)}`, expand: 'group', sort: 'created' });
  if (!mine.length) {
    return showSetupError('Dein Konto ist noch keinem Haushalt zugeordnet.\nDer Admin muss in PocketBase einen Eintrag in „split_groups“ und für euch beide je einen Eintrag in „split_members“ anlegen.');
  }
  const m = mine[0];
  state.group = m.expand?.group || { id: m.group };
  const members = await listAll('split_members', { filter: `group = ${q(state.group.id)}`, sort: 'created' });
  if (members.length !== 2) {
    return showSetupError(`Der Haushalt „${state.group.name || ''}“ hat ${members.length} Mitglied(er) – es müssen genau 2 sein.`);
  }
  state.members = members.map((x) => ({ user: x.user, display_name: x.display_name }));
  $('#me-name').textContent = userName(state.me.id);
  $('#setup-error').classList.add('hidden');
  for (const id of ['#balance-card', '#stats', '#expense-list', '#settle-btn']) $(id).classList.remove('hidden');
  buildFormControls();
  showTab('open');
  await loadOverview();
  live.start();
}

async function boot() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch {}
  if (!saved?.token) return logout();
  state.token = saved.token;
  state.me = saved.record;
  try {
    // Token erneuern (verlängert die Anmeldung)
    const r = await pb('POST', `/api/collections/${CFG.authCollection}/auth-refresh`);
    saveAuth(r.token, r.record);
  } catch (e) {
    if (e.status !== 0) return logout(); // offline: mit gespeichertem Token weiterversuchen
  }
  await startApp().catch((e) => toast(e.message));
}

// Beim Zurückkehren in die App aktualisieren
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.group) return;
  if (!$('#tab-open').classList.contains('hidden')) loadOverview().catch(() => {});
  if (!live.es || live.es.readyState === 2) live.start();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

boot();
