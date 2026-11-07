// Who's signed in (Gen's own accounts: Continue with Google), credits, plans and packs, and the AI: Gen's own (the
// house AI, charged in credits) unless the account connected its own Anthropic API key or Claude subscription.

import { $, $$, h, api, toast, bus, icon } from './lib.js';

export const state = { user: null, admin: false, ai: null };

export async function loadMe() {
  try {
    // index.html starts this request before the scripts load; use its answer once, else ask.
    const early = window.__hgMe ? await window.__hgMe : null;
    window.__hgMe = null;
    if (early) { try { state.user = early.ok ? JSON.parse(early.text).user ?? null : null; } catch { state.user = null; } }
    else state.user = (await api('/v1/users/me')).user;
  } catch { state.user = null; }
  // Signed out there is nothing to ask: /v1/me would only answer 401 (a console error on every anonymous load).
  state.admin = false;
  if (state.user) { try { const c = await api('/v1/me'); state.admin = c.role === 'owner' || c.role === 'admin'; } catch { state.admin = false; } }
  showMe();
  if (state.user) loadAi();
}
export async function loadAi() {
  try { state.ai = await api('/v1/users/me/ai'); } catch { state.ai = null; }
  bus.emit('ai', state.ai);
}
// Gen gives every account the house AI (src/houseai.ts): the person connects nothing while it's ready. Their own key
// or subscription still works, and comes first.
export const hasAi = () => Boolean(state.ai?.house?.ready || state.ai?.anthropic?.set || state.ai?.claudeSubscription?.set);

function showMe() {
  const u = state.user;
  $('#signInBtn').hidden = Boolean(u);
  $('#accountBtn').hidden = !u;
  $('#creditsPill').hidden = !u;
  $('#adminLink').hidden = !state.admin;
  if (u) {
    $('#accountBtn').textContent = (u.name || u.email || '?').trim().slice(0, 1).toUpperCase();
    $('#accountBtn').title = u.email;
    $('#creditsCount').textContent = Number(u.credits ?? 0).toLocaleString();
    // Running low: the pill says so before anything fails.
    const low = Number(u.credits ?? 0) < 25;
    $('#creditsPill').classList.toggle('low', low);
    $('#creditsPill').title = low ? 'Running low: add credits, packs and plans (1 credit = 1 cent)' : 'Credits: packs and plans (1 credit = 1 cent)';
  }
}
export const refreshCredits = () => api('/v1/users/me').then((m) => { state.user = m.user; showMe(); }).catch(() => {});

// Continue with Google (POST /v1/users/google); email and password only where Google isn't set up (local runs).
let afterSignIn = null;
let authMode = 'login';
const signin = { clientId: null, passwords: false, ready: null };
function loadGoogle() {
  signin.ready ??= api('/v1/users/google').then((g) => {
    signin.clientId = g.clientId;
    signin.passwords = Boolean(g.passwords);
    if (!g.clientId) return;
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => { google.accounts.id.initialize({ client_id: g.clientId, callback: (r) => googleDone(r.credential), ux_mode: 'popup' }); resolve(); };
      s.onerror = () => resolve();
      document.head.append(s);
    });
  }).catch(() => {});
  return signin.ready;
}
async function signedIn(created) {
  $('#authDialog').close();
  await loadMe();
  bus.emit('signedIn', state.user);
  if (created) { toast(`Welcome! You have ${state.user?.credits ?? 0} free credits.`); bus.emit('welcome'); }
  const then = afterSignIn;
  afterSignIn = null;
  if (then) then();
}
async function googleDone(credential) {
  try { const r = await api('/v1/users/google', { body: { credential } }); await signedIn(r.created); } catch (err) { showAuthError(err.message); }
}
function showAuthError(msg) { $('#authError').textContent = msg; $('#authError').hidden = false; }
async function showSignIn() {
  await loadGoogle();
  const box = $('#googleBtn');
  box.replaceChildren();
  const g = signin.clientId && globalThis.google?.accounts?.id;
  if (g) google.accounts.id.renderButton(box, { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
  box.hidden = !g;
  $('#passwordAuth').hidden = Boolean(g) || !signin.passwords;
  $('#authSubmit').hidden = $('#passwordAuth').hidden;
  if (!g && !signin.passwords) showAuthError('Sign-in is not set up on this Gen yet.');
}
function setAuthMode(mode) {
  authMode = mode;
  $$('#authDialog .tab').forEach((t) => t.classList.toggle('on', t.dataset.mode === mode));
  $('#nameField').hidden = mode !== 'signup';
  $('#authSubmit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
}
/** Runs `then` now if signed in, else after signing in. */
export function needSignIn(then, mode = 'signup') {
  if (state.user) return then();
  afterSignIn = then;
  setAuthMode(mode);
  $('#authError').hidden = true;
  $('#authDialog').showModal();
  showSignIn();
}

export function initAccount() {
  $$('#authDialog .tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
  $('#authCancel').addEventListener('click', () => { afterSignIn = null; $('#authDialog').close(); });
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { email: $('#authEmail').value, password: $('#authPassword').value, ...(authMode === 'signup' ? { name: $('#authName').value } : {}) };
    try { await api(authMode === 'signup' ? '/v1/users/signup' : '/v1/users/login', { body }); await signedIn(authMode === 'signup'); } catch (err) { showAuthError(err.message); }
  });
  $('#signInBtn').addEventListener('click', () => needSignIn(() => {}, 'login'));
  $('#accountBtn').addEventListener('click', (e) => accountMenu(e.currentTarget));
  $('#creditsPill').addEventListener('click', () => openAccount('credits'));
  $('#accountClose').addEventListener('click', () => $('#accountDialog').close());
  // A click on the dimmed outside closes the sheet too.
  $('#accountDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('#billingPortalBtn').addEventListener('click', () => go('/v1/billing/portal', null, 'POST'));
  const back = new URLSearchParams(location.search).get('checkout');
  if (back === 'success') { toast('Thanks: your credits are on their way.'); setTimeout(refreshCredits, 2500); }
  // /#credits opens the credits (the Unity plugin's Buy credits button links here).
  if (location.hash === '#credits') loadMe().then(() => openAccount('credits'));
}

export async function signOut() {
  await api('/v1/users/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

/** The avatar's menu: who's signed in and their credits, the account, help, the admin dashboard for admins, and Sign out last. */
async function accountMenu(btn) {
  const u = state.user;
  if (!u) return needSignIn(() => {}, 'login');
  const { popMenu, closeMenus } = await import('./timeline.js');
  const r = btn.getBoundingClientRect();
  const item = (ic, label, fn, cls = '') => h('button', { class: `menu-item ${cls}`, onclick: () => { closeMenus(); fn(); } }, h('span', { class: 'row' }, icon(ic), label));
  popMenu(r.right - 260, r.bottom + 6, [
    h('div', { class: 'acct-menu-head' }, h('span', { class: 'avatar' }, initial(u)), h('div', {}, h('b', {}, u.name || u.email), h('div', { class: 'muted small' }, `${Number(u.credits ?? 0).toLocaleString()} credits`))),
    h('div', { class: 'menu-sep' }),
    item('person', 'Account and credits', () => openAccount()),
    item('plus', 'Add credits', () => openAccount('credits')),
    state.admin ? item('sliders', 'Admin dashboard', () => open('/admin', '_blank')) : '',
    item('help', 'Help and shortcuts', () => document.querySelector('#helpBtn')?.click()),
    h('div', { class: 'menu-sep' }),
    item('logout', 'Sign out', () => signOut(), 'danger'),
  ]);
}
const initial = (u) => (u.name || u.email || '?').trim().slice(0, 1).toUpperCase();

async function go(path, body, method) {
  try { const r = await api(path, { method: method ?? 'POST', body }); if (r.url) location.href = r.url; } catch (err) { $('#accountError').textContent = err.message; $('#accountError').hidden = false; }
}

export async function openAccount(section) {
  if (!state.user) return needSignIn(() => openAccount(section), 'login');
  $('#accountAvatar').textContent = initial(state.user);
  $('#accountName').textContent = state.user.name || state.user.email || '';
  $('#accountEmail').textContent = state.user.name ? state.user.email ?? '' : '';
  $('#accountCredits').textContent = Number(state.user.credits ?? 0).toLocaleString();
  $('#accountError').hidden = true;
  const plansBox = $('#plans');
  plansBox.replaceChildren();
  try {
    const [{ plans = [], stripe = {} }, { subscription: sub }] = await Promise.all([api('/v1/subscriptions/plans'), api('/v1/subscriptions/me')]);
    const cur = sub && sub.status !== 'canceled' ? plans.find((p) => p.id === sub.planId) : null;
    if (cur) {
      const ends = new Date(sub.currentPeriodEnd).toLocaleDateString();
      plansBox.append(h('div', { class: 'plan-current' },
        h('div', {}, h('b', {}, cur.name), ` · ${cur.creditsPerMonth.toLocaleString()} credits a month`),
        h('div', { class: 'muted' }, sub.status === 'past_due' ? h('span', { class: 'error' }, 'Payment failed: update your card. ') : '', sub.cancelAtPeriodEnd ? `Ends ${ends}` : `Renews ${ends}`),
        h('button', { class: 'ghost small', onclick: () => go(`/v1/subscriptions/${sub.cancelAtPeriodEnd ? 'resume' : 'cancel'}`).then(() => openAccount()) }, sub.cancelAtPeriodEnd ? 'Keep my plan' : 'Cancel at the end of the month')));
    } else if (!stripe.configured) {
      plansBox.append(h('p', { class: 'muted small acct-note' }, 'Plans open soon.'));
    } else {
      for (const p of plans) plansBox.append(h('button', { class: 'acct-pack', onclick: () => go('/v1/subscriptions/checkout', { planId: p.id }) },
        h('span', { class: 'acct-pack-name' }, p.name), h('b', { class: 'acct-pack-credits' }, p.creditsPerMonth.toLocaleString()), h('span', { class: 'muted small' }, 'credits every month'),
        h('span', { class: 'acct-pack-price' }, `$${(p.priceCents / 100).toFixed(0)} a month`)));
    }
  } catch { plansBox.append(h('p', { class: 'muted small acct-note' }, 'Plans aren\'t available for this account.')); }
  $('#billingPortalBtn').hidden = !state.user.hasBilling;
  const box = $('#packs');
  box.replaceChildren();
  try {
    const p = await api('/v1/billing/packs');
    const packs = p.packs ?? [];
    if (!packs.length || p.stripe?.configured === false) box.append(h('p', { class: 'muted small acct-note' }, 'Buying credits isn\'t open here yet.'));
    const best = packs.length > 2 ? packs[1].id : null;
    for (const pack of packs) box.append(h('button', { class: `acct-pack${pack.id === best ? ' best' : ''}`, onclick: () => go('/v1/billing/checkout', { packId: pack.id }) },
      pack.id === best ? h('span', { class: 'acct-badge' }, 'Most popular') : pack.bonusPercent ? h('span', { class: 'acct-badge' }, `+${pack.bonusPercent}% bonus`) : '',
      h('span', { class: 'acct-pack-name' }, pack.name ?? 'Credits'), h('b', { class: 'acct-pack-credits' }, pack.credits.toLocaleString()), h('span', { class: 'muted small' }, 'credits'),
      h('span', { class: 'acct-pack-price' }, `$${pack.priceUsd ?? (pack.priceCents ?? 0) / 100}`)));
  } catch (err) { box.append(h('p', { class: 'muted' }, err.message)); }
  await loadAi();
  // "Your AI" only matters when Gen's own isn't there for them.
  const own = !state.ai?.house?.ready || state.ai?.anthropic?.set || state.ai?.claudeSubscription?.set;
  $('#aiKeysTitle').hidden = !own && !state.ai?.anthropic?.set && !state.ai?.claudeSubscription?.set && section !== 'ai';
  $('#aiKeysTitle').open = section === 'ai' || !state.ai?.house?.ready;
  drawAiKeys($('#aiKeys'));
  import('./memory.js').then((m) => m.drawMemory($('#aiMemory')));
  $('#accountDialog').showModal();
  if (section === 'ai') $('#aiKeys').scrollIntoView({ block: 'center' });
  if (section === 'credits') $('#acctPacksTitle').scrollIntoView({ block: 'start' });
}

/** The "Your AI" box: connect an Anthropic API key or a Claude subscription token (shown again from the AI pane). */
export function drawAiKeys(box) {
  box.replaceChildren();
  const row = (kind, title, hint, placeholder, info) => {
    const set = info?.set;
    const input = h('input', { type: 'password', placeholder, autocomplete: 'off', spellcheck: 'false' });
    return h('div', { class: 'ai-key' },
      h('div', { class: 'ai-key-head' }, h('b', {}, title), set ? h('span', { class: 'ok' }, `Connected ····${info.last4}`) : ''),
      h('p', { class: 'muted small' }, hint),
      set
        ? h('button', { class: 'ghost small', onclick: async () => { await api(`/v1/users/me/ai/${kind}`, { method: 'DELETE' }); await loadAi(); drawAiKeys(box); } }, 'Disconnect')
        : h('form', { class: 'inline', onsubmit: async (e) => {
          e.preventDefault();
          try { await api(`/v1/users/me/ai/${kind}`, { method: 'PUT', body: { key: input.value.trim() } }); toast('Connected.'); await loadAi(); drawAiKeys(box); } catch (err) { toast(err.message); }
        } }, input, h('button', { class: 'primary small' }, 'Connect')));
  };
  box.append(
    row('anthropic', 'Anthropic API key', h('span', {}, 'Make one at ', h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), '. Anthropic bills you for what the AI editor uses.'), 'sk-ant-api03-…', state.ai?.anthropic),
    row('claude-subscription', 'Or your Claude subscription', h('span', {}, 'In a terminal with Claude Code, run ', h('code', {}, 'claude setup-token'), ' and paste what it prints. Uses your Claude plan.'), 'sk-ant-oat01-…', state.ai?.claudeSubscription),
    h('p', { class: 'muted small' }, 'Stored encrypted, used only for your own AI editor, never shown again.'));
}
