'use strict';
/*
 * Gatekeeper app: login, home, and (for the superadmin) people. Logging, the live feed and the
 * dashboard arrive in the next updates. Plain JavaScript, no build step: it runs as served.
 * Everything shown from the server is set with textContent (never innerHTML) so names can't inject markup.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
let me = null;

const ROLE_LABEL = { area: 'Area', senior: 'Senior', superadmin: 'Superadmin' };
const area = (hub) => (hub || '').replace(' Hub', '');

async function api(path, opts = {}) {
  const res = await fetch(`/api/app${path}`, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'No connection. Try again.' }));
  if (res.status === 401 && !opts.allow401) {
    disconnectStream();
    me = null;
    route();

// Works without signal once opened: the app's files are kept on the phone.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => undefined);
  }
  return { status: res.status, ...data };
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

function show(tplId) {
  view.replaceChildren($(tplId).content.cloneNode(true));
  window.scrollTo(0, 0);
  return view;
}

function showError(root, msg) {
  const p = $('[data-error]', root);
  p.textContent = msg || '';
  p.hidden = !msg;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

function setHeader() {
  $('#top').hidden = !me;
  if (!me) return;
  $('#whoName').textContent = me.name;
  const b = $('#whoRole');
  b.textContent = me.role === 'area' ? area(me.hub) : ROLE_LABEL[me.role];
  b.className = `badge ${me.role}`;
  setQueue(allQueued());
}

// ---------------------------------------------------------------- setup and login

function setupView() {
  const root = show('#tpl-setup');
  const form = $('#setupForm', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (f.pin !== f.pin2) return showError(root, 'The two PINs don’t match.');
    const r = await api('/setup', { method: 'POST', body: { admin_key: f.admin_key, name: f.name, pin: f.pin }, allow401: true });
    if (!r.ok) return showError(root, r.error);
    me = r.user;
    remember(me.name);
    route();

// Works without signal once opened: the app's files are kept on the phone.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => undefined);
  });
}

const remember = (name) => {
  try { localStorage.setItem('gk_name', name); } catch { /* private mode */ }
};
const remembered = () => {
  try { return localStorage.getItem('gk_name') || ''; } catch { return ''; }
};

function loginView() {
  const root = show('#tpl-login');
  const form = $('#loginForm', root);
  const nameInput = form.elements.name;
  const pinInput = form.elements.pin;
  const dots = [...root.querySelectorAll('.pin-dots i')];
  nameInput.value = remembered();
  let pin = '';
  const draw = () => dots.forEach((d, i) => {
    d.classList.toggle('show', i < Math.max(4, pin.length));
    d.classList.toggle('on', i < pin.length);
  });
  draw();
  $('.keypad', root).addEventListener('click', (e) => {
    const k = e.target.closest('button')?.dataset.k;
    if (!k) return;
    if (k === 'del') pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += k;
    showError(root, '');
    draw();
  });
  document.onkeydown = (e) => {
    if (document.activeElement === nameInput) return;
    if (/^\d$/.test(e.key) && pin.length < 8) pin += e.key;
    else if (e.key === 'Backspace') pin = pin.slice(0, -1);
    else if (e.key === 'Enter') form.requestSubmit();
    else return;
    draw();
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!nameInput.value.trim()) return showError(root, 'Type your name.');
    if (pin.length < 4) return showError(root, 'Enter your PIN.');
    pinInput.value = pin;
    const r = await api('/login', { method: 'POST', body: { name: nameInput.value, pin }, allow401: true });
    pin = '';
    draw();
    if (!r.ok) return showError(root, r.error);
    document.onkeydown = null;
    me = r.user;
    remember(me.name);
    route();

// Works without signal once opened: the app's files are kept on the phone.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => undefined);
  });
  if (nameInput.value) nameInput.blur();
  else nameInput.focus();
}

// ---------------------------------------------------------------- home

const isAdmin = () => me.role === 'senior' || me.role === 'superadmin';

function homeView() {
  const root = show('#tpl-home');
  $('[data-hello]', root).textContent =
    me.role === 'area' ? `Hi ${me.name}, you’re on ${area(me.hub)}.` : `Hi ${me.name}.`;
  const tiles = $('[data-tiles]', root);
  const tile = (icon, title, sub, opts = {}) =>
    el('button', { class: `tile${opts.wide ? ' wide' : ''}`, type: 'button', disabled: !opts.go, onclick: opts.go },
      el('span', { class: 'icon', text: icon, 'aria-hidden': 'true' }),
      el('span', {}, el('strong', { text: title }), el('small', { text: sub })));
  tiles.append(
    tile('➕', 'Log someone', me.role === 'area' ? `Refused, 30 min or ejected at ${area(me.hub)}` : 'Refused, 30 min or ejected', { wide: true, go: () => go('log') }),
    tile('🔎', 'Check a seat', 'Is this ticket on record?', { go: () => go('check') }),
    tile('📡', 'Live feed', 'Every log, all areas, as it happens', { go: () => go('feed') }),
  );
  if (isAdmin()) {
    tiles.append(
      tile('📊', 'Dashboard', 'Live numbers, charts, map', { go: () => go('dashboard') }),
      tile('🏁', 'Events & reports', 'Start, end, final numbers', { go: () => go('events') }),
    );
  }
  if (me.role === 'superadmin') {
    tiles.append(
      tile('👥', 'People', 'Add people, PINs, roles', { go: () => go('people') }),
      tile('⚙️', 'Settings', 'Policy, AI, seating plan', { go: () => go('settings') }),
    );
  }
}

// ---------------------------------------------------------------- people (superadmin)

async function peopleView() {
  const root = show('#tpl-users');
  $('[data-back]', root).onclick = () => go('');
  const form = $('#userForm', root);
  const hubField = $('[data-hub-field]', root);
  const ROLE_HINT = {
    area: 'Logs in their own area only; sees every area’s logs; can fix their own logs.',
    senior: 'Sees, adds, edits and deletes everything; dashboard and reports. No settings.',
    superadmin: 'Everything, plus settings and people.',
  };
  const syncHub = () => {
    hubField.hidden = form.elements.role.value !== 'area';
    $('[data-role-hint]', root).textContent = ROLE_HINT[form.elements.role.value];
  };
  form.elements.role.addEventListener('change', syncHub);
  syncHub();

  const reset = () => {
    form.reset();
    form.elements.id.value = '';
    $('[data-form-title]', root).textContent = 'Add someone';
    $('[data-submit]', root).textContent = 'Add';
    $('[data-cancel]', root).hidden = true;
    $('[data-pin-hint]', root).textContent = '(6–8 digits)';
    form.elements.pin.required = true;
    showError(root, '');
    syncHub();
  };
  $('[data-cancel]', root).onclick = reset;
  reset();

  const list = $('[data-list]', root);
  async function load() {
    const r = await api('/users');
    if (!r.ok) return showError(root, r.error);
    list.replaceChildren(
      ...r.users.map((u) => {
        const sub = [u.role === 'area' ? `${area(u.hub)} area` : null, u.last_login_at ? `last in ${new Date(u.last_login_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : 'not logged in yet']
          .filter(Boolean).join(' · ');
        return el('li', {},
          el('span', { class: `badge ${u.active ? u.role : 'off'}`, text: u.active ? ROLE_LABEL[u.role] : 'Off' }),
          el('span', { class: 'info' }, el('strong', { text: u.name }), el('small', { text: sub })),
          el('button', { class: 'link', type: 'button', text: 'Edit', onclick: () => edit(u) }));
      }),
    );
  }

  function edit(u) {
    form.elements.id.value = u.id;
    form.elements.name.value = u.name;
    form.elements.role.value = u.role;
    if (u.hub) form.elements.hub.value = u.hub;
    form.elements.pin.value = '';
    form.elements.pin.required = false;
    $('[data-pin-hint]', root).textContent = '(leave empty to keep their PIN)';
    $('[data-form-title]', root).textContent = `Edit ${u.name}`;
    $('[data-submit]', root).textContent = 'Save';
    $('[data-cancel]', root).hidden = false;
    syncHub();
    // Switch on/off and remove, next to Save.
    root.querySelectorAll('[data-extra]').forEach((b) => b.remove());
    const row = $('.row-gap', form);
    row.append(
      el('button', { class: 'ghost', type: 'button', 'data-extra': true, text: u.active ? 'Switch off' : 'Switch on', onclick: async () => {
        const r = await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } });
        if (!r.ok) return showError(root, r.error);
        toast(`${u.name} switched ${u.active ? 'off' : 'on'}.`);
        reset(); load();
      } }),
      el('button', { class: 'ghost', type: 'button', 'data-extra': true, text: 'Unlock', title: 'After too many wrong PINs', onclick: async () => {
        const r = await api(`/users/${u.id}`, { method: 'PATCH', body: { unlock: true } });
        if (!r.ok) return showError(root, r.error);
        toast(`${u.name} can log in again.`);
      } }),
      el('button', { class: 'danger', type: 'button', 'data-extra': true, text: 'Remove', onclick: async () => {
        if (!confirm(`Remove ${u.name}? Their past logs stay, with their name.`)) return;
        const r = await api(`/users/${u.id}`, { method: 'DELETE' });
        if (!r.ok) return showError(root, r.error);
        toast(`${u.name} removed.`);
        reset(); load();
      } }),
    );
    form.scrollIntoView({ behavior: 'smooth' });
  }

  form.addEventListener('reset', () => root.querySelectorAll('[data-extra]').forEach((b) => b.remove()));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const body = { name: f.name, role: f.role, hub: f.role === 'area' ? f.hub : null };
    if (f.pin) body.pin = f.pin;
    const r = f.id ? await api(`/users/${f.id}`, { method: 'PATCH', body }) : await api('/users', { method: 'POST', body });
    if (!r.ok) return showError(root, r.error);
    toast(f.id ? `${r.user.name} saved.` : `${r.user.name} added. Give them their PIN in person.`);
    reset();
    load();
  });
  load();
}

// ---------------------------------------------------------------- shared bits

let options = null;
async function getOptions() {
  if (options) return options;
  const r = await api('/options');
  if (r.ok) options = r;
  return options;
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const minsUntil = (iso) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000));
const STATUS = { refused: 'REFUSED', sent_away: 'SENT AWAY', ejected: 'EJECTED', admitted: 'CLEARED' };

/** "56", "205 206 207", "205-207", "205,206" -> seat numbers (max 20). */
function parseSeats(text) {
  const out = [];
  for (const part of text.toUpperCase().split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d{1,4})-(\d{1,4})$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (b < a || b - a > 19) return null;
      for (let n = a; n <= b; n++) out.push(String(n));
    } else if (/^[A-Z0-9]{1,8}$/.test(part)) out.push(part);
    else return null;
  }
  return out.length && out.length <= 20 ? [...new Set(out)] : null;
}

/** One-line summary of a record, for alerts and lists. */
function recordText(r) {
  const parts = [];
  if (r.status === 'sent_away' && r.back_at) parts.push(minsUntil(r.back_at) ? `back ${clock(r.back_at)} (${minsUntil(r.back_at)} min)` : 'cool-off over');
  if (r.first_hub) parts.push(`${area(r.first_hub)} ${clock(r.first_at)}`);
  if (r.by) parts.push(`by ${r.by}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- offline queue

// Each waiting log keeps who wrote it: it's only ever sent by that person, and dropped after a day.
const QUEUE = 'gk_queue';
const DAY = 24 * 3600 * 1000;
const allQueued = () => store.get(QUEUE, []).filter((e) => e && e.body && e.user_id && Date.now() - e.saved_at < DAY);
const queued = () => (me ? allQueued().filter((e) => e.user_id === me.id) : []);
function setQueue(all) {
  store.set(QUEUE, all);
  const mine = me ? all.filter((e) => e.user_id === me.id).length : 0;
  const badge = $('#queueBadge');
  if (badge) {
    badge.hidden = !mine;
    badge.textContent = `${mine} waiting`;
  }
}
function enqueue(body) {
  setQueue([...allQueued(), { body, user_id: me.id, saved_at: Date.now() }]);
}
function dequeue(entry) {
  setQueue(allQueued().filter((e) => e.body.client_id !== entry.body.client_id));
}

/** Sends logs saved while there was no signal. The server ignores ones it already has. */
let flushing = false;
async function flushQueue() {
  if (flushing || !me) return;
  flushing = true;
  try {
    setQueue(allQueued()); // drops ones older than a day
    let q = queued();
    while (q.length && me) {
      let res;
      try {
        res = await fetch('/api/app/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q[0].body), credentials: 'same-origin' });
      } catch {
        break; // still no signal
      }
      if (res.status === 401 || res.status >= 500) break;
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const reentry = (data.results || []).find((x) => x.reentry);
        toast(reentry ? `🚨 Sent: ${reentry.seat} was already on record. Do not admit.` : `Sent: ${(data.results || []).map((x) => x.seat).join(', ')}`);
      } else {
        toast(`Couldn’t send a saved log: ${data.error || 'rejected'}`);
      }
      dequeue(q[0]);
      q = queued();
    }
  } finally {
    flushing = false;
  }
}
window.addEventListener('online', flushQueue);
setInterval(flushQueue, 20000);

// ---------------------------------------------------------------- log someone

async function logView() {
  const opts = await getOptions();
  if (!opts) return homeView();
  const root = show('#tpl-log');
  $('[data-back]', root).onclick = () => go('');
  if (opts.policy) {
    $('.log', root).insertBefore(
      el('details', { class: 'block policy' }, el('summary', { text: '📋 Refusal policy' }), el('p', { text: opts.policy, style: 'white-space:pre-wrap;margin:.5rem 0 0' })),
      $('.log .block', root),
    );
  }
  $('[data-cool]', root).textContent = `${opts.cool_off_minutes} min`;

  const state = { decision: null, hub: me.role === 'area' ? me.hub : store.get('gk_hub', null), reasons: [], gender: null, height: null, build: null, age: null, party: 1, ticket_code: null };
  const saveBtn = $('[data-save]', root);
  const missing = $('[data-missing]', root);
  const [secIn, rowIn, seatIn] = ['[data-section]', '[data-row]', '[data-seat]'].map((q) => $(q, root));

  // Single-choice chip rows (tap again to clear).
  function chipRow(container, values, key, label = (v) => v, allowClear = true) {
    const host = $(container, root);
    host.replaceChildren(
      ...values.map((v) =>
        el('button', { type: 'button', 'aria-pressed': String(state[key] === v), text: label(v), onclick: (e) => {
          state[key] = state[key] === v && allowClear ? null : v;
          for (const b of host.children) b.setAttribute('aria-pressed', String(b === e.currentTarget && state[key] === v));
          refresh();
        } })),
    );
    return host;
  }

  // What happened
  const decisions = $('[data-decision]', root);
  decisions.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.decision = b.dataset.v;
    for (const x of decisions.children) x.setAttribute('aria-pressed', String(x === b));
    refresh();
  });

  // Area
  if (me.role === 'area') $('[data-hubs]', root).replaceChildren(el('span', { class: 'fixed', text: `📍 ${area(me.hub)}` }));
  else chipRow('[data-hubs]', opts.hubs, 'hub', area, false);

  // Reasons (several)
  const other = $('[data-other]', root);
  const reasonsHost = $('[data-reasons]', root);
  reasonsHost.replaceChildren(
    ...opts.reasons.map((r) =>
      el('button', { type: 'button', 'aria-pressed': 'false', text: r, onclick: (e) => {
        const on = !state.reasons.includes(r);
        state.reasons = on ? [...state.reasons, r] : state.reasons.filter((x) => x !== r);
        e.currentTarget.setAttribute('aria-pressed', String(on));
        other.hidden = !state.reasons.includes('Other');
        refresh();
      } })),
  );

  // Description
  chipRow('[data-gender]', ['Male', 'Female'], 'gender');
  chipRow('[data-height]', opts.heights, 'height');
  chipRow('[data-build]', opts.builds, 'build');
  chipRow('[data-age]', opts.ages, 'age');
  const partyEl = $('[data-party]', root);
  $('[data-party-minus]', root).onclick = () => { state.party = Math.max(1, state.party - 1); partyEl.textContent = state.party; };
  $('[data-party-plus]', root).onclick = () => { state.party = Math.min(50, state.party + 1); partyEl.textContent = state.party; };

  if (opts.ai) {
    $('[data-ai]', root).hidden = false;
    $('[data-ai-fill]', root).onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '✨ Reading…';
      const r = await api('/describe', { method: 'POST', body: { text: $('[data-ai-text]', root).value } });
      btn.disabled = false;
      btn.textContent = '✨ Fill in the buttons';
      if (!r.ok) return toast(r.error);
      const pick = (container, key, values, v) => {
        if (!v) return;
        if (!values.includes(v)) values = [...values, v]; // a word that isn't on the list: shown just for this log
        state[key] = v;
        chipRow(container, values, key);
      };
      pick('[data-gender]', 'gender', ['Male', 'Female'], r.fields.gender);
      pick('[data-height]', 'height', opts.heights, r.fields.height);
      pick('[data-build]', 'build', opts.builds, r.fields.build);
      pick('[data-age]', 'age', opts.ages, r.fields.age);
      if (r.fields.clothing) $('[data-clothing]', root).value = r.fields.clothing;
      refresh();
    };
  }

  // Seat: capitals, and a warning straight away if it's already on record.
  const alertBox = $('[data-seat-alert]', root);
  let checkTimer;
  let checkSeq = 0;
  for (const input of [secIn, rowIn, seatIn]) {
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase();
      refresh();
      clearTimeout(checkTimer);
      checkTimer = setTimeout(checkSeats, 350);
    });
  }
  async function checkSeats() {
    const seats = parseSeats(seatIn.value);
    const sec = secIn.value.trim();
    const row = rowIn.value.trim();
    if (!sec || !row || !seats) return alertBox.replaceChildren();
    const seq = ++checkSeq;
    const found = [];
    for (const seat of seats.slice(0, 20)) {
      const r = await api(`/seat?section=${encodeURIComponent(sec)}&row=${encodeURIComponent(row)}&seat=${encodeURIComponent(seat)}`).catch(() => null);
      if (seq !== checkSeq) return;
      if (r?.found) found.push(r.record);
    }
    alertBox.replaceChildren(
      ...found.map((rec) => {
        const cleared = rec.status === 'admitted';
        return el('div', { class: `alert ${cleared ? 'ok' : rec.status === 'sent_away' ? 'warn' : 'danger'}` },
          el('span', { text: `${cleared ? '🟢' : '⚠️'} ${rec.seat} is already ${STATUS[rec.status]}${cleared ? ' (cleared)' : ''}` }),
          el('small', { text: [recordText(rec), rec.reasoning].filter(Boolean).join(' — ') }),
          cleared ? null : el('small', { text: 'Saving this logs a re-entry attempt. Do not admit.' }));
      }),
    );
  }

  // Ticket photo: the server reads the seat (and QR code).
  $('[data-scan]', root).addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    toast('Reading the ticket…');
    const blob = await shrink(file).catch(() => file);
    let r;
    try {
      const res = await fetch('/api/app/scan-ticket', { method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob, credentials: 'same-origin' });
      r = await res.json();
    } catch {
      return toast('No signal: type the seat instead.');
    }
    if (!r.ok) return toast(r.error || 'Couldn’t read that photo.');
    if (r.code) state.ticket_code = r.code;
    if (!r.seats.length) return toast(r.code ? 'Ticket code read; type the seat too.' : 'Couldn’t find a seat on it: type it in.');
    const first = r.seats[0];
    const sameRow = r.seats.filter((x) => x.section === first.section && x.row === first.row);
    secIn.value = first.section;
    rowIn.value = first.row;
    seatIn.value = sameRow.map((x) => x.seat).join(' ');
    toast(r.seats.length > sameRow.length ? `Seats from ${first.section} ${first.row} filled in. Log the other rows separately.` : 'Seat filled in from the ticket.');
    refresh();
    checkSeats();
  });

  function body() {
    const extra = $('[data-extra-reason]', root).value.split(',').map((x) => x.trim()).filter(Boolean);
    return {
      client_id: uuid(),
      author_id: me.id,
      decision: state.decision,
      seats: (parseSeats(seatIn.value) || []).map((seat) => ({ section: secIn.value.trim(), row: rowIn.value.trim(), seat })),
      hub: state.hub || undefined,
      reasons: [...state.reasons, ...extra],
      other_reason: state.reasons.includes('Other') ? $('[data-other-text]', root).value.trim() : undefined,
      gender: state.gender || undefined,
      height: state.height || undefined,
      build: state.build || undefined,
      age: state.age || undefined,
      clothing: $('[data-clothing]', root).value.trim() || undefined,
      party: state.party > 1 ? state.party : undefined,
      ticket_code: state.ticket_code || undefined,
      occurred_at: new Date().toISOString(),
    };
  }

  function refresh() {
    const b = body();
    const need = [];
    if (!b.decision) need.push('what happened');
    if (!secIn.value.trim() || !rowIn.value.trim() || !parseSeats(seatIn.value)) need.push('the seat');
    if (!b.hub) need.push('the area');
    if (!b.reasons.length) need.push('a reason');
    else if (state.reasons.includes('Other') && !b.other_reason) need.push('what “Other” was');
    saveBtn.disabled = need.length > 0;
    missing.textContent = need.length ? `Still needed: ${need.join(', ')}` : '';
    const seats = b.seats.map((x) => x.seat);
    const word = { refused: 'REFUSED', cool_off: 'SENT AWAY', ejected: 'EJECTED' }[b.decision] || '';
    saveBtn.textContent = need.length ? 'Save' : `Save · ${word} ${secIn.value.trim()} ${rowIn.value.trim()} ${seats.length > 3 ? `${seats.slice(0, 3).join(' ')}…` : seats.join(' ')}`;
  }
  $('[data-other-text]', root).addEventListener('input', refresh);
  $('[data-extra-reason]', root).addEventListener('input', refresh);
  refresh();

  saveBtn.onclick = async () => {
    const b = body();
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    if (me.role !== 'area') store.set('gk_hub', b.hub);
    let res;
    try {
      res = await fetch('/api/app/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), credentials: 'same-origin' });
    } catch {
      enqueue(b);
      return resultView(b, null);
    }
    const data = await res.json().catch(() => ({ ok: false, error: 'Something went wrong.' }));
    if (res.status === 401) {
      enqueue(b);
      me = null;
      toast('Log in again: your log is saved on this phone and will be sent.');
      return route();

// Works without signal once opened: the app's files are kept on the phone.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => undefined);
    }
    if (!data.ok) {
      toast(data.error);
      return refresh();
    }
    resultView(b, data.results);
  };
}

/** Makes big phone photos small enough to send quickly on poor signal. */
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no blob'))), 'image/jpeg', 0.85));
}

function resultView(sent, results) {
  const root = show('#tpl-result');
  const card = $('[data-card]', root);
  const lines = $('[data-lines]', root);
  if (!results) {
    card.classList.add('queued');
    $('[data-status]', root).textContent = '📶 No signal: saved on this phone';
    lines.append(
      el('p', { text: `${sent.seats.map((x) => `${x.section} ${x.row} ${x.seat}`).join(', ')} will be sent automatically when there’s signal.` }),
      el('p', { text: `Treat them as ${{ refused: 'REFUSED', cool_off: 'SENT AWAY', ejected: 'EJECTED' }[sent.decision]} now.` }),
    );
  } else {
    const main = results[0];
    card.classList.add(main.status);
    $('[data-status]', root).textContent = `✅ ${STATUS[main.status]}`;
    for (const r of results) {
      lines.append(el('p', { text: `${r.seat}${r.back_at ? ` · back ${clock(r.back_at)}` : ''}` }));
      if (r.reentry) lines.append(el('p', { class: 'reentry', text: `🚨 ${r.seat}: already on record (first at ${area(r.first_hub)} ${clock(r.first_at)}). Re-entry attempt logged. Do not admit.` }));
    }
    if (results.some((r) => r.offline)) lines.append(el('p', { text: 'The server’s database was busy: kept on the server and synced shortly.' }));
  }
  $('[data-again]', root).onclick = () => logView();
  $('[data-home]', root).onclick = () => go('');
  if (navigator.vibrate) navigator.vibrate(results?.some((r) => r.reentry) ? [200, 100, 200] : 80);
}

// ---------------------------------------------------------------- check a seat

function checkView() {
  const root = show('#tpl-check');
  $('[data-back]', root).onclick = () => go('');
  const q = $('[data-q]', root);
  const out = $('[data-results]', root);
  q.addEventListener('input', () => (q.value = q.value.toUpperCase()));
  $('[data-form]', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!q.value.trim()) return;
    const r = await api(`/search?q=${encodeURIComponent(q.value.trim())}`);
    if (!r.ok) return toast(r.error);
    if (!r.records.length) return out.replaceChildren(el('div', { class: 'alert ok', text: `✅ Nothing on record for “${q.value.trim()}”.` }));
    out.replaceChildren(
      el('ul', { class: 'records' },
        ...r.records.map((rec) =>
          el('li', { class: rec.status },
            el('div', {}, el('span', { class: 'seat', text: rec.seat }), el('span', { class: 'tag', text: STATUS[rec.status] })),
            rec.reasoning ? el('div', { text: rec.reasoning }) : null,
            rec.description ? el('div', { text: `👤 ${rec.description}` }) : null,
            el('small', { text: [recordText(rec), rec.party > 1 ? `group of ${rec.party}` : '', rec.reentries ? `🚨 tried again ×${rec.reentries}` : ''].filter(Boolean).join(' · ') })))),
    );
  });
  q.focus();
}

// ---------------------------------------------------------------- alerts pushed from the server

let stream = null;
let audioCtx = null;
// Phones only allow sound after a tap: get ready on the first one.
document.addEventListener('pointerdown', () => {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no sound on this phone */ }
}, { once: false, passive: true });

function beep(times = 2) {
  if (!audioCtx) return;
  for (let i = 0; i < times; i++) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    o.connect(g).connect(audioCtx.destination);
    const t = audioCtx.currentTime + i * 0.35;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start(t);
    o.stop(t + 0.3);
  }
}

function banner(kind, title, sub, autoCloseMs) {
  const box = $('#alerts');
  const b = el('div', { class: `banner ${kind}`, role: 'alert' },
    el('span', {}, document.createTextNode(title), sub ? el('small', { text: sub }) : null),
    el('button', { type: 'button', text: '✕', 'aria-label': 'Close', onclick: () => b.remove() }));
  box.prepend(b);
  while (box.children.length > 4) box.lastChild.remove();
  if (autoCloseMs) setTimeout(() => b.remove(), autoCloseMs);
}

let feedRefresh = null; // set while the feed is on screen
function connectStream() {
  if (stream || !me || !window.EventSource) return;
  stream = new EventSource('/api/app/stream');
  const live = (on) => document.querySelectorAll('[data-live]').forEach((d) => d.classList.toggle('on', on));
  stream.onopen = () => live(true);
  stream.onerror = () => {
    live(false);
    if (!me) disconnectStream();
  };
  stream.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    if (d.reentry) {
      banner('reentry', `🚨 ${d.seat} tried to get back in at ${area(d.hub)}`, `First at ${area(d.first_hub)}. ${STATUS[d.status] || ''}: do not admit. Logged by ${d.by}.`);
      beep(3);
      if (navigator.vibrate) navigator.vibrate([300, 120, 300, 120, 300]);
    }
    feedRefresh?.();
  });
  stream.addEventListener('readmit', (e) => {
    const d = JSON.parse(e.data);
    banner('readmit', `🟡 ${d.seat} may now be readmitted if fit`, d.hub ? `Sent away at ${area(d.hub)}.` : '', 120000);
    beep(1);
    feedRefresh?.();
  });
  stream.addEventListener('change', () => feedRefresh?.());
}
function disconnectStream() {
  stream?.close();
  stream = null;
}

// ---------------------------------------------------------------- live feed

async function feedView() {
  const root = show('#tpl-feed');
  $('[data-back]', root).onclick = () => go('');
  if (stream?.readyState === 1) $('[data-live]', root).classList.add('on');
  const list = $('[data-items]', root);
  let filter = store.get('gk_feed_filter', 'all');
  const filters = [['all', 'All'], ...(me.hub ? [['mine', `${area(me.hub)} only`]] : []), ['reentry', '🚨 Re-entries']];
  const host = $('[data-filters]', root);
  const drawFilters = () =>
    host.replaceChildren(...filters.map(([v, label]) => el('button', { type: 'button', 'aria-pressed': String(filter === v), text: label, onclick: () => {
      filter = v;
      store.set('gk_feed_filter', v);
      drawFilters();
      draw();
    } })));
  drawFilters();

  let items = [];
  function draw() {
    const shown = items.filter((i) => filter === 'all' || (filter === 'mine' && i.hub === me.hub) || (filter === 'reentry' && i.reentry));
    $('[data-empty]', root).hidden = shown.length > 0;
    list.replaceChildren(...shown.map((i) =>
      el('li', { class: `${i.status}${i.reentry ? ' reentry-item' : ''}` },
        el('div', { class: 'item-head' },
          el('span', { class: 'time', text: clock(i.at) }),
          el('span', { class: 'seat', text: i.seat }),
          el('span', { class: 'tag', text: STATUS[i.status] })),
        i.reentry ? el('span', { class: 're', text: '🚨 RE-ENTRY ATTEMPT' }) : null,
        i.reasoning ? el('div', { text: i.reasoning }) : null,
        i.description ? el('div', { text: `👤 ${i.description}` }) : null,
        el('small', { text: [`${area(i.hub)} · ${i.by}`, i.party > 1 ? `group of ${i.party}` : '', i.back_at && minsUntil(i.back_at) ? `back ${clock(i.back_at)} (${minsUntil(i.back_at)} min)` : ''].filter(Boolean).join(' · ') }),
        i.can_edit || i.can_delete
          ? el('div', { class: 'actions' }, el('button', { class: 'ghost', type: 'button', text: '✏️ Change', onclick: () => editView(i) }))
          : null)));
  }
  async function load() {
    const r = await api('/feed');
    if (!r.ok) return;
    items = r.items;
    draw();
  }
  let pending = null;
  feedRefresh = () => {
    clearTimeout(pending);
    pending = setTimeout(load, 300);
  };
  await load();
}

/** Back to the feed (the address may already be the feed's, so redraw it directly). */
const backToFeed = () => (location.hash === '#/feed' ? route() : go('feed'));

function editView(item) {
  feedRefresh = null;
  const root = show('#tpl-edit');
  $('[data-title]', root).textContent = `Change ${item.seat}`;
  $('[data-back]', root).onclick = () => backToFeed();
  const state = { status: item.status, party: item.party };
  // Area supervisors can only make a record more serious (sent away < refused < ejected).
  const RANK = { admitted: 0, sent_away: 1, refused: 2, ejected: 3 };
  const statuses = [['sent_away', '🟠 Sent away'], ['refused', '🔴 Refused'], ['ejected', '⛔ Ejected'], ...(item.can_delete ? [['admitted', '🟢 Cleared to enter']] : [])]
    .filter(([v]) => item.can_delete || RANK[v] >= RANK[item.status]);
  const host = $('[data-status]', root);
  const draw = () => host.replaceChildren(...statuses.map(([v, label]) => el('button', { type: 'button', 'aria-pressed': String(state.status === v), text: label, onclick: () => {
    state.status = v;
    draw();
  } })));
  draw();
  const reasonIn = $('[data-reasoning]', root);
  const descIn = $('[data-description]', root);
  reasonIn.value = item.reasoning.replace(/^Ejected:?\s*/, '');
  descIn.value = item.description;
  const partyEl = $('[data-party]', root);
  partyEl.textContent = state.party;
  $('[data-party-minus]', root).onclick = () => { state.party = Math.max(1, state.party - 1); partyEl.textContent = state.party; };
  $('[data-party-plus]', root).onclick = () => { state.party = Math.min(50, state.party + 1); partyEl.textContent = state.party; };

  $('[data-save]', root).onclick = async () => {
    const body = {};
    if (state.status !== item.status) body.status = state.status;
    if (reasonIn.value.trim() !== item.reasoning.replace(/^Ejected:?\s*/, '')) body.reasoning = reasonIn.value.trim();
    if (descIn.value.trim() !== item.description) body.description = descIn.value.trim();
    if (state.party !== item.party) body.party = state.party;
    if (!Object.keys(body).length) return backToFeed();
    const r = await api(`/records/${encodeURIComponent(item.ticket_id)}`, { method: 'PATCH', body });
    if (!r.ok) return toast(r.error);
    toast(`${item.seat} saved.`);
    backToFeed();
  };
  if (item.can_delete) {
    const del = $('[data-delete]', root);
    del.hidden = false;
    del.onclick = async () => {
      if (!confirm(`Delete the record for ${item.seat}? This can’t be undone.`)) return;
      const r = await api(`/records/${encodeURIComponent(item.ticket_id)}`, { method: 'DELETE' });
      if (!r.ok) return toast(r.error);
      toast(`${item.seat} deleted.`);
      backToFeed();
    };
  }
}

// ---------------------------------------------------------------- dashboard, events, settings

function page(title) {
  const root = show('#tpl-page');
  $('[data-title]', root).textContent = title;
  $('[data-back]', root).onclick = () => go('');
  return $('[data-body]', root);
}
const block = (title, ...children) => el('div', { class: 'block' }, el('h2', { text: title }), ...children);
const dateTime = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function bars(entries) {
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return el('div', { class: 'bars' }, ...entries.map(([label, n]) =>
    el('div', { class: 'bar-row' },
      el('span', { text: label }),
      el('span', { class: 'track' }, el('span', { class: 'fill', style: `width:${(n / max) * 100}%; display:block` })),
      el('b', { text: String(n) }))));
}

/** Counters, charts and (when there is a plan) the map, for the dashboard and event reports. */
async function renderSummary(host, s, withMap) {
  const c = s.counts;
  const counter = (cls, n, label) => el('div', { class: `counter ${cls}` }, el('b', { text: String(n) }), el('span', { text: label }));
  host.append(el('div', { class: 'counters' },
    counter('refused', c.refused, 'Refused'),
    counter('ejected', c.ejected, 'Ejected'),
    counter('away', c.away_now, `Sent away now${c.back_soon ? ` · ${c.back_soon} back soon` : ''}`),
    counter('refused', c.reentries, 'Re-entry attempts'),
    counter('', c.logged, 'Logged'),
    counter('', c.people, 'People'),
    counter('', c.minors, 'Minors'),
    counter('ok', c.cleared, 'Cleared')));
  host.append(block('By area', bars(Object.entries(s.by_hub).map(([h, n]) => [area(h), n]))));
  if (s.by_reason.length) host.append(block('By reason', bars(s.by_reason.slice(0, 8).map((r) => [r.reason, r.count]))));
  const maxH = Math.max(1, ...s.by_hour.map((h) => h.count));
  host.append(block('By hour', el('div', { class: 'hours' }, ...s.by_hour.map((h) =>
    el('div', { class: 'col', title: `${h.hour}: ${h.count}` },
      h.count ? el('b', { text: String(h.count) }) : null,
      el('i', { style: `height:${(h.count / maxH) * 85}%` }),
      el('span', { text: h.hour.slice(0, 2) }))))));
  if (!withMap) return;
  const m = await api('/map');
  if (!m.ok) return;
  if (!m.has_image) {
    host.append(block('Seating map', el('p', { class: 'muted', text: me.role === 'superadmin' ? 'Add the seating plan in Settings to see sections light up here.' : 'The superadmin can add the seating plan in Settings.' })));
    return;
  }
  host.append(block('Seating map', planView(m.blocks, s.sections)));
}

/** The plan image with a dot per placed section (red: refused/ejected, orange: sent away). */
function planView(blocks, sections, onTap) {
  const plan = el('div', { class: `plan${onTap ? ' editing' : ''}` }, el('img', { src: `/api/app/map/image?v=${Date.now()}`, alt: 'Seating plan' }));
  for (const [name, pos] of Object.entries(blocks)) {
    const c = sections?.[name];
    const cls = !c || !c.total ? 'empty' : c.refused + c.ejected ? 'refused' : c.away ? 'away' : '';
    const dot = el('span', { class: `dot ${cls}`, style: `left:${pos.x * 100}%; top:${pos.y * 100}%`, title: c ? `${name}: ${c.total} logged` : name, text: c?.total ? `${name} · ${c.total}` : name });
    if (onTap) dot.addEventListener('click', (e) => { e.stopPropagation(); onTap({ remove: name }); });
    plan.append(dot);
  }
  if (onTap) {
    plan.addEventListener('click', (e) => {
      const r = plan.getBoundingClientRect();
      onTap({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    });
  }
  return plan;
}

async function dashboardView() {
  const body = page('Dashboard');
  async function load() {
    const d = await api('/dashboard');
    if (!d.ok) return;
    const head = d.event
      ? el('div', { class: 'event-bar running' }, el('span', {}, document.createTextNode(`🏁 ${d.event.name}`), el('small', { text: `Running since ${clock(d.event.started_at)}` })),
          el('button', { class: 'ghost', type: 'button', text: 'Events', style: 'color:#fff;border-color:#475569', onclick: () => go('events') }))
      : el('div', { class: 'event-bar' }, el('span', {}, document.createTextNode('No event running'), el('small', { text: 'Showing the last 12 hours' })),
          el('button', { class: 'primary', type: 'button', text: 'Start an event', onclick: () => go('events') }));
    const fresh = el('div');
    fresh.append(head);
    await renderSummary(fresh, d, true);
    body.replaceChildren(fresh);
  }
  let pending = null;
  feedRefresh = () => { clearTimeout(pending); pending = setTimeout(load, 500); };
  await load();
}

async function eventsView() {
  const body = page('Events & reports');
  async function load() {
    const r = await api('/events');
    if (!r.ok) return;
    const running = r.events.find((e) => !e.ended_at);
    const nameIn = el('input', { maxlength: '80', placeholder: 'e.g. Celtic v Rangers', 'aria-label': 'Event name' });
    const top = running
      ? block('Running now', el('p', { text: `🏁 ${running.name}, since ${dateTime(running.started_at)} (started by ${running.started_by})` }),
          el('button', { class: 'danger big', type: 'button', text: 'End the event and keep the final numbers', onclick: async () => {
            if (!confirm(`End “${running.name}”? Its final numbers are kept for good.`)) return;
            const e = await api('/events/end', { method: 'POST', body: {} });
            if (!e.ok) return toast(e.error);
            toast('Event ended. Final numbers saved.');
            reportView(e.event.id);
          } }))
      : block('Start an event', nameIn, el('button', { class: 'primary big', type: 'button', text: 'Start', onclick: async () => {
          const e = await api('/events/start', { method: 'POST', body: { name: nameIn.value } });
          if (!e.ok) return toast(e.error);
          toast(`“${e.event.name}” started.`);
          load();
        } }));
    const past = r.events.filter((e) => e.ended_at);
    body.replaceChildren(top, block('Past events', past.length
      ? el('ul', { class: 'events-list' }, ...past.map((e) => el('li', {}, el('button', { type: 'button', onclick: () => reportView(e.id) },
          el('strong', { text: e.name }),
          el('small', { text: `${dateTime(e.started_at)} · ${e.summary?.counts.logged ?? 0} logged · ${e.summary?.counts.reentries ?? 0} re-entries` })))))
      : el('p', { class: 'muted', text: 'None yet. End an event to keep its numbers here.' })));
  }
  await load();
}

async function reportView(id) {
  const body = page('Event report');
  $('[data-back]').onclick = () => (location.hash === '#/events' ? route() : go('events'));
  const r = await api(`/events/${encodeURIComponent(id)}/report`);
  if (!r.ok) return toast(r.error);
  body.append(el('div', { class: 'event-bar' }, el('span', {}, document.createTextNode(`🏁 ${r.event.name}`),
    el('small', { text: `${dateTime(r.event.started_at)} – ${r.event.ended_at ? clock(r.event.ended_at) : 'still running'}` }))));
  await renderSummary(body, r.summary, false);
  body.append(block('Spreadsheet', el('p', { class: 'muted', text: 'Every record from this event (kept for 30 days).' }),
    el('a', { class: 'dl', href: `/api/app/events/${encodeURIComponent(id)}/records.csv`, download: '', text: '⬇️ Download spreadsheet' })));
}

async function settingsView() {
  const body = page('Settings');
  const r = await api('/settings');
  if (!r.ok) return toast(r.error);
  const st = r.settings;
  const venue = el('input', { maxlength: '60', value: st.venue_name, placeholder: 'e.g. The Hydro' });
  const policy = el('textarea', { rows: '6', maxlength: '4000', placeholder: 'e.g. Under 18s with alcohol: refuse and call a senior supervisor.' });
  policy.value = st.policy;
  const ai = el('input', { type: 'checkbox' });
  ai.checked = st.ai_enabled;
  body.append(block('General',
    el('label', {}, document.createTextNode('Venue name'), venue),
    el('label', {}, document.createTextNode('Refusal policy'), policy),
    el('label', { class: 'switch' }, ai, document.createTextNode('AI helper (“describe in a sentence”)')),
    el('button', { class: 'primary big', type: 'button', text: 'Save', onclick: async () => {
      const s2 = await api('/settings', { method: 'PUT', body: { venue_name: venue.value, policy: policy.value, ai_enabled: ai.checked } });
      if (!s2.ok) return toast(s2.error);
      options = null; // the logging screen reads these
      toast('Settings saved.');
    } })));

  const mapBox = el('div');
  const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
  upload.addEventListener('change', async () => {
    const f = upload.files?.[0];
    if (!f) return;
    const res = await fetch('/api/app/map/image', { method: 'PUT', headers: { 'content-type': f.type }, body: f, credentials: 'same-origin' });
    const d = await res.json().catch(() => ({}));
    if (!d.ok) return toast(d.error || 'Upload failed.');
    toast('Plan uploaded. Now tap where each section is.');
    drawMap();
  });
  async function drawMap() {
    const m = await api('/map');
    if (!m.ok) return;
    if (!m.has_image) return mapBox.replaceChildren(el('p', { class: 'muted', text: 'Upload a picture of the seating plan, then tap where each section is.' }));
    mapBox.replaceChildren(
      el('p', { class: 'muted hint', text: 'Tap the plan to place a section; tap a section to remove it.' }),
      planView(m.blocks, null, async (t) => {
        if (t.remove) {
          if (!confirm(`Remove section ${t.remove} from the plan?`)) return;
          await api(`/map/blocks/${encodeURIComponent(t.remove)}`, { method: 'DELETE' });
        } else {
          const name = prompt('Which section is here? (e.g. 313)');
          if (!name) return;
          const d = await api(`/map/blocks/${encodeURIComponent(name.trim().toUpperCase())}`, { method: 'PUT', body: { x: t.x, y: t.y } });
          if (!d.ok) return toast(d.error);
        }
        drawMap();
      }));
  }
  body.append(block('Seating plan', el('label', {}, document.createTextNode('Plan picture'), upload), mapBox));
  drawMap();
  body.append(block('People', el('button', { class: 'ghost big', type: 'button', text: '👥 Add people, PINs and roles', onclick: () => go('people') })));
}

// ---------------------------------------------------------------- routing

function go(page) {
  location.hash = page ? `#/${page}` : '#/';
}

async function route() {
  if (!me) {
    const r = await api('/me', { allow401: true });
    if (r.ok) me = r.user;
    else {
      setHeader();
      return r.needs_setup ? setupView() : loginView();
    }
  }
  setHeader();
  connectStream();
  feedRefresh = null;
  const page = location.hash.replace(/^#\/?/, '');
  if (page === 'people' && me.role === 'superadmin') return peopleView();
  if (page === 'log') return logView();
  if (page === 'check') return checkView();
  if (page === 'dashboard' && isAdmin()) return dashboardView();
  if (page === 'events' && isAdmin()) return eventsView();
  if (page === 'settings' && me.role === 'superadmin') return settingsView();
  if (page === 'feed') {
    connectStream();
    return feedView();
  }
  homeView();
  flushQueue();
}

$('#logoutBtn').addEventListener('click', async () => {
  const waiting = queued();
  if (waiting.length) {
    await flushQueue();
    const still = queued();
    if (still.length) {
      if (!confirm(`${still.length} log${still.length === 1 ? '' : 's'} not sent yet (no signal). Log out anyway and delete ${still.length === 1 ? 'it' : 'them'} from this phone?`)) return;
      setQueue(allQueued().filter((e) => e.user_id !== me.id));
    }
  }
  await api('/logout', { method: 'POST', body: {}, allow401: true });
  disconnectStream();
  $('#alerts').replaceChildren();
  me = null;
  $('#toast').hidden = true;
  go('');
  route();

// Works without signal once opened: the app's files are kept on the phone.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => undefined);
});
window.addEventListener('hashchange', route);
route();

// Works without signal once opened: the app's files are kept on the phone.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => undefined);
