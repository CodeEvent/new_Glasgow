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
    me = null;
    route();
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
  const soon = 'Coming in the next update';
  tiles.append(
    tile('➕', 'Log someone', me.role === 'area' ? `Refused, 30 min or ejected at ${area(me.hub)}` : 'Refused, 30 min or ejected', { wide: true }),
    tile('🔎', 'Check a seat', soon),
    tile('📡', 'Live feed', soon),
  );
  if (isAdmin()) tiles.append(tile('📊', 'Dashboard', soon), tile('🏁', 'Events & reports', soon));
  if (me.role === 'superadmin') tiles.append(tile('👥', 'People', 'Add people, PINs, roles', { go: () => go('people') }), tile('⚙️', 'Settings', soon));
  for (const b of tiles.querySelectorAll('.tile[disabled] small')) if (b.textContent === soon) b.closest('.tile').title = soon;
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
    $('[data-pin-hint]', root).textContent = '(4–8 digits; 6–8 for seniors and superadmins)';
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
  const page = location.hash.replace(/^#\/?/, '');
  if (page === 'people' && me.role === 'superadmin') return peopleView();
  homeView();
}

$('#logoutBtn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: {}, allow401: true });
  me = null;
  $('#toast').hidden = true;
  go('');
  route();
});
window.addEventListener('hashchange', route);
route();
