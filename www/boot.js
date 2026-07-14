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
// background" and calls requireLock() again. Guard against re-entering
// requireLock() while our own auth flow is in flight or just settled, so
// only a genuine background→foreground transition (not our own AuthActivity
// returning) triggers a fresh check — see lastAuthSettledAt/RESUME_GUARD_MS
// and the MAX_AUTO_RETRIES cap below for why a single boolean flag wasn't
// enough on its own.
let biometricAuthInFlight = false;
// Wall-clock timestamp (not a setTimeout) so the guard survives the JS timer
// throttling that happens while AuthActivity has focus and this WebView is
// backgrounded — a scheduled setTimeout can fire late (or all at once,
// batched, once we resume), which let spurious resumes slip through the old
// fixed-delay guard and retrigger authenticate() automatically.
let lastAuthSettledAt = 0;
const RESUME_GUARD_MS = 4000;
// Real-device logs showed dozens of automatic userCancel/systemCancel cycles
// in rapid succession with no user input possible — allowDeviceCredential:true
// means AuthActivity shows no cancel button at all, so these could only be
// resume-triggered auto-retries, not taps.
// Cap consecutive *automatic* (resume-triggered) attempts so a bad cycle
// can never spin forever — after a couple of automatic failures, wait for
// an explicit tap on the Unlock button instead of retrying on our own.
let consecutiveAutoFailures = 0;
const MAX_AUTO_RETRIES = 2;
async function requireLock() {
  if (biometricAuthInFlight) return; // resume fired because our own AuthActivity just returned — not a real backgrounding
  if (Date.now() - lastAuthSettledAt < RESUME_GUARD_MS) return; // same — belt-and-suspenders for the case above
  if (!(uiPrefs.lockEnabled ?? true)) return; // user turned it off in the hamburger menu
  // The @aparajita/capacitor-biometric-auth package registers its native plugin
  // as 'BiometricAuthNative' (see its index.js: registerPlugin('BiometricAuthNative', ...),
  // then re-exports the proxy under the friendlier name `BiometricAuth` for ESM
  // consumers). This app has no bundler/ESM imports, so it must look the plugin
  // up by its actual registered Capacitor name — 'BiometricAuth' (the export
  // alias, not the registration name) silently fails to find it.
  const Bio = getNativePlugin('BiometricAuthNative');
  if (!Bio) return; // browser/preview or older shell without the plugin — no-op
  let check;
  try { check = await Bio.checkBiometry(); } catch (e) { return; } // can't check → don't lock the user out
  if (!check || (!check.isAvailable && !check.deviceIsSecure)) return; // nothing to authenticate against
  const g = document.getElementById('lock-gate');
  const btn = document.getElementById('lock-gate-btn');
  const skipBtn = document.getElementById('lock-gate-skip');
  const msgEl = document.getElementById('lock-gate-msg');
  const attempt = async (auto) => {
    biometricAuthInFlight = true;
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
      consecutiveAutoFailures = 0;
    } catch (e) {
      // authentication failed/cancelled — gate stays up, user retries via the button
      if (auto) {
        consecutiveAutoFailures++;
      } else {
        consecutiveAutoFailures = 0; // an explicit tap always gets a fresh run of auto-retries afterward
      }
    } finally {
      biometricAuthInFlight = false;
      lastAuthSettledAt = Date.now();
    }
  };
  if (btn) btn.onclick = () => attempt(false);
  // Escape hatch: internalAuthenticate() can hang indefinitely on some devices
  // (the very "prompt never resolves" bug this lock flow has been fighting),
  // and the gate is a full-screen overlay with no other way back into the app
  // — no path to the hamburger menu to turn Screen Lock off. Always offer a
  // way out rather than risk a full, permanent lockout of the user's own data.
  if (skipBtn) {
    skipBtn.classList.remove('hidden');
    skipBtn.onclick = () => {
      uiPrefs.lockEnabled = false;
      saveUI();
      logActivity('Screen Lock turned off from the lock screen (escape hatch)');
      unlockGate();
    };
  }
  hideLaunch();
  if (g) g.classList.remove('hidden');
  if (consecutiveAutoFailures < MAX_AUTO_RETRIES) {
    await attempt(true);
  } else {
    // Stop auto-retrying — wait for an explicit tap so a bad device/plugin
    // interaction can't spin forever without the user ever choosing to retry.
    if (msgEl) msgEl.textContent = 'Tap Unlock to try again.';
  }
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
  pruneTrash();
  render();
  bindSwipe();
  bindMonthSwipe();
  bindFabLongPress();
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

  // Fetch the update feed once; use it for both the native gate and the web update.
  launchStatus('Checking for updates…', 55);
  const info = await fetchVersionInfo();

  // Mandatory native gate: installed APK too old for the current web bundle.
  if (info && info.minApk) {
    const nv = await nativeAppVersion();
    if (nv && cmpVer(nv, info.minApk) < 0) { showApkGate(info.apkUrl || '', nv, info.minApk); return; }
  }

  // Seamless web bundle update (may reload the app) — deliberately runs
  // BEFORE requireLock() (moved here from before this check), not just before
  // the sign-in gate. If a newer bundle exists, applyWebUpdate() can reload
  // the whole app mid-flow; if that happened *during* the biometric prompt
  // (which hands off to a separate native Android screen and waits on its
  // result), the reload would kill that pending callback the same way an
  // OS-level process kill would -- indistinguishable from the "prompt never
  // resolves" bug this session spent a long time chasing. Running the update
  // to completion first means a fresh boot() always starts the lock flow
  // against a bundle that's already settled, and as a bonus, a bug in the
  // *currently-running* bundle's lock flow can self-heal via this same update
  // check instead of trapping the user behind it.
  await applyWebUpdate(info);

  // Biometric/device-credential lock — blocks until unlocked (no-op outside native shell).
  await requireLock();

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

// Without this, two phones only converge on boot/resume — if both stay open
// in the foreground (e.g. one adds a fixed item while the other is just
// sitting on the ledger screen), the second phone never learns about the
// change until it's backgrounded and reopened. pullFromSheets() already
// no-ops when there's a pending/in-flight local push or the app is hidden,
// so this is safe to fire on a plain interval.
setInterval(() => {
  if (IN_GAS && document.visibilityState === 'visible') pullFromSheets();
}, 45000);

// Re-lock every time the native app resumes from the background.
(() => {
  const App = getNativePlugin('App');
  if (App && App.addListener) App.addListener('resume', () => { requireLock(); });
})();
