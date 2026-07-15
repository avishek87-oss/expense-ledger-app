'use strict';
// ── Google Sign-In ─────────────────────────────────────────────────────────
const AUTH_KEY = 'household-ledger-auth-v1';
let auth = null; // { email, idToken }

function loadAuth() { try { const r = localStorage.getItem(AUTH_KEY); if (r) auth = JSON.parse(r); } catch(e){} }
function saveAuth() { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); }

// Get a native Capacitor plugin in a bundler-less app: the injected bridge
// exposes plugins on Capacitor.Plugins; registerPlugin only exists with the
// full @capacitor/core JS bundle, so try both.
function getNativePlugin(name) {
  const c = window.Capacitor;
  if (!c) return null;
  try {
    if (c.Plugins && c.Plugins[name]) return c.Plugins[name];
    if (typeof c.registerPlugin === 'function') return c.registerPlugin(name);
  } catch (e) {}
  return null;
}

let slPlugin = null, slInited = false;
async function ensureSocialLogin() {
  if (!IS_NATIVE) return null;
  if (!slPlugin) slPlugin = getNativePlugin('SocialLogin');
  if (!slPlugin) return null;
  if (!slInited) {
    await slPlugin.initialize({ google: { webClientId: GOOGLE_WEB_CLIENT_ID } });
    slInited = true;
  }
  return slPlugin;
}

let lastLoginError = '';
async function googleSignIn() {
  lastLoginError = '';
  try {
    const SL = await ensureSocialLogin();
    if (!SL) {
      const names = (window.Capacitor && window.Capacitor.Plugins) ? Object.keys(window.Capacitor.Plugins).join(',') : 'none';
      lastLoginError = 'Sign-in plugin unavailable (registered: ' + names + ')';
      return false;
    }
    // No custom scopes: Google returns email+profile by default, and passing
    // scopes requires extra native MainActivity wiring we don't need.
    const res = await SL.login({ provider:'google', options:{} });
    const r = (res && res.result) || res || {};
    const idToken = r.idToken || (r.authentication && r.authentication.idToken);
    if (!idToken) { lastLoginError = 'No ID token in response: ' + JSON.stringify(res).slice(0,200); return false; }
    auth = { email: (r.profile && r.profile.email) || '', idToken };
    saveAuth();
    return true;
  } catch (e) {
    lastLoginError = (e && (e.message || e.code)) ? ((e.code ? e.code + ': ' : '') + (e.message || '')) : String(e);
    return false;
  }
}

function showLogin(show) {
  const el = document.getElementById('login-overlay');
  if (el) el.classList.toggle('hidden', !show);
}

async function doLogin() {
  const err = document.getElementById('login-err');
  err.textContent = '';
  if (await googleSignIn()) {
    showLogin(false);
    pullFromSheets();
  } else {
    err.textContent = 'Sign-in failed: ' + (lastLoginError || 'unknown error');
  }
}

// ── Google Sheets sync (via GAS JSON API) ──────────────────────────────────
// POST uses text/plain to stay a "simple" CORS request — GAS can't answer
// preflight OPTIONS, but returns Access-Control-Allow-Origin:* on simple ones.
let pushDirty = false;   // a save happened while a push was in flight
let pushBusy  = false;
let lastPullAt = 0;

// Header sync-dot alone is too easy to miss — a push that keeps failing means
// a real, silently-lost edit (this is exactly how a fixed item added on one
// phone got wiped out before either of you noticed). Surface a banner once a
// failure repeats, not on the first blip (a single transient hiccup that
// self-heals on the next save shouldn't interrupt anyone).
let consecutivePushFailures = 0;
const SYNC_FAIL_BANNER_THRESHOLD = 2;
let syncFailBannerDismissed = false;

function updateSyncFailBanner() {
  const el = document.getElementById('sync-fail-banner');
  if (!el) return;
  const show = consecutivePushFailures >= SYNC_FAIL_BANNER_THRESHOLD && !syncFailBannerDismissed;
  el.classList.toggle('hidden', !show);
}
function dismissSyncFailBanner() {
  syncFailBannerDismissed = true;
  updateSyncFailBanner();
}
function retrySyncNow() {
  syncFailBannerDismissed = false;
  pushToSheets();
}

// Bounds how long a GAS round trip can hang (e.g. a cold Apps Script
// container) instead of relying on the browser's much longer default timeout.
function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  return fetch(url, { ...(opts || {}), signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function scheduleSync() {
  setPendingSync(true);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; pushToSheets(); }, 1500);
}

// Fire-and-forget activity log entry — appended as a row in a separate Sheet
// tab (not the synced appState blob), so it never affects the main sync payload
// and a failure here must never block or roll back the actual data save.
// The server stamps the verified email itself (from the id token), so we only
// send the action description here — never a client-claimed identity.
function logActivity(action) {
  if (!IN_GAS || !auth || !auth.idToken || !action) return;
  try {
    fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ idToken: auth.idToken, op: 'log', entry: action }),
    }).catch(() => {});
  } catch (e) {}
}

// ID tokens expire after ~1h. On an auth error, silently re-login once and
// retry; if that fails too, surface the sign-in screen.
async function withAuthRetry(call) {
  if (!auth || !auth.idToken) { showLogin(true); return null; }
  let j = await call();
  if (j && !j.ok && (j.error === 'expired' || j.error === 'unauthorized')) {
    if (await googleSignIn()) j = await call();
    else { showLogin(true); return null; }
    if (j && !j.ok && (j.error === 'expired' || j.error === 'unauthorized')) { showLogin(true); return null; }
  }
  return j;
}

async function pushToSheets() {
  if (pushBusy) { pushDirty = true; return; }
  if (!navigator.onLine) { setSyncState('offline'); return; } // safe locally; retried on next save/resume/boot
  pushBusy = true;
  setSyncState('busy');
  try {
    const j = await withAuthRetry(async () => {
      const res = await fetchWithTimeout(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ idToken: auth.idToken, data: JSON.stringify(appState) }),
      }, 8000);
      return res.json();
    });
    setSyncState(j && j.ok ? 'ok' : 'err');
    if (j && j.ok) {
      setPendingSync(false);
      consecutivePushFailures = 0;
      syncFailBannerDismissed = false;
    } else {
      consecutivePushFailures++;
    }
    updateSyncFailBanner();
  } catch (e) {
    setSyncState('err'); // offline or GAS unreachable — data is safe locally
    consecutivePushFailures++;
    updateSyncFailBanner();
  }
  pushBusy = false;
  if (pushDirty) { pushDirty = false; scheduleSync(); }
}

async function pullFromSheets() {
  // Local changes waiting to push win over a pull — let the push finish first
  if (pushBusy || pushDirty || syncTimer) return;
  if (Date.now() - lastPullAt < 15000) return; // avoid re-pulling on rapid app-switching
  if (!navigator.onLine) { setSyncState('offline'); return; }
  lastPullAt = Date.now();
  setSyncState('busy');
  try {
    const j = await withAuthRetry(async () => {
      const res = await fetchWithTimeout(GAS_URL + '?id_token=' + encodeURIComponent(auth.idToken), null, 8000);
      return res.json();
    });
    // A local edit may have landed while the fetch was in flight — if so, don't
    // clobber it; the pending push will carry our data up instead. (Closes a
    // read-modify-write race that could reset just-entered values, e.g. the
    // Neha opening balance, back to the older remote value.)
    if (pushBusy || pushDirty || syncTimer) { setSyncState('ok'); return; }
    if (j && j.ok) {
      const remote = JSON.parse(j.data);
      if (remote && Object.keys(remote.months||{}).length > 0) { appState = remote; saveLocal(); render(); renderMenu(); }
      setSyncState('ok');
    } else setSyncState('err');
  } catch (e) {
    setSyncState('err');
  }
}
function setSyncState(s) {
  // Any confirmed-good sync — whether a successful push OR a successful pull —
  // means data is safe on the server again, so the "couldn't save" banner must
  // clear itself. (A pull that succeeds after failed pushes used to leave the
  // banner stuck on screen until the user manually tapped ✕.)
  if (s === 'ok') {
    consecutivePushFailures = 0;
    syncFailBannerDismissed = false;
    updateSyncFailBanner();
  }
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-lbl');
  if (!dot) return;
  dot.className = s==='ok'?'ok':s==='busy'?'busy':(s==='err'||s==='offline')?'err':'ok';
  lbl.textContent = s==='ok'?'Synced':s==='busy'?'Syncing…':s==='err'?'Error':s==='offline'?'Offline':'Saved';
}

