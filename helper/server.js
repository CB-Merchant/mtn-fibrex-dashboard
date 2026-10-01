'use strict';

/* ============================================================================
   MTN FibreX Dashboard — local helper
   ----------------------------------------------------------------------------
   What this is:
     A tiny program that runs on YOUR always-on computer. It logs into your
     home router, reads the usage counters, works out daily usage, saves it,
     and serves your dashboard so the "Sync Router" button has something to
     talk to.

   Why it exists:
     A web page is not allowed to log into a router by itself (browsers block
     that for safety). This helper does the talking-to-the-router part locally.

   Important:
     - NO external packages. Uses only Node's built-in modules, so there is
       nothing to `npm install` and nothing to download.
     - Your router password is kept in memory ONLY (never written to disk).
     - The router-reading engine under ./engine is reused from the open-source
       WiFiWatch project (MIT licence, © Sagenoya) — see README-helper.md.
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { createCollectorRegistry } = require('./engine/collectors/registry');
const { SyncService } = require('./engine/services/sync-service');
const { JsonStore } = require('./engine/storage/json-store');
const { createCollectorScheduler } = require('./engine/services/scheduler');

/* ---------- settings (all overridable with environment variables) ---------- */
const PORT = Number(process.env.PORT || 8947);
// How often the helper re-reads the router on its own (while its window is
// open). Reading the router is a LOCAL request on your own network — it costs
// NO MTN data — so we can do it often to keep the device list, signal and
// usage fresh without you clicking anything. (Speed tests are the only thing
// that costs data, and they're on a separate, much slower schedule.)
const AUTO_SYNC_MINUTES = Math.max(1, Number(process.env.AUTO_SYNC_INTERVAL_MINUTES || 3));
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data', 'data_history.json');
// The (opt-in) saved router password lives in its OWN file, never in DATA_FILE.
// We derive its path from DATA_FILE's folder so the self-test — which points
// DATA_FILE at a throwaway — also writes any test credential to a throwaway,
// and never touches your real password file.
const CRED_FILE = path.join(path.dirname(DATA_FILE), '.router-credential');
const DASHBOARD_FILE = path.join(__dirname, '..', 'mtn-fibrex-dashboard.html');
const DEFAULT_ROUTER_IP = process.env.ROUTER_IP || '192.168.100.1';

/* ---------- fast "live" loop (ZLT / 5G ODU only) ----------
   The connected-device list and 5G signal can change second to second, so we
   read JUST those on a short loop — every few seconds — reusing ONE router
   login (we only re-authenticate if the session goes stale). This is separate
   from the full usage sync above (which re-reads the SMS inbox on the slower
   AUTO_SYNC schedule). Like all router reads it's LOCAL traffic and costs no
   MTN data. Result: the device count on the page changes within seconds of a
   device joining or leaving — no clicking, no "synced X minutes ago". */
const LIVE_POLL_SECONDS = Math.max(3, Number(process.env.LIVE_POLL_SECONDS || 5));

/* ---------- scheduled speed tests ----------
   A real speed test COSTS DATA (it downloads/uploads a chunk to measure how
   fast your line is). The router only reports *how much* data you used, not
   *how fast*, so this is the only honest way to get a Live speed figure.
   Default cadence is every 6 hours (~4 GB/month). The user picks the frequency
   in Settings; 0 = off. We never auto-run one on startup — only on a click or
   on the schedule they chose.                                                */
const SPEEDTEST_DEFAULT_MINUTES = Math.max(0, Number(process.env.SPEEDTEST_INTERVAL_MINUTES || 360));
const SPEEDTEST_DOWN_URL = process.env.SPEEDTEST_DOWN_URL || 'https://speed.cloudflare.com/__down';
const SPEEDTEST_UP_URL = process.env.SPEEDTEST_UP_URL || 'https://speed.cloudflare.com/__up';
const SPEEDTEST_DOWN_BYTES = Math.max(1, Number(process.env.SPEEDTEST_DOWN_BYTES || 25_000_000)); // ~25 MB
const SPEEDTEST_UP_BYTES = Math.max(1, Number(process.env.SPEEDTEST_UP_BYTES || 8_000_000));      // ~8 MB
const SPEEDTEST_MAX_KEEP = 90;

/* ---------- always-on uptime / outage watcher ----------
   A tiny check that answers ONE honest question on a steady timer: "do I
   actually have working internet right now?" From a running log of yes/no we
   work out a real uptime % and a real list of outages — replacing the old
   Sample 99.2%. Unlike the fast device loop above, this has its OWN timer that
   NEVER switches itself off (an outage is exactly when we must keep watching)
   and needs no router login, so it works on any router and even before the
   first Sync.

   Honest by design:
     • We only count time we were actually watching. If this PC is off/asleep,
       that time is UNKNOWN — never counted as up or down.
     • A single failed check (a stray dropped packet) is NOT an outage: it must
       stay down for a couple of checks in a row first (de-bounce).
   Cost: each check is a ~0-byte request to a well-known connectivity endpoint
   (a few MB a month — far below one speed test). Every input is overridable so
   the offline self-test can point it at a local fake and stay deterministic.  */
const UPTIME_ENABLED = process.env.UPTIME_ENABLED !== '0'; // on by default; self-test disables it for unrelated phases
const UPTIME_POLL_SECONDS = Math.max(1, Number(process.env.UPTIME_POLL_SECONDS || 30));
const UPTIME_TIMEOUT_MS = Math.max(200, Number(process.env.UPTIME_TIMEOUT_MS || 5000));
const UPTIME_MAX_OUTAGES = Math.max(1, Number(process.env.UPTIME_MAX_OUTAGES || 50));
const UPTIME_DEBOUNCE = Math.max(1, Number(process.env.UPTIME_DEBOUNCE || 2)); // consecutive downs before it's an outage
// A few highly-reliable, provider-diverse "are you online?" endpoints. Internet
// is UP if ANY of them answers, so one endpoint being down/blocked (e.g. in
// Nigeria) is never mistaken for an MTN outage.
const UPTIME_PROBE_URLS = (process.env.UPTIME_PROBE_URLS ||
  'http://cp.cloudflare.com/generate_204,http://www.gstatic.com/generate_204,http://www.msftconnecttest.com/connecttest.txt')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ---------- wire up the reused engine ---------- */
const store = new JsonStore(DATA_FILE);
const registry = createCollectorRegistry();
const syncService = new SyncService({ store, registry, defaultRouterIp: DEFAULT_ROUTER_IP });

/* ---------- in-memory session (NEVER saved to disk) ----------
   After the first successful Sync from the dashboard, we keep the router
   IP + password in memory so the auto-refresh can keep reading while the
   helper is running. Closing the helper forgets the password.            */
let session = { routerIp: null, password: null, collectorId: 'auto' };
let scheduler = null;
let refreshInFlight = false; // true while an on-demand /api/refresh read is running

function restartScheduler() {
  if (scheduler) { scheduler.stop(); scheduler = null; }
  if (!session.password) return;
  scheduler = createCollectorScheduler({
    syncService,
    routerIp: session.routerIp,
    password: session.password,
    collectorId: session.collectorId || 'auto',
    intervalMs: AUTO_SYNC_MINUTES * 60 * 1000
  });
  scheduler.start();
  console.log(`[helper] Auto-refresh ON — will re-read the router every ${AUTO_SYNC_MINUTES} min while this window is open.`);
}

/* ---------- (opt-in) remember the router password on THIS PC ----------
   Normally the password lives in memory only and a restart forgets it. But for
   true 24/7 tracking, the helper must be able to start reading again on its own
   after a reboot — before anyone opens the dashboard. That means it has to
   unlock the password with NO human present, so the password cannot be locked
   behind a master password you type.

   HONEST LIMITS (say it plainly, both here and in the UI):
     • We scramble it with AES-256-GCM and a key DERIVED FROM THIS PC (machine
       name + your Windows username + this folder), so copying the file to
       another computer will NOT unlock it.
     • This is genuinely better than plain text, but it is NOT strong security:
       anyone who can read these files on this PC *and* has this code could
       recover the password. It is OFF by default, opt-in, this-PC-only, kept in
       its OWN file (CRED_FILE) — never in data_history.json — and removable with
       one click ("Forget saved password").                                     */
function deriveKey() {
  const secret = `${os.hostname()}|${(os.userInfo().username || '')}|${__dirname}`;
  return crypto.scryptSync(secret, 'mtn-fibrex-helper-v1', 32);
}

function hasSavedCredential() {
  try { return fs.existsSync(CRED_FILE); } catch { return false; }
}

function saveCredential({ routerIp, password, collectorId }) {
  if (!password) return false;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
    const enc = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
    const payload = {
      v: 1,
      routerIp: routerIp || null,
      collectorId: collectorId || 'auto',
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data: enc.toString('hex')
    };
    fs.writeFileSync(CRED_FILE, JSON.stringify(payload), { mode: 0o600 });
    return true;
  } catch (err) {
    console.log(`[helper] Could not save the password on this PC (${err.message}). Nothing was written.`);
    return false;
  }
}

function loadSavedCredential() {
  if (!hasSavedCredential()) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(payload.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(payload.data, 'hex')), decipher.final()]);
    return { routerIp: payload.routerIp, collectorId: payload.collectorId || 'auto', password: dec.toString('utf8') };
  } catch {
    // Corrupt, tampered, or copied from another PC — it can't be trusted or
    // read here, so remove it and fall back to a normal manual Sync.
    forgetCredential();
    console.log('[helper] Saved password could not be read on this PC (maybe the file was moved or this computer changed) — it has been cleared. Just click Sync once.');
    return null;
  }
}

function forgetCredential() {
  try { fs.rmSync(CRED_FILE, { force: true }); } catch { /* already gone */ }
}

/* ---------- the fast "live" loop (devices + signal, every few seconds) ----------
   Only the ZLT / 5G ODU collector can read a device list this way, so this loop
   is a no-op on other routers (their devices still refresh on the full sync).
   We keep the very latest reading in memory (`liveLatest`) and serve it from
   /api/live so the page can show a steady "Live" without a stale timestamp. We
   only WRITE to disk when the device list actually changes (rare), to avoid
   pointless constant disk writes for a value that seldom moves. */
const zltCollector = registry.get('zlt-sms');
let liveTimer = null;
let liveInFlight = false;
let liveSession = null;                 // cached router login { sessionId, token, at }
let liveSupported = true;               // set false if this router has no live path
let liveLatest = { at: null, devices: null, signal: null };
let liveDeviceSig = '';                 // signature of the last device list we saved to disk
let liveFailStreak = 0;                 // consecutive failed reads (for backoff / give-up)
let liveNextAttemptAt = 0;              // don't retry before this time (brief backoff on a flaky link)
const LIVE_FAIL_LIMIT = 8;              // only give up the fast loop after SUSTAINED failure

/* A small fingerprint of the device list so we can tell when it really changed
   (count + each device's mac/ip/name), independent of ordering. */
function deviceSignature(devices) {
  if (!devices) return '';
  const list = Array.isArray(devices.list) ? devices.list : [];
  const parts = list
    .map(d => `${d.mac || ''}|${d.ip || ''}|${d.name || ''}`)
    .sort();
  return `${devices.count == null ? '' : devices.count}#${parts.join(',')}`;
}

async function liveTick() {
  if (!session.password || !liveSupported || !zltCollector || typeof zltCollector.collectLive !== 'function') return;
  if (liveInFlight) return;
  if (Date.now() < liveNextAttemptAt) return; // briefly backing off after recent failures
  liveInFlight = true;
  try {
    const out = await zltCollector.collectLive({
      routerIp: session.routerIp,
      password: session.password,
      session: liveSession
    });
    liveSession = out.session || liveSession;
    liveFailStreak = 0; liveNextAttemptAt = 0; // healthy read — clear any backoff
    const now = new Date().toISOString();
    // Stamp WHICH router these came from. Without this, a device list read from
    // one router keeps rendering after you move to a different box that cannot
    // report devices at all — the page has no way to tell it is looking at a
    // leftover. The page checks this against the router it is actually reading.
    const from = { sourceId: zltCollector.id, routerIp: session.routerIp || null, observedAt: now };
    // Keep whatever the router gave us; don't blank a good value on an empty read.
    if (out.devices) liveLatest.devices = { ...out.devices, ...from };
    if (out.diagnostics) liveLatest.signal = { ...out.diagnostics, ...from };
    liveLatest.at = now; // heartbeat: proves the loop is alive even when nothing changed

    // Persist ONLY when the device list changed (so /api/history and a restart
    // stay correct) — not every tick.
    const sig = deviceSignature(liveLatest.devices);
    if (liveLatest.devices && sig !== liveDeviceSig) {
      liveDeviceSig = sig;
      store.update(state => {
        state.settings.devices = { ...liveLatest.devices };
        if (liveLatest.signal) state.settings.signal = { ...liveLatest.signal };
        return state;
      });
    }
  } catch (err) {
    const msg = (err && err.message) || String(err);
    liveSession = null;          // drop the cached login; we'll re-authenticate next attempt
    liveFailStreak++;
    // A wrong password won't fix itself by retrying, so stop straight away.
    // Everything else (an expired token, a half-finished read on a weak 5G link,
    // a timeout, a momentary network blip) is TRANSIENT — we keep the loop alive
    // and just retry. Only after many failures in a row do we conclude this
    // router simply has no live path and switch the fast loop off. This is the
    // fix for "I had to reload the page to see a device connect/disconnect":
    // before, one bad read turned live updates off until the next Sync.
    const wrongPassword = /password/i.test(msg);
    if (wrongPassword || liveFailStreak >= LIVE_FAIL_LIMIT) {
      liveSupported = false;
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
      console.log(`[helper] Fast live updates off after ${liveFailStreak} attempt(s) (${msg}). Devices will still refresh on the ${AUTO_SYNC_MINUTES}-min sync.`);
    } else {
      // Back off a little so a struggling router isn't hammered every 3s, but
      // keep trying — the loop recovers on its own the moment a read succeeds.
      liveNextAttemptAt = Date.now() + Math.min(20000, liveFailStreak * 4000);
    }
  } finally {
    liveInFlight = false;
  }
}

function restartLiveLoop() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (!session.password || !liveSupported || !zltCollector || typeof zltCollector.collectLive !== 'function') return;
  liveFailStreak = 0; liveNextAttemptAt = 0; // clean slate on (re)arm
  liveTimer = setInterval(() => { liveTick().catch(() => {}); }, LIVE_POLL_SECONDS * 1000);
  if (liveTimer.unref) liveTimer.unref();
  liveTick().catch(() => {}); // read once right away so the page fills in fast
  console.log(`[helper] Live device/signal updates ON — every ${LIVE_POLL_SECONDS}s (local read, no data cost).`);
}

/* ---------- small HTTP helpers (these replace express/cors by hand) ---------- */
const CORS = { 'Access-Control-Allow-Origin': '*' };

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS
  });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      data += chunk;
      if (data.length > 1_000_000) { done = true; req.destroy(); reject(new Error('Request body too large.')); }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('The request body was not valid JSON.')); }
    });
    req.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}

function serveDashboard(res) {
  fs.readFile(DASHBOARD_FILE, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
      res.end('Could not find mtn-fibrex-dashboard.html next to the helper.\nExpected it here:\n  ' + DASHBOARD_FILE);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
    res.end(buf);
  });
}

/* Quick "is the router reachable?" check (used by the page before syncing). */
async function pingRouter(routerIp) {
  const cleanIp = (routerIp || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  if (!cleanIp) return { status: 'offline', latencyMs: -1, routerIp: cleanIp };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`http://${cleanIp}/`, { signal: controller.signal });
    return { status: 'online', latencyMs: Date.now() - started, routerIp: cleanIp };
  } catch {
    return { status: 'offline', latencyMs: -1, routerIp: cleanIp };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- speed test (measures real download/upload; costs data) ----------
   Downloads a known-size chunk and uploads another, timing each, then converts
   to Mbps (bytes * 8 / seconds / 1e6). Defaults to Cloudflare's public speed
   endpoints; every input is overridable so the self-test can point it at a
   fake local target (no internet, no data cost). Any leg that fails stays null
   rather than reporting a fake number.                                        */
async function runSpeedTest({
  downUrl = SPEEDTEST_DOWN_URL,
  upUrl = SPEEDTEST_UP_URL,
  downBytes = SPEEDTEST_DOWN_BYTES,
  upBytes = SPEEDTEST_UP_BYTES,
  timeoutMs = 30000
} = {}) {
  const at = new Date().toISOString();

  // ---- download ----
  // We STREAM the body and count bytes as they arrive, rather than waiting for
  // the whole chunk with res.arrayBuffer(). On a slow or weak link that can't
  // pull the full chunk within the timeout, this still yields a REAL figure
  // (bytes actually received ÷ time) instead of aborting and reporting nothing.
  // Data cost is unchanged: capped at downBytes (what we ask for) or whatever
  // arrived before the timeout — whichever is smaller.
  let downMbps = null;
  try {
    const sep = downUrl.includes('?') ? '&' : '?';
    const url = `${downUrl}${sep}bytes=${downBytes}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let received = 0;
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (res.ok && res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) received += value.length;
        }
      } else if (res.ok) {
        // Fallback for runtimes without a streaming body: buffer it all.
        received = Buffer.from(await res.arrayBuffer()).length;
      }
    } catch { /* timeout abort or a network hiccup — keep whatever arrived */ }
    finally { clearTimeout(timer); }
    const secs = (Date.now() - started) / 1000;
    if (secs > 0 && received > 0) downMbps = +((received * 8) / secs / 1e6).toFixed(2);
  } catch { downMbps = null; }

  // ---- upload ----
  let upMbps = null;
  try {
    const payload = Buffer.alloc(upBytes, 0x61); // filler bytes ('a')
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      await fetch(upUrl, {
        method: 'POST',
        body: payload,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/octet-stream' },
        cache: 'no-store'
      });
      const secs = (Date.now() - started) / 1000;
      if (secs > 0) upMbps = +((upBytes * 8) / secs / 1e6).toFixed(2);
    } finally {
      clearTimeout(timer);
    }
  } catch { upMbps = null; }

  return { at, downMbps, upMbps, server: 'Cloudflare', downBytes, upBytes };
}

/* speed-test state (interval + a guard so two tests never overlap) */
let speedTestTimer = null;
let speedTestRunning = false;
let speedTestIntervalMinutes = SPEEDTEST_DEFAULT_MINUTES;

/* Save one result into settings.speedTests (usage/speed numbers only — never
   the password), keeping the most recent SPEEDTEST_MAX_KEEP entries. */
function recordSpeedTest(result) {
  return store.update(state => {
    if (!Array.isArray(state.settings.speedTests)) state.settings.speedTests = [];
    state.settings.speedTests.push(result);
    if (state.settings.speedTests.length > SPEEDTEST_MAX_KEEP) {
      state.settings.speedTests = state.settings.speedTests.slice(-SPEEDTEST_MAX_KEEP);
    }
    state.settings.speedTestConfig = { intervalMinutes: speedTestIntervalMinutes };
    return state;
  });
}

async function runAndRecordSpeedTest(opts) {
  if (speedTestRunning) throw new Error('A speed test is already running — please wait for it to finish.');
  speedTestRunning = true;
  try {
    const result = await runSpeedTest(opts);
    recordSpeedTest(result);
    return result;
  } finally {
    speedTestRunning = false;
  }
}

function restartSpeedTestScheduler() {
  if (speedTestTimer) { clearInterval(speedTestTimer); speedTestTimer = null; }
  if (!speedTestIntervalMinutes || speedTestIntervalMinutes <= 0) {
    console.log('[helper] Scheduled speed tests are OFF.');
    return;
  }
  speedTestTimer = setInterval(() => {
    runAndRecordSpeedTest().catch(err => console.error('[helper] scheduled speed test failed:', err.message));
  }, speedTestIntervalMinutes * 60 * 1000);
  if (speedTestTimer.unref) speedTestTimer.unref();
  console.log(`[helper] Scheduled speed tests ON — every ${speedTestIntervalMinutes} min (each test uses some data).`);
}

/* On startup, honour the frequency the user last chose (saved in settings). */
function loadSpeedTestConfig() {
  try {
    const cfg = store.read()?.settings?.speedTestConfig;
    const mins = cfg ? Number(cfg.intervalMinutes) : NaN;
    if (Number.isFinite(mins) && mins >= 0) speedTestIntervalMinutes = mins;
  } catch { /* keep the default */ }
}

/* ---------- the always-on uptime / outage watcher (implementation) ----------
   Split into a PURE part (foldReliability + helpers — no I/O, unit-tested) and
   an IMPURE part (the probe + the timer that persists to disk).              */

let uptimeTimer = null;
let uptimeInFlight = false;
let reliabilityState = null;      // latest settings.reliability — source of truth in memory
let lastReliabilityWriteAt = 0;

const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Start (00:00 local) of the billing cycle that `dateIso` falls in. cycleStartDay
   defaults to 1 (= the calendar month, which is what the "Uptime · month" card
   means); clamped to 28 so the day exists in every month. */
function cycleWindowStart(dateIso, cycleStartDay) {
  const d = new Date(dateIso);
  const day = Math.min(28, Math.max(1, Number(cycleStartDay) || 1));
  let y = d.getFullYear(), m = d.getMonth();
  if (d.getDate() < day) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  return new Date(y, m, day, 0, 0, 0, 0);
}

/* Pre-format an outage start for the page, e.g. "Aug 17 · 20:14" (local time). */
function formatWhen(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS_ABBR[d.getMonth()]} ${d.getDate()} · ${hh}:${mm}`;
}

/* Down-seconds within [windowStart, now], summed over the outage list (each
   outage's precise start→end, clamped to the window; an open outage runs to
   now). This ties the uptime % EXACTLY to the outage list. */
function outageDownSeconds(outages, windowStartMs, nowMs) {
  let s = 0;
  for (const o of (outages || [])) {
    const start = Date.parse(o.start);
    const end = o.end ? Date.parse(o.end) : nowMs;
    const a = Math.max(start, windowStartMs);
    const b = Math.min(end, nowMs);
    if (b > a) s += (b - a) / 1000;
  }
  return s;
}

/* PURE: fold one classified observation into the running reliability state.
   obs = { at:ISO, up:boolean, type:'service-down'|'router-down'|null }.
   Returns the next settings.reliability object. No I/O, no Date.now(). */
function foldReliability(prev, obs, opts = {}) {
  const pollSeconds = Math.max(1, opts.pollSeconds || UPTIME_POLL_SECONDS);
  const cycleStartDay = opts.cycleStartDay || 1;
  const maxOutages = Math.max(1, opts.maxOutages || UPTIME_MAX_OUTAGES);
  const debounce = Math.max(1, opts.debounceDown || UPTIME_DEBOUNCE);
  const maxGap = pollSeconds * Math.max(2, opts.gapFactor || 3);

  const nowMs = Date.parse(obs.at);
  const winStart = cycleWindowStart(obs.at, cycleStartDay);
  const winStartMs = winStart.getTime();
  const winStartISO = winStart.toISOString();

  let s;
  if (prev && prev.windowStart === winStartISO) {
    s = { ...prev, outages: Array.isArray(prev.outages) ? prev.outages.map(o => ({ ...o })) : [] };
  } else {
    // First-ever sample, or the cycle rolled over: reset the running totals but
    // keep any outages that still overlap the fresh window.
    const kept = (prev && Array.isArray(prev.outages) ? prev.outages : [])
      .filter(o => Date.parse(o.end || obs.at) >= winStartMs).map(o => ({ ...o }));
    s = {
      monitoring: true, method: 'probe', windowStart: winStartISO,
      observedSeconds: 0, outages: kept,
      currentlyDown: prev ? !!prev.currentlyDown : false,
      downStreak: prev ? (prev.downStreak || 0) : 0,
      pendingDownSince: prev ? (prev.pendingDownSince || null) : null,
      since: (prev && prev.since) || obs.at,
      lastObservedAt: prev ? (prev.lastObservedAt || null) : null
    };
  }
  // Safety defaults (in case prev came from an older on-disk shape).
  s.observedSeconds = s.observedSeconds || 0;
  s.downStreak = s.downStreak || 0;
  if (s.pendingDownSince === undefined) s.pendingDownSince = null;
  if (s.currentlyDown === undefined) s.currentlyDown = false;
  if (!s.since) s.since = obs.at;

  // ---- observed-time accounting (only count time we actually watched) ----
  const lastMs = s.lastObservedAt ? Date.parse(s.lastObservedAt) : null;
  let gapSec, unobservedGap = false;
  if (lastMs == null) {
    gapSec = pollSeconds;                       // first sample: count one interval
  } else {
    const raw = (nowMs - lastMs) / 1000;
    if (raw <= maxGap) gapSec = Math.max(0, raw);
    else { gapSec = pollSeconds; unobservedGap = true; } // PC was off in between
  }
  // If we stopped watching, we can't claim an in-progress outage continued
  // through the dark — close it at the last time we actually saw the line.
  if (unobservedGap && s.currentlyDown) {
    const open = s.outages.find(o => !o.end);
    if (open) { open.end = s.lastObservedAt; open.mins = Math.max(1, Math.round((Date.parse(open.end) - Date.parse(open.start)) / 60000)); }
    s.currentlyDown = false; s.downStreak = 0; s.pendingDownSince = null;
  }
  s.observedSeconds += gapSec;

  // ---- classify this sample + maintain the outage list (with de-bounce) ----
  if (obs.up) {
    if (s.currentlyDown) {
      const open = s.outages.find(o => !o.end);
      if (open) { open.end = obs.at; open.mins = Math.max(1, Math.round((nowMs - Date.parse(open.start)) / 60000)); }
    }
    s.currentlyDown = false; s.downStreak = 0; s.pendingDownSince = null;
  } else {
    if (s.downStreak === 0) s.pendingDownSince = obs.at; // remember the FIRST down, to backdate
    s.downStreak += 1;
    const type = obs.type || 'service-down';
    if (s.downStreak >= debounce) {
      if (!s.currentlyDown) {
        s.currentlyDown = true;
        const start = s.pendingDownSince || obs.at;
        s.outages.push({ start, end: null, type, mins: Math.max(1, Math.round((nowMs - Date.parse(start)) / 60000)), when: formatWhen(start) });
      } else {
        const open = s.outages.find(o => !o.end);
        if (open) { open.mins = Math.max(1, Math.round((nowMs - Date.parse(open.start)) / 60000)); open.type = open.type || type; }
      }
    }
  }
  if (s.outages.length > maxOutages) s.outages = s.outages.slice(-maxOutages);

  // ---- derive the headline numbers over OBSERVED time ----
  const downSec = outageDownSeconds(s.outages, winStartMs, nowMs);
  const upSec = Math.max(0, s.observedSeconds - downSec);
  s.upSeconds = Math.round(upSec);
  s.uptimePct = s.observedSeconds > 0 ? +((upSec / s.observedSeconds) * 100).toFixed(1) : 100;
  s.lastObservedAt = obs.at;
  return s;
}

/* IMPURE: one connectivity probe to a single endpoint. ANY HTTP response (even
   an error status) proves the internet is reachable; only a network failure or
   timeout counts as unreachable. Same fetch+AbortController shape as pingRouter
   and the speed test. */
async function probeOne(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPTIME_TIMEOUT_MS);
  try {
    await fetch(url, { method: 'GET', signal: controller.signal, cache: 'no-store', redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* Internet is UP if ANY probe target answers. */
async function probeInternet() {
  const results = await Promise.allSettled(UPTIME_PROBE_URLS.map(probeOne));
  return results.some(r => r.status === 'fulfilled' && r.value === true);
}

/* Classify the connection right now: the internet probe decides up/down; the
   router ping only LABELS the cause when down (box/power vs MTN line). */
async function observeConnectivity() {
  const at = new Date().toISOString();
  const up = await probeInternet();
  let type = null;
  if (!up) {
    const ip = session.routerIp || null;
    if (ip) {
      const ping = await pingRouter(ip);
      type = ping.status === 'online' ? 'service-down' : 'router-down';
    } else {
      type = 'service-down'; // router IP unknown (no Sync yet) — can't blame the box
    }
  }
  return { at, up, type };
}

function cycleStartDayNow() {
  try { return Number(store.read()?.settings?.cycleStartDay) || 1; } catch { return 1; }
}

function persistReliability(rel) {
  try {
    store.update(state => { state.settings.reliability = rel; return state; });
    lastReliabilityWriteAt = Date.now();
  } catch (err) {
    console.log(`[helper] Could not save uptime data (${err.message}).`);
  }
}

function loadReliabilityState() {
  try {
    const rel = store.read()?.settings?.reliability;
    if (rel && typeof rel === 'object') reliabilityState = rel;
  } catch { /* start fresh */ }
}

async function uptimeTick() {
  if (uptimeInFlight) return;
  uptimeInFlight = true;
  try {
    const obs = await observeConnectivity();
    const prev = reliabilityState;
    const next = foldReliability(prev, obs, { pollSeconds: UPTIME_POLL_SECONDS, cycleStartDay: cycleStartDayNow(), maxOutages: UPTIME_MAX_OUTAGES, debounceDown: UPTIME_DEBOUNCE });
    reliabilityState = next;
    // A slim snapshot for the fast /api/live poll (so a live drop shows quickly).
    liveLatest.reliability = { monitoring: true, currentlyDown: next.currentlyDown, uptimePct: next.uptimePct };

    // Write on any transition (outage opened/closed) so the record is durable;
    // otherwise flush occasionally to keep the % fresh after a restart, and every
    // tick while an outage is open so "ongoing · Xm" stays current on the page.
    const transitioned = !prev || next.currentlyDown !== prev.currentlyDown ||
      next.outages.length !== ((prev.outages && prev.outages.length) || 0);
    const staleFlush = (Date.now() - lastReliabilityWriteAt) > 5 * 60 * 1000;
    if (transitioned || next.currentlyDown || staleFlush) persistReliability(next);
  } catch { /* a bad tick just means we skip this observation */ } finally {
    uptimeInFlight = false;
  }
}

function restartUptimeWatcher() {
  if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; }
  if (!UPTIME_ENABLED) { console.log('[helper] Uptime watcher is disabled (UPTIME_ENABLED=0).'); return; }
  uptimeTimer = setInterval(() => { uptimeTick().catch(() => {}); }, UPTIME_POLL_SECONDS * 1000);
  if (uptimeTimer.unref) uptimeTimer.unref();
  uptimeTick().catch(() => {}); // observe once right away
  console.log(`[helper] Uptime watcher ON — checking the internet every ${UPTIME_POLL_SECONDS}s (tiny data cost). Uptime % / outages are measured only while this window is open.`);
}

/* ---------- the server ---------- */
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://localhost:${PORT}`); }
  catch { return sendJson(res, 400, { error: 'Bad request URL.' }); }
  const pathname = url.pathname;

  // CORS preflight (so the double-clicked file:// page can POST here)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...CORS,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600'
    });
    return res.end();
  }

  try {
    // Serve the dashboard itself (same-origin when opened via the helper)
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/dashboard')) {
      return serveDashboard(res);
    }

    // Is the helper here? (the page pings this on load)
    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, {
        ok: true,
        helper: 'mtn-fibrex-helper',
        version: 1,
        port: PORT,
        defaultRouterIp: DEFAULT_ROUTER_IP,
        autoSyncEnabled: Boolean(session.password),
        savedCredential: hasSavedCredential(),
        intervalMinutes: AUTO_SYNC_MINUTES,
        live: {
          intervalSeconds: LIVE_POLL_SECONDS,
          running: Boolean(liveTimer),
          supported: liveSupported
        },
        speedTest: {
          intervalMinutes: speedTestIntervalMinutes,
          running: speedTestRunning
        }
      });
    }

    // Which routers can we read?
    if (req.method === 'GET' && pathname === '/api/collectors') {
      return sendJson(res, 200, { collectors: registry.list() });
    }

    // Everything we've stored (records[], settings, lastSync, accounting…)
    if (req.method === 'GET' && pathname === '/api/history') {
      return sendJson(res, 200, syncService.getState());
    }

    // Is the router reachable right now?
    if (req.method === 'GET' && pathname === '/api/ping') {
      return sendJson(res, 200, await pingRouter(url.searchParams.get('routerIp')));
    }

    // The big one: read the router now.
    if (req.method === 'POST' && (pathname === '/api/sync' || pathname === '/api/sync-router')) {
      const body = await readJsonBody(req);
      const routerIp = body.routerIp || body.gateway || DEFAULT_ROUTER_IP;
      const password = body.password || '';
      const collectorId = body.collectorId || 'auto';
      if (!password) return sendJson(res, 400, { error: 'Please enter your router admin password.' });

      const result = await syncService.sync({ collectorId, routerIp, password });

      // Keep it in memory so auto-refresh can keep reading while we run. By
      // default that's the ONLY place it lives (a restart forgets it). If the
      // page asks us to (opt-in "remember on this PC"), we also save a scrambled
      // copy to disk so 24/7 tracking survives a reboot; unticking clears it.
      session = { routerIp, password, collectorId };
      liveSupported = true; liveSession = null; liveDeviceSig = ''; // fresh box → re-enable + re-login
      if (body.rememberPassword === true) saveCredential(session);
      else if (body.rememberPassword === false) forgetCredential();
      if (body.autoSync === false) {
        if (scheduler) { scheduler.stop(); scheduler = null; }
        if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
      } else {
        restartScheduler();
        restartLiveLoop();
      }
      return sendJson(res, 200, result);
    }

    // Re-read the router RIGHT NOW without re-typing the password, using the
    // password we already hold in memory from your last Sync. This is what the
    // dashboard calls when you open/reload it (and when you switch back to its
    // tab), so it shows current data — e.g. the live device list — without you
    // clicking anything. Reading the router is a LOCAL request on your own
    // network: it costs NO MTN data. If we don't have a remembered password yet
    // (helper just started, or auto-refresh was turned off), we say so and the
    // page simply keeps showing the last saved reading.
    if (req.method === 'POST' && pathname === '/api/refresh') {
      if (!session.password) return sendJson(res, 200, { ok: false, needsPassword: true });
      if (refreshInFlight) return sendJson(res, 200, { ok: false, busy: true });
      refreshInFlight = true;
      try {
        const result = await syncService.sync({
          collectorId: session.collectorId || 'auto',
          routerIp: session.routerIp,
          password: session.password
        });
        return sendJson(res, 200, { ok: true, result });
      } finally {
        refreshInFlight = false;
      }
    }

    // Turn the auto-refresh off and forget the password (in memory AND, if one
    // was saved on this PC, on disk — otherwise "I turned it off" would come
    // surprisingly back after a reboot).
    if (req.method === 'POST' && pathname === '/api/auto-sync/stop') {
      if (scheduler) { scheduler.stop(); scheduler = null; }
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
      liveSession = null;
      liveLatest = { at: null, devices: null, signal: null };
      session = { routerIp: null, password: null, collectorId: 'auto' };
      forgetCredential();
      return sendJson(res, 200, { ok: true, autoSyncEnabled: false, savedCredential: false });
    }

    // Forget the password saved on this PC. This fully forgets it: deletes the
    // scrambled file (so a reboot won't auto-arm) AND clears it from memory and
    // stops the live loops, so "Forget" means gone right now, not next restart.
    if (req.method === 'POST' && pathname === '/api/forget-password') {
      forgetCredential();
      if (scheduler) { scheduler.stop(); scheduler = null; }
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
      liveSession = null;
      liveLatest = { at: null, devices: null, signal: null };
      session = { routerIp: null, password: null, collectorId: 'auto' };
      console.log('[helper] Saved router password forgotten (removed from this PC and from memory).');
      return sendJson(res, 200, { ok: true, savedCredential: false, autoSyncEnabled: false });
    }

    // The freshest device list + live signal, kept in memory by the fast loop
    // and served without touching the router or the disk. The dashboard polls
    // this every few seconds so the connected-device count changes within
    // seconds of a device joining/leaving — no reload, no data cost. `at` is
    // when the loop last succeeded; `running` tells the page the loop is alive
    // so it can show a steady "Live" dot instead of "synced N minutes ago".
    if (req.method === 'GET' && pathname === '/api/live') {
      return sendJson(res, 200, {
        ok: true,
        at: liveLatest.at,
        running: Boolean(liveTimer),
        supported: liveSupported,
        intervalSeconds: LIVE_POLL_SECONDS,
        devices: liveLatest.devices,
        signal: liveLatest.signal,
        reliability: liveLatest.reliability || null
      });
    }

    // Run a real speed test right now (costs a little data). Body may override
    // the target URLs/sizes — used only by the offline self-test.
    if (req.method === 'POST' && pathname === '/api/speedtest') {
      if (speedTestRunning) return sendJson(res, 409, { error: 'A speed test is already running.' });
      const body = await readJsonBody(req);
      const opts = {};
      if (body.downUrl) opts.downUrl = body.downUrl;
      if (body.upUrl) opts.upUrl = body.upUrl;
      if (Number.isFinite(Number(body.downBytes))) opts.downBytes = Number(body.downBytes);
      if (Number.isFinite(Number(body.upBytes))) opts.upBytes = Number(body.upBytes);
      const result = await runAndRecordSpeedTest(opts);
      return sendJson(res, 200, { ok: true, result });
    }

    // Change how often speed tests run (minutes; 0 = off). Remembered on disk.
    if (req.method === 'POST' && pathname === '/api/speedtest/config') {
      const body = await readJsonBody(req);
      const mins = Number(body.intervalMinutes);
      if (!Number.isFinite(mins) || mins < 0) {
        return sendJson(res, 400, { error: 'intervalMinutes must be a number (0 turns speed tests off).' });
      }
      speedTestIntervalMinutes = Math.round(mins);
      store.update(state => { state.settings.speedTestConfig = { intervalMinutes: speedTestIntervalMinutes }; return state; });
      restartSpeedTestScheduler();
      return sendJson(res, 200, { ok: true, intervalMinutes: speedTestIntervalMinutes });
    }

    sendJson(res, 404, { error: `Not found: ${req.method} ${pathname}` });
  } catch (err) {
    // Friendly, specific messages for the common failures.
    const raw = (err && err.message) ? err.message : String(err);
    let message = raw;
    if (/password/i.test(raw)) message = 'Router password looks incorrect. Check the password on your router sticker (often "admin").';
    else if (/No supported router|did not return|not available|detected at/i.test(raw)) message = raw + '  (Is the gateway right? Run ipconfig and use the "Default Gateway" number — FibreX ONTs are often 192.168.100.1, some gateways 192.168.1.1, MTN 5G is 192.168.0.1.)';
    else if (/aborted|timeout|ECONN|network|fetch failed|getaddrinfo/i.test(raw)) message = 'Could not reach the router. Make sure this computer is on the same Wi-Fi/router and the gateway address is correct.';
    sendJson(res, 500, { error: message, detail: raw });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[helper] Port ${PORT} is already in use.`);
    console.error('[helper] The helper may already be running in another window — look for it and use that one.');
    console.error(`[helper] Or start on a different port, e.g.:   set PORT=8948 && node server.js\n`);
    process.exit(1);
  }
  console.error('[helper] Server error:', err);
  process.exit(1);
});

// Bind to localhost only (127.0.0.1): reachable from this computer, not exposed
// to the wider network — safer, and usually avoids the Windows firewall prompt.
// Only start listening when run directly (`node server.js`). When another file
// `require()`s this one (e.g. the self-test, to call runSpeedTest), we skip the
// listen so no port is bound.
if (require.main === module) {
  loadSpeedTestConfig();
  const savedCred = loadSavedCredential(); // null unless you opted in to "remember on this PC"
  server.listen(PORT, '127.0.0.1', () => {
    console.log('==============================================================');
    console.log('   MTN FibreX Dashboard — local helper is now running');
    console.log('==============================================================');
    console.log(`   Open your dashboard:   http://localhost:${PORT}`);
    console.log(`   Saved usage file:      ${DATA_FILE}`);
    console.log(`   Auto-refresh:          every ${AUTO_SYNC_MINUTES} min (starts after your first Sync)`);
    if (savedCred && savedCred.password) {
      console.log('   Router password:       remembered on THIS PC (scrambled — not strong encryption).');
      console.log('                          Reading starts on its own now; use "Forget saved password" to remove it.');
    } else {
      console.log('   Your router password is kept in memory only — never saved to disk.');
    }
    console.log('   Leave this window open while you use the dashboard. Ctrl+C to stop.');
    console.log('==============================================================');
    restartSpeedTestScheduler();

    // The uptime/outage watcher is ALWAYS on — it needs no router password, so
    // it starts watching the moment the helper does (even before your first
    // Sync) and keeps measuring while this window is open.
    loadReliabilityState();   // continue the window/totals from a previous run, if any
    restartUptimeWatcher();

    // If you opted in to "remember on this PC", start reading straight away —
    // no browser, no Sync click. scheduler.start() does an immediate read and
    // has its own try/catch, so an unreachable router at boot just logs a line
    // and retries on the schedule.
    if (savedCred && savedCred.password) {
      session = { routerIp: savedCred.routerIp, password: savedCred.password, collectorId: savedCred.collectorId || 'auto' };
      liveSupported = true; liveSession = null; liveDeviceSig = '';
      restartScheduler();
      restartLiveLoop();
      console.log('[helper] Auto-armed from the password saved on this PC — reading your router now (no Sync needed).');
    }
  });
}

module.exports = {
  runSpeedTest,
  server,
  // exposed for the offline self-test (credential round-trip / corrupt-file)
  CRED_FILE,
  saveCredential,
  loadSavedCredential,
  forgetCredential,
  hasSavedCredential,
  // exposed for the offline self-test (pure uptime/outage computation)
  foldReliability,
  cycleWindowStart
};
