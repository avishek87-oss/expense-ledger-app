'use strict';
// ── Self-update (Capacitor + capgo updater) ────────────────────────────────
// Checks version.json on GitHub; if a newer bundle exists, downloads and
// switches to it. Data (localStorage) is untouched. Silent when offline.
function updStatus(msg) {
  const el = document.getElementById('app-ver');
  if (el) el.textContent = 'v' + APP_VERSION + (msg ? ' · ' + msg : '');
}
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i]||0) - (pb[i]||0); if (d) return d; }
  return 0;
}
async function fetchVersionInfo() {
  if (!UPDATE_URL.startsWith('https://')) return null;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(LAST_VERSION_CHECK_KEY) || 'null'); } catch (e) {}
  // Self-update relevance doesn't change minute to minute — skip the round
  // trip if we checked recently, and fall back to the last known answer
  // (rather than null) when offline so the mandatory-update gate still works.
  if (cached && Date.now() - cached.at < VERSION_CHECK_THROTTLE_MS) return cached.info;
  if (!navigator.onLine) return cached ? cached.info : null;
  try {
    const r = await fetchWithTimeout(UPDATE_URL + '?t=' + Date.now(), { cache:'no-store' }, 8000);
    if (!r.ok) return cached ? cached.info : null;
    const info = await r.json();
    try { localStorage.setItem(LAST_VERSION_CHECK_KEY, JSON.stringify({ at: Date.now(), info })); } catch (e) {}
    return info;
  } catch (e) { return cached ? cached.info : null; }
}
// Apply a newer web bundle (capgo) if version.json advertises one. Reloads on success.
async function applyWebUpdate(info) {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  const Updater = getNativePlugin('CapacitorUpdater');
  if (!Updater) { updStatus('upd: no plugin'); return; }
  try {
    if (!info || !info.version || !info.url) { updStatus(''); return; }
    if (cmpVer(info.version, APP_VERSION) <= 0) { updStatus(''); return; } // already current
    updStatus('downloading v' + info.version + '…'); launchStatus('Downloading update…', 85);
    const bundle = await Updater.download({ url: info.url, version: info.version });
    updStatus('installing v' + info.version + '…'); launchStatus('Installing update…', 95);
    await Updater.set(bundle); // reloads the app on the new bundle
  } catch (e) {
    updStatus('upd err: ' + ((e && (e.message || e.code)) || String(e)).slice(0, 120));
    setSyncState(IN_GAS ? 'ok' : 'off'); // update failed — keep running current version
  }
}

// ── Launch screen ───────────────────────────────────────────────────────────
const LAUNCH_T0 = Date.now();
let launchHidden = false;
function launchStatus(msg, pct) {
  const s = document.getElementById('launch-status'); if (s && msg != null) s.textContent = msg;
  const b = document.getElementById('launch-bar');    if (b && pct != null) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
}
function hideLaunch() {
  if (launchHidden) return; launchHidden = true;
  const el = document.getElementById('launch-overlay'); if (!el) return;
  const wait = Math.max(0, 200 - (Date.now() - LAUNCH_T0)); // min on-screen time so it never flashes
  setTimeout(() => { el.classList.add('hidden'); setTimeout(() => { el.style.display = 'none'; }, 500); }, wait);
}
async function nativeAppVersion() {
  const App = getNativePlugin('App'); if (!App) return null;
  try { const i = await App.getInfo(); return i && i.version; } catch (e) { return null; }
}
function showApkGate(apkUrl, installedVer, needVer) {
  const g = document.getElementById('apk-gate'); if (!g) return;
  const vd = document.getElementById('apk-gate-ver');
  if (vd) vd.textContent = (installedVer ? ('Installed v' + installedVer + '  →  ') : '') + 'Required v' + (needVer || '');
  const msg = document.getElementById('apk-gate-msg');
  const btn = document.getElementById('apk-gate-btn');
  const browserFallback = () => {
    const B = getNativePlugin('Browser');
    if (B && B.open) B.open({ url: apkUrl }); else location.href = apkUrl;
  };
  if (btn) btn.onclick = async () => {
    const Apk = getNativePlugin('ApkInstaller');
    if (!Apk || !Apk.installFromUrl) { browserFallback(); return; } // older shell → browser download
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Downloading…';
    try {
      const r = await Apk.installFromUrl({ url: apkUrl });
      if (r && r.needsPermission) {
        if (msg) msg.textContent = 'Allow installing apps for Household Ledger, then tap Download again.';
        btn.textContent = label;
      } else {
        btn.textContent = 'Opening installer…';
      }
    } catch (e) {
      browserFallback();      // download failed → let the browser handle it
      btn.textContent = label;
    } finally {
      btn.disabled = false;
    }
  };
  hideLaunch();
  g.classList.remove('hidden');
}

// ── Biometric / device-credential lock ──────────────────────────────────────
// Gates the app on cold start and on every resume from background.
// allowDeviceCredential lets the phone's own PIN/pattern/password serve as the
// fallback when no biometric is enrolled — no separate in-app PIN to build/store.
function unlockGate() {
  const g = document.getElementById('lock-gate');
  if (g) g.classList.add('hidden');
}
// internalAuthenticate() launches a separate native AuthActivity to show the
// biometric prompt — when it finishes (success, failure, or cancel) and
// control returns to the main Activity, Android fires a normal onResume,
// which our own 'resume' listener (below) treats as "app came back from
// background" and calls requireLock() again — relaunching the prompt in an
// infinite loop. Guard against re-entering requireLock() while our own
// auth flow is already in flight, so only a genuine background→foreground
// transition (not our own AuthActivity returning) triggers a fresh check.
let biometricAuthInFlight = false;
async function requireLock() {
  if (biometricAuthInFlight) return; // resume fired because our own AuthActivity just returned — not a real backgrounding
  if (!(uiPrefs.lockEnabled ?? true)) return; // user turned it off in the hamburger menu
  // The @aparajita/capacitor-biometric-auth package registers its native plugin
  // as 'BiometricAuthNative' (see its index.js: registerPlugin('BiometricAuthNative', ...),
  // then re-exports the proxy under the friendlier name `BiometricAuth` for ESM
  // consumers). This app has no bundler/ESM imports, so it must look the plugin
  // up by its actual registered Capacitor name — using 'BiometricAuth' here (the
  // export alias, not the registration name) silently failed to find it, which
  // is exactly what a lock-diag: skipped — BiometricAuth plugin not found entry
  // in Activity confirmed on a real device.
  const Bio = getNativePlugin('BiometricAuthNative');
  if (!Bio) return; // browser/preview or older shell without the plugin — no-op
  let check;
  try { check = await Bio.checkBiometry(); } catch (e) { return; } // can't check → don't lock the user out
  if (!check || (!check.isAvailable && !check.deviceIsSecure)) return; // nothing to authenticate against
  const g = document.getElementById('lock-gate');
  const btn = document.getElementById('lock-gate-btn');
  const msgEl = document.getElementById('lock-gate-msg');
  // TEMPORARY diagnostic — the "Unlock" button showed but tapping it did nothing
  // visible (no native prompt). Surface checkBiometry()'s actual result and any
  // authenticate() error directly on the lock screen (not just Activity) so we
  // get an answer on the very next attempt, without another release+wait cycle.
  // Remove once the real cause is found and fixed.
  if (msgEl) msgEl.textContent = 'Diag: isAvailable=' + check.isAvailable + ', deviceIsSecure=' + check.deviceIsSecure +
    ', biometryType=' + check.biometryType + ', code=' + (check.code||'-') + ', reason=' + (check.reason||'-');
  logActivity('lock-diag2: checkBiometry isAvailable=' + check.isAvailable + ' deviceIsSecure=' + check.deviceIsSecure +
    ' biometryType=' + check.biometryType + ' code=' + (check.code||'-') + ' reason=' + (check.reason||'-'));
  const attempt = async () => {
    biometricAuthInFlight = true;
    // Marker for the cold-boot check at the top of boot(): if the process
    // gets killed while AuthActivity is in front, this is the only trace
    // left behind, since nothing in JS memory (including this very promise)
    // survives a process death.
    try { localStorage.setItem('biometric-auth-pending', JSON.stringify({ at: Date.now() })); } catch (e) {}
    try {
      // The plugin's public `authenticate()` is a thin JS-side wrapper (in its
      // base.js) around the real native method, which is actually named
      // `internalAuthenticate` — `authenticate` only exists on that JS wrapper
      // class, not on the raw Capacitor plugin proxy this app gets via
      // getNativePlugin() (confirmed: the native Android class only declares
      // @PluginMethod checkBiometry and internalAuthenticate, never
      // `authenticate`). The wrapper adds nothing but nicer error typing, so
      // calling internalAuthenticate directly with the same options is
      // equivalent. Internally this launches a separate native AuthActivity
      // (see biometricAuthInFlight guard above) rather than showing an
      // in-place dialog.
      await Bio.internalAuthenticate({
        reason: 'Unlock Household Ledger',
        cancelTitle: 'Cancel',
        allowDeviceCredential: true,
        androidTitle: 'Unlock Household Ledger',
        androidSubtitle: 'Use your fingerprint, face, or device PIN',
      });
      unlockGate();
      try { localStorage.removeItem('biometric-auth-pending'); } catch (e) {}
    } catch (e) {
      // authentication failed/cancelled — gate stays up, user retries via the button
      try { localStorage.removeItem('biometric-auth-pending'); } catch (e2) {}
      const detail = (e && (e.code || e.message)) || String(e);
      if (msgEl) msgEl.textContent = 'Diag: authenticate() failed — ' + detail;
      logActivity('lock-diag2: authenticate() failed — ' + detail);
    } finally {
      // Clear on a short delay, not immediately — the AuthActivity-triggered
      // onResume can arrive a beat after this promise settles, and we need
      // the guard to still be up when that spurious resume event lands.
      setTimeout(() => { biometricAuthInFlight = false; }, 1500);
    }
  };
  if (btn) btn.onclick = attempt;
  hideLaunch();
  if (g) g.classList.remove('hidden');
  await attempt();
}

// ── Boot ───────────────────────────────────────────────────────────────────
// ── Local Notifications (Bill due-date reminders) ─────────────────────────
async function scheduleNotifications() {
  if (!uiPrefs.notificationsEnabled) return;
  const LocalNotif = getNativePlugin('LocalNotifications');
  if (!LocalNotif) return;
  try {
    const perm = await LocalNotif.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LocalNotif.requestPermissions();
      if (req.display !== 'granted') return;
    }
  } catch (e) { return; }
  const today = new Date();
  const mo = today.getMonth() + 1, da = today.getDate();
  const upcoming = [];
  // Axis CC due 7th — notify on 5th
  if (da <= 5) upcoming.push({ id:1, title:'Axis CC due', body:'Axis credit card payment due on the 7th', schedule: { at: new Date(today.getFullYear(), mo-1, 7, 9, 0) } });
  // Scapia CC due 13th — notify on 11th
  if (da <= 11) upcoming.push({ id:2, title:'Scapia CC due', body:'Scapia credit card payment due on the 13th', schedule: { at: new Date(today.getFullYear(), mo-1, 13, 9, 0) } });
  // Rent assumed 1st — notify on 30th previous (or within first 3 days if after that)
  if (da <= 3 || da === 30 || da === 31) {
    const rentDay = da <= 3 ? new Date(today.getFullYear(), mo-1, 1, 9, 0) : new Date(today.getFullYear(), mo, 1, 9, 0);
    upcoming.push({ id:3, title:'Rent payment due', body:'Monthly rent payment due', schedule: { at: rentDay } });
  }
  if (upcoming.length) {
    try { await LocalNotif.schedule({ notifications: upcoming }); } catch(e){}
  }
}

async function boot() {
  loadLocal();
  loadUI();
  applyTheme();
  loadAuth();
  // TEMPORARY diagnostic — the fingerprint/PIN prompt never resolves or
  // rejects no matter what the user does in it, which points to Android
  // killing the app process while the biometric flow's separate native
  // screen is in front (a known Capacitor startActivityForResult gotcha).
  // requireLock()'s attempt() writes a marker to localStorage right before
  // launching that screen and clears it once the promise settles either
  // way. If a fresh cold boot finds that marker still present, the process
  // was killed mid-flow — this proves/disproves that theory directly,
  // since nothing else could explain the app restarting with it still set.
  try {
    const pending = JSON.parse(localStorage.getItem('biometric-auth-pending') || 'null');
    if (pending && pending.at) {
      const secsAgo = Math.round((Date.now() - pending.at) / 1000);
      logActivity('lock-diag3: app cold-booted with a biometric auth still pending from ' + secsAgo + 's ago — process was likely killed by the OS mid-authentication');
    }
    localStorage.removeItem('biometric-auth-pending');
  } catch (e) {}
  pruneTrash();
  render();
  bindSwipe();
  scheduleNotifications();
  document.getElementById('app-ver').textContent = 'v' + APP_VERSION;
  launchStatus('Loading…', 20);

  // A push that failed right before the app last closed — retry it now,
  // fire-and-forget, so it doesn't block reaching the ledger below.
  if (IN_GAS && auth && auth.idToken && getPendingSync()) pushToSheets();

  // Confirm this bundle so capgo doesn't roll it back, then hand off the native splash.
  const Updater = getNativePlugin('CapacitorUpdater');
  if (Updater) { try { await Updater.notifyAppReady(); } catch (e) {} }
  const Splash = getNativePlugin('SplashScreen');
  if (Splash) { try { await Splash.hide(); } catch (e) {} }

  // Start the version check now so its round trip overlaps with the
  // biometric-auth wait below instead of stacking after it.
  const versionInfoPromise = fetchVersionInfo();

  // Biometric/device-credential lock — blocks until unlocked (no-op outside native shell).
  await requireLock();

  // Fetch the update feed once; use it for both the native gate and the web update.
  launchStatus('Checking for updates…', 55);
  const info = await versionInfoPromise;

  // Mandatory native gate: installed APK too old for the current web bundle.
  if (info && info.minApk) {
    const nv = await nativeAppVersion();
    if (nv && cmpVer(nv, info.minApk) < 0) { showApkGate(info.apkUrl || '', nv, info.minApk); return; }
  }

  // Seamless web bundle update (may reload the app) — run this BEFORE the
  // sign-in gate, so a signed-out/stuck-at-login device still always picks up
  // the latest bundle instead of the update silently being skipped. Kept
  // blocking (unlike the ledger data pull below) since it can replace and
  // reload the running app — that must never happen as a surprise once the
  // user is already looking at their ledger.
  await applyWebUpdate(info);

  // Not signed in → login screen.
  if (IN_GAS && !(auth && auth.idToken)) { hideLaunch(); showLogin(true); return; }

  // Everything that must block first paint is done — reveal the cached
  // ledger now instead of waiting on the data pull too. The pull continues
  // in the background; the header sync-dot reflects its progress, and it
  // reconciles the view (re-renders) when it lands.
  launchStatus('Ready', 100);
  hideLaunch();
  if (IN_GAS) pullFromSheets();
}
boot();

// Re-pull shared data whenever the app comes back to the foreground,
// so changes made on another phone show up. Also reschedule notifications.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (IN_GAS) pullFromSheets();
    scheduleNotifications();
  }
});

// Re-lock every time the native app resumes from the background.
(() => {
  const App = getNativePlugin('App');
  if (App && App.addListener) App.addListener('resume', () => { requireLock(); });
})();
