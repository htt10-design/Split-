'use strict';

const $ = (sel) => document.querySelector(sel);
const state = { me: null, users: [], categories: [], expenses: [], editing: null };

const CAT_ICONS = {
  Lebensmittel: '🛒', Drogerie: '🧴', Haushalt: '🏠', Wohnen: '🛋️', Restaurant: '🍽️',
  Freizeit: '🎬', Urlaub: '✈️', Transport: '🚗', Geschenke: '🎁', Sonstiges: '📦',
};

const eur = (cents) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const userName = (id) => state.users.find((u) => u.id === id)?.name ?? '?';
const otherId = (id) => (id === 1 ? 2 : 1);
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in lokaler Zeit
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const t = today();
  const y = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
  if (iso === t) return 'Heute';
  if (iso === y) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'long', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Nicht angemeldet'); }
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2500);
}

// ---------- Login ----------

function showLogin() {
  $('#view-app').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    await api('/api/login', { method: 'POST', body: { name: f.get('name'), password: f.get('password') } });
    ev.target.reset();
    await boot();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  $('#menu').classList.add('hidden');
  showLogin();
});

$('#menu-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); });
document.addEventListener('click', () => $('#menu').classList.add('hidden'));

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
  const cats = Object.entries(b.by_category).sort((a, z) => z[1] - a[1]);
  const max = cats[0]?.[1] || 1;
  el.innerHTML = `
    ${state.users.map((u) => `
      <div class="stat">
        <div class="k">${esc(u.name)} hat bezahlt</div>
        <div class="v">${eur(b.paid[u.id])}</div>
        <div class="k">Anteil: ${eur(b.consumed[u.id])}</div>
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
    const owed = Math.round(e.amount_cents * (100 - e.payer_share) / 100);
    const iPaid = e.paid_by === state.me.id;
    let shareTxt = '';
    let shareCls = '';
    if (owed > 0) {
      shareTxt = iPaid ? `bekommst ${eur(owed)}` : `schuldest ${eur(owed)}`;
      shareCls = iPaid ? 'pos' : 'neg';
    } else {
      shareTxt = 'nur für Zahler';
    }
    const splitTxt = e.payer_share === 50 ? '50/50'
      : e.payer_share === 0 ? `nur für ${userName(otherId(e.paid_by))}`
      : `${e.payer_share}/${100 - e.payer_share}`;
    html += `
      <li class="expense" data-id="${e.id}">
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
  el.classList.toggle('settled', !editable);
  if (editable) {
    el.querySelectorAll('.expense').forEach((li) => {
      li.addEventListener('click', () => openSheet(state.expenses.find((x) => x.id === Number(li.dataset.id))));
    });
  }
}

async function loadOverview() {
  const { expenses, balance } = await api('/api/overview');
  state.expenses = expenses;
  renderBalance($('#balance-card'), balance);
  renderStats($('#stats'), balance);
  renderExpenses($('#expense-list'), expenses, { editable: true });
  $('#settle-btn').disabled = expenses.length === 0;
  // Vorschläge für Beschreibungen
  const uniq = [...new Set(expenses.map((e) => e.description))].slice(0, 30);
  $('#desc-suggestions').innerHTML = uniq.map((d) => `<option value="${esc(d)}">`).join('');
}

async function loadHistory() {
  const rows = await api('/api/settlements');
  const el = $('#settlement-list');
  if (!rows.length) { el.innerHTML = '<li class="empty">Noch keine Abrechnungen.</li>'; return; }
  el.innerHTML = rows.map((s) => {
    const created = new Date(s.created_at.replace(' ', 'T') + 'Z');
    const range = s.first_date ? `${new Date(s.first_date).toLocaleDateString('de-DE')} – ${new Date(s.last_date).toLocaleDateString('de-DE')}` : '';
    const who = s.from_user ? `${esc(userName(s.from_user))} → ${esc(userName(s.to_user))}` : 'Ausgeglichen';
    return `
      <li class="settlement" data-id="${s.id}">
        <div class="ico">✓</div>
        <div class="mid">
          <div class="title">${created.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
          <div class="meta">${s.count} Ausgaben · ${range}${s.note ? ' · ' + esc(s.note) : ''}</div>
        </div>
        <div class="right">
          <div class="amt">${eur(s.amount_cents)}</div>
          <div class="meta">${who}</div>
        </div>
      </li>`;
  }).join('');
  el.querySelectorAll('.settlement').forEach((li) => li.addEventListener('click', () => showSettlement(Number(li.dataset.id))));
}

async function showSettlement(id) {
  const { expenses, balance } = await api(`/api/settlements/${id}`);
  renderBalance($('#settlement-balance'), balance, { settled: true });
  renderStats($('#settlement-stats'), balance);
  renderExpenses($('#settlement-expenses'), expenses, { editable: false });
  showTab('settlement');
}

// ---------- Tabs ----------

function showTab(name) {
  for (const t of ['open', 'history', 'settlement']) $(`#tab-${t}`).classList.toggle('hidden', t !== name);
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name || (name === 'settlement' && b.dataset.tab === 'history')));
  $('#add-btn').classList.toggle('hidden', name !== 'open');
  window.scrollTo(0, 0);
}

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  showTab(b.dataset.tab);
  if (b.dataset.tab === 'history') loadHistory().catch((e) => toast(e.message));
  if (b.dataset.tab === 'open') loadOverview().catch((e) => toast(e.message));
}));
$('#back-btn').addEventListener('click', () => showTab('history'));

// ---------- Abrechnen ----------

$('#settle-btn').addEventListener('click', async () => {
  const card = $('#balance-card').querySelector('.label')?.textContent || '';
  const amount = $('#balance-card').querySelector('.amount')?.textContent || '';
  if (!confirm(`Jetzt abrechnen?\n\n${card}: ${amount}\n\nAlle offenen Ausgaben werden abgeschlossen und ins Archiv verschoben. Danach startet ihr wieder bei 0.`)) return;
  try {
    await api('/api/settle', { method: 'POST', body: {} });
    toast('Abgerechnet ✓');
    await loadOverview();
  } catch (e) { toast(e.message); }
});

// ---------- Formular ----------

const form = $('#expense-form');
const sheetState = { paidBy: 1, mode: 'half', category: 'Lebensmittel' };

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
  $('#paid-by').innerHTML = state.users.map((u) => `<button type="button" data-id="${u.id}">${esc(u.name)}</button>`).join('');
  $('#paid-by').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    sheetState.paidBy = Number(b.dataset.id);
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
  if (sheetState.mode === 'custom' && Number(form.payer_share.value) === 50) form.payer_share.value = 50;
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
    sheetState.mode = expense.payer_share === 50 ? 'half' : expense.payer_share === 0 ? 'other' : 'custom';
    form.payer_share.value = expense.payer_share;
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

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const payerShare = sheetState.mode === 'half' ? 50 : sheetState.mode === 'other' ? 0 : Number(form.payer_share.value);
  const body = {
    amount: form.amount.value.trim().replace(/\s|€/g, ''),
    description: form.description.value,
    paid_by: sheetState.paidBy,
    payer_share: payerShare,
    category: sheetState.category,
    date: form.date.value,
  };
  try {
    if (state.editing) await api(`/api/expenses/${state.editing.id}`, { method: 'PUT', body });
    else await api('/api/expenses', { method: 'POST', body });
    closeSheet();
    toast('Gespeichert ✓');
    await loadOverview();
  } catch (e) {
    $('#form-error').textContent = e.message;
    $('#form-error').classList.remove('hidden');
  }
});

$('#delete-btn').addEventListener('click', async () => {
  if (!state.editing || !confirm(`„${state.editing.description}" wirklich löschen?`)) return;
  try {
    await api(`/api/expenses/${state.editing.id}`, { method: 'DELETE' });
    closeSheet();
    toast('Gelöscht');
    await loadOverview();
  } catch (e) { toast(e.message); }
});

// ---------- Start ----------

async function boot() {
  try {
    const me = await api('/api/me');
    state.me = me.user;
    state.users = me.users;
    state.categories = me.categories;
  } catch { return; }
  $('#me-name').textContent = state.me.name;
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  buildFormControls();
  showTab('open');
  await loadOverview().catch((e) => toast(e.message));
}

// Beim Zurückkehren in die App aktualisieren (z.B. wenn die andere Person etwas eingetragen hat)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me && !$('#tab-open').classList.contains('hidden')) {
    loadOverview().catch(() => {});
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

boot();
