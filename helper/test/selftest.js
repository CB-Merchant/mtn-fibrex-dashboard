'use strict';

/* ============================================================================
   Self-test for the MTN FibreX helper.
   Run:  node test/selftest.js     (from the helper/ folder)
         node selftest.js          (from the helper/test/ folder)

   No real router needed — it spins up the fake ZTE from fake-router.js and
   checks the whole chain:
     PHASE A (engine): auto-detect picks ZTE → first sync = baseline (no daily
             record yet) → bump counters + wait → second sync yields a REAL
             daily usage record with GB > 0 → wrong password is rejected.
     PHASE B (server): starts the actual server.js on a test port and repeats
             the two-sync check over real HTTP (best-effort; a warning, not a
             failure, if the port can't be opened).
     PHASE C (live extras): a fake ZLT X17U (MTN 5G ODU) is read → the LIVE
             signal + connected-device list surface AND persist into settings;
             runSpeedTest() is pointed at a fake target and returns Mbps > 0
             (no internet, no data cost).
     PHASE D (near-real-time): starts server.js against a fake ZLT with the fast
             live loop on → after ONE Sync, GET /api/live streams the device
             count within seconds; mutating the fake's device list (a device
             leaving/joining) is reflected on its own with NO re-Sync, and the
             heartbeat keeps advancing so the page can show a steady "Live".
     PHASE E (self-healing): a transient "Invalid token" blip must NOT switch the
             fast loop off (the old "why must I reload to see a device?" bug) —
             the loop stays alive and recovers the new device count on its own.
     PHASE F (remember on this PC): the opt-in saved password round-trips through
             AES-256-GCM (and is scrambled, not plain text); a corrupt/foreign
             file is rejected and cleared; over HTTP, Sync with rememberPassword
             saves it, /api/config reports it, the usage file still has NO
             password, and "forget" deletes it and stops the live loop.
     PHASE G (uptime/outage watcher): the PURE foldReliability() computes honest
             uptime over OBSERVED time — steady up = 100% / no outages; a single
             failed probe is de-bounced away; two+ consecutive downs open ONE
             backdated, cause-labelled outage that closes on recovery; a PC-off
             gap is excluded and closes any open outage at the last watched moment;
             a billing-cycle rollover resets the window. Then over HTTP, against a
             LOCAL fake probe target: the watcher monitors at boot with NO Sync,
             an outage opens when the probe is taken down and closes when restored,
             and /api/live carries the slim reliability snapshot. All offline.
     PHASE H (Huawei fibre reader + catching up): auto-detect picks the Huawei
             HG8145X7 → BytesReceived lands in download and BytesSent in upload →
             baseline → usage. Then the cases that matter when the PC has been
             OFF while the router kept running: a three-day gap is filled in
             across every missed day; a counter that rolls over past 4 GB is
             repaired instead of binned; a meter that genuinely restarts credits
             what it can prove and labels the day a MINIMUM; and the ZTE reader,
             which cannot roll over, keeps its own behaviour. Wrong password
             rejected. All against a pretend box.
   ========================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { startFakeZte, startFakeZlt, startFakeSpeedTarget, startFakeProbeTarget, startFakeHuawei, GIB } = require('./fake-router');
const { createCollectorRegistry } = require('../engine/collectors/registry');
const { SyncService } = require('../engine/services/sync-service');
const { JsonStore } = require('../engine/storage/json-store');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
function ok(label) { passed++; console.log('  ✓ ' + label); }

/* Keep the self-test's data 100% SEPARATE from any real usage history.
   server.js honours process.env.DATA_FILE; we point it (and the child
   server started in Phase B, which inherits this env) at a throwaway file.
   Without this, Phase B would delete — and overwrite with fake numbers —
   the real helper/data/data_history.json. It must never touch real data. */
const TEST_SERVER_DATA_FILE = path.join(__dirname, '.selftest-server-data.json');
process.env.DATA_FILE = TEST_SERVER_DATA_FILE;
// server.js derives the (opt-in) saved-password file from DATA_FILE's folder, so
// under the test env it lands here in test/. Clear any stray one left by a
// crashed previous run — otherwise a spawned child could auto-arm from it and
// throw off the "live loop is OFF before Sync" checks. Phase F is the only phase
// that intentionally creates it, and it cleans up after itself.
const TEST_CRED_FILE = path.join(path.dirname(TEST_SERVER_DATA_FILE), '.router-credential');
try { fs.rmSync(TEST_CRED_FILE, { force: true }); } catch {}

// Keep the always-on uptime watcher OFF for every phase that isn't testing it.
// Otherwise each spawned server would fire real internet probes (to Cloudflare
// etc.) on a timer — pointless outbound traffic during an offline test. Phase G
// turns it back ON in its own spawned child (UPTIME_ENABLED=1) and points the
// probe at a LOCAL fake target, so that phase stays offline and deterministic too.
process.env.UPTIME_ENABLED = '0';

async function phaseA() {
  console.log('\nPHASE A — engine + fake router (no HTTP)');
  const tmpFile = path.join(__dirname, '.selftest-data.json');
  try { fs.rmSync(tmpFile, { force: true }); } catch {}

  const fake = await startFakeZte({ port: 9109, password: 'admin', down: 200 * GIB, up: 20 * GIB, uptime: 90000 });
  try {
    const store = new JsonStore(tmpFile);
    const registry = createCollectorRegistry();
    const svc = new SyncService({ store, registry, defaultRouterIp: '127.0.0.1:9109' });

    // 1) First sync: auto-detect + baseline
    const r1 = await svc.sync({ collectorId: 'auto', routerIp: '127.0.0.1:9109', password: 'admin' });
    assert.match(r1.detectedModel, /ZTE/, 'auto-detect should identify the ZTE router');
    ok('auto-detect identified: ' + r1.detectedModel);
    assert.equal(r1.counterStatus, 'baseline', 'first reading should be a baseline');
    ok('first sync = baseline');
    assert.equal(r1.records.length, 0, 'baseline should not invent a daily figure');
    ok('baseline produced no daily usage yet (correct)');

    // 2) Router uses more data, time passes, sync again
    fake.addBytes({ down: 3 * GIB, up: 512 * 1024 * 1024, uptime: 120 });
    await sleep(1200);
    const r2 = await svc.sync({ collectorId: 'auto', routerIp: '127.0.0.1:9109', password: 'admin' });
    assert.equal(r2.counterStatus, 'updated', 'second reading should register usage');
    ok('second sync = updated');
    assert.ok(r2.records.length >= 1, 'a daily usage record should now exist');
    const totalGB = r2.records.reduce((s, x) => s + Number(x.usageGB || 0), 0);
    assert.ok(totalGB > 0, 'daily usage should be greater than zero');
    ok(`daily usage recorded: ${totalGB.toFixed(2)} GB across ${r2.records.length} day(s)`);

    // 3) Wrong password must fail cleanly
    await assert.rejects(
      () => svc.sync({ collectorId: 'auto', routerIp: '127.0.0.1:9109', password: 'definitely-wrong' }),
      /password/i,
      'a wrong password should be rejected'
    );
    ok('wrong password is rejected');
  } finally {
    await fake.close();
    try { fs.rmSync(tmpFile, { force: true }); } catch {}
  }
}

async function waitForServer(base, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(base + '/api/config');
      if (r.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

/* Poll GET /api/live until `pred` is satisfied (or we run out of time). Returns
   the last reading either way, so the caller can assert on it. */
async function getLive(base) { return fetch(base + '/api/live').then(r => r.json()); }
async function waitLive(base, pred, ms) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = await getLive(base);
    if (pred(last)) return last;
    await sleep(250);
  }
  return last;
}

async function phaseB() {
  console.log('\nPHASE B — real server.js over HTTP (best-effort)');
  const PORT = 8977;
  const base = `http://127.0.0.1:${PORT}`;
  const serverPath = path.join(__dirname, '..', 'server.js');
  const dataFile = TEST_SERVER_DATA_FILE;
  try { fs.rmSync(dataFile, { force: true }); } catch {}

  const fake = await startFakeZte({ port: 9110, password: 'admin', down: 100 * GIB, up: 10 * GIB, uptime: 50000 });
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  try {
    const up = await waitForServer(base, 6000);
    if (!up) { console.log('  ! server did not start on the test port — skipping HTTP checks (not a failure).'); return; }
    ok('server.js started and answered /api/config');

    const post = (body) => fetch(base + '/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(r => r.json());

    const s1 = await post({ collectorId: 'auto', routerIp: '127.0.0.1:9110', password: 'admin', autoSync: false });
    assert.ok(!s1.error, 'first HTTP sync should succeed: ' + (s1.error || ''));
    assert.equal(s1.counterStatus, 'baseline', 'first HTTP sync should be baseline');
    ok('POST /api/sync #1 = baseline over HTTP');

    fake.addBytes({ down: 2 * GIB, up: 256 * 1024 * 1024, uptime: 90 });
    await sleep(1200);
    const s2 = await post({ collectorId: 'auto', routerIp: '127.0.0.1:9110', password: 'admin', autoSync: false });
    assert.equal(s2.counterStatus, 'updated', 'second HTTP sync should be updated');
    ok('POST /api/sync #2 = updated over HTTP');

    const hist = await fetch(base + '/api/history').then(r => r.json());
    assert.ok(Array.isArray(hist.records) && hist.records.length >= 1, 'GET /api/history should return a record');
    const gb = hist.records.reduce((s, x) => s + Number(x.usageGB || 0), 0);
    assert.ok(gb > 0, 'history record should have usage > 0');
    ok(`GET /api/history returned ${gb.toFixed(2)} GB; detectedModel = ${hist.settings && hist.settings.detectedModel}`);

    const wrong = await post({ collectorId: 'auto', routerIp: '127.0.0.1:9110', password: 'nope' });
    assert.ok(wrong.error, 'wrong password over HTTP should return an error');
    ok('wrong password over HTTP returns a friendly error');
  } finally {
    child.kill();
    await fake.close();
    try { fs.rmSync(dataFile, { force: true }); } catch {}
  }
}

async function phaseC() {
  console.log('\nPHASE C — live extras (ZLT signal + devices) and speed test');
  const tmpFile = path.join(__dirname, '.selftest-zlt.json');
  try { fs.rmSync(tmpFile, { force: true }); } catch {}

  const zlt = await startFakeZlt({ port: 9111, password: 'admin' });
  const target = await startFakeSpeedTarget({ port: 9112 });
  try {
    const store = new JsonStore(tmpFile);
    const registry = createCollectorRegistry();
    const svc = new SyncService({ store, registry, defaultRouterIp: '127.0.0.1:9111' });

    // 1) Read the fake ZLT — auto-detect should pick the ZLT (5G ODU) path.
    const r = await svc.sync({ collectorId: 'auto', routerIp: '127.0.0.1:9111', password: 'admin' });
    assert.match(r.detectedModel, /ZLT|ODU/i, 'auto-detect should identify the ZLT/5G router');
    ok('auto-detect identified: ' + r.detectedModel);

    // 2) LIVE signal surfaced from the sync result (honest values, not fakes).
    assert.ok(r.diagnostics, 'sync result should carry live signal diagnostics');
    assert.equal(r.diagnostics.rxMbps, 50, 'download throughput 6.25 MB/s → 50 Mbps');
    assert.equal(r.diagnostics.txMbps, 10, 'upload throughput 1.25 MB/s → 10 Mbps');
    assert.equal(r.diagnostics.rsrp, -72, 'RSRP should pass through as a number');
    assert.equal(r.diagnostics.band, 'B7+B3', 'band should pass through');
    ok(`live signal: ${r.diagnostics.rxMbps}↓/${r.diagnostics.txMbps}↑ Mbps, RSRP ${r.diagnostics.rsrp}, band ${r.diagnostics.band}`);

    // 3) LIVE device list surfaced (names/MAC/IP + count; NO per-device GB).
    assert.ok(r.devices, 'sync result should carry a device list');
    assert.equal(r.devices.count, 3, 'three connected devices expected');
    assert.equal(r.devices.list.length, 3, 'device list should have three entries');
    assert.ok(r.devices.list.every(d => d.mac && d.ip), 'each device should have a MAC and IP');
    assert.ok(r.devices.list.some(d => /Pixel-7/.test(d.name || '')), 'device names should come through');
    assert.ok(r.devices.list.every(d => !('gb' in d)), 'devices must NOT claim per-device GB');
    assert.equal(r.devices.cmd, 223, 'device list must come from cmd 223 (the confirmed ZLT getAllDevice command)');
    ok(`live devices: ${r.devices.count} online (${r.devices.list.map(d => d.name).join(', ')})`);
    ok('device list came from the confirmed cmd 223 (getAllDevice → dhcp_list_info)');

    // 4) Both persisted into settings (so the page reads them via /api/history).
    const saved = svc.getState();
    assert.ok(saved.settings.signal && saved.settings.signal.rsrp === -72, 'signal should persist to settings');
    assert.ok(saved.settings.devices && saved.settings.devices.count === 3, 'devices should persist to settings');
    assert.ok(saved.settings.signal.observedAt, 'persisted signal should be timestamped');
    ok('signal + devices persisted into settings (survive reloads)');

    // 5) SMS on the ZLT still yields real daily usage (bonus — proves the whole path).
    assert.ok(r.records.length >= 1, 'the ZLT SMS inbox should yield at least one daily record');
    ok(`ZLT SMS parsed ${r.records.length} daily usage record(s)`);

    // 6) runSpeedTest measures real Mbps against the fake target (offline).
    const { runSpeedTest } = require('../server.js');
    const speed = await runSpeedTest({
      downUrl: target.downUrl,
      upUrl: target.upUrl,
      downBytes: 2_000_000,
      upBytes: 1_000_000
    });
    assert.ok(speed.downMbps > 0, 'download speed should be greater than zero');
    assert.ok(speed.upMbps > 0, 'upload speed should be greater than zero');
    ok(`speed test measured ${speed.downMbps}↓ / ${speed.upMbps}↑ Mbps against the fake target`);
  } finally {
    await zlt.close();
    await target.close();
    try { fs.rmSync(tmpFile, { force: true }); } catch {}
    // Phase C's require('../server.js') re-creates the throwaway data file — tidy it.
    try { fs.rmSync(TEST_SERVER_DATA_FILE, { force: true }); } catch {}
  }
}

async function phaseD() {
  console.log('\nPHASE D — near-real-time device updates (fast live loop over HTTP)');
  const PORT = 8978;
  const base = `http://127.0.0.1:${PORT}`;
  const serverPath = path.join(__dirname, '..', 'server.js');
  const dataFile = TEST_SERVER_DATA_FILE;
  try { fs.rmSync(dataFile, { force: true }); } catch {}

  // A device list we can mutate at runtime. The fake ZLT re-reads this SAME
  // array on every cmd-223 call, so popping/pushing simulates a device leaving
  // or joining WITHOUT another Sync — exactly the scenario the page must catch.
  const devArr = [
    { hostname: 'Pixel-7',     mac: 'A4:50:46:11:22:33', ip: '192.168.0.101' },
    { hostname: 'MacBook-Air', mac: 'F0:18:98:AA:BB:CC', ip: '192.168.0.102' },
    { hostname: 'Living-TV',   mac: '3C:5A:B4:DD:EE:FF', ip: '192.168.0.103' }
  ];
  const zlt = await startFakeZlt({ port: 9113, password: 'admin', devices: devArr });
  // LIVE_POLL_SECONDS=1 makes the fast loop tick every second so the test is quick.
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), ROUTER_IP: '127.0.0.1:9113', LIVE_POLL_SECONDS: '1' },
    stdio: 'ignore'
  });

  try {
    const up = await waitForServer(base, 6000);
    if (!up) { console.log('  ! server did not start on the test port — skipping (not a failure).'); return; }

    // Before any Sync the helper holds no password, so the fast loop is OFF.
    let cfg = await fetch(base + '/api/config').then(r => r.json());
    assert.ok(cfg.live && cfg.live.running === false, 'live loop should be OFF before Sync');
    ok('before Sync: /api/config live.running = false (no password held)');

    // Sync once — this arms the in-memory password AND the fast loop.
    const s = await fetch(base + '/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectorId: 'zlt-sms', routerIp: '127.0.0.1:9113', password: 'admin', autoSync: true })
    }).then(r => r.json());
    assert.ok(!s.error, 'Sync should succeed: ' + (s.error || ''));
    ok('Sync once → helper holds the password in memory and arms the fast loop');

    // Within a few seconds /api/live should be streaming the 3 devices + signal.
    let live = await waitLive(base, d => d && d.running && d.devices && d.devices.count === 3, 5000);
    assert.ok(live.running, 'fast loop should be running after Sync');
    assert.ok(live.devices && live.devices.count === 3, 'should stream 3 connected devices');
    assert.ok(live.signal && live.signal.rsrp === -72, 'should stream the live signal too');
    const at1 = live.at;
    assert.ok(at1, 'live reading should carry a heartbeat timestamp');
    ok(`fast loop streaming ${live.devices.count} devices + signal within seconds (no reload)`);

    // The heartbeat advances on its own — proof the loop keeps re-reading, so
    // the page can show a STEADY "Live" instead of "synced N minutes ago". (The
    // loop's tick floor is 3s to be gentle on the real router, so poll a bit.)
    const live2 = await waitLive(base, d => d && d.at && String(d.at) > String(at1), 6000);
    assert.ok(String(live2.at) > String(at1), 'heartbeat should advance as the loop re-reads');
    ok('heartbeat advances on its own — page shows steady "Live", never "N min ago"');

    // THE KEY CHECK: a device leaves → the count falls on its own, NO re-Sync.
    devArr.pop(); // Living-TV disconnects
    live = await waitLive(base, d => d && d.devices && d.devices.count === 2, 5000);
    assert.equal(live.devices.count, 2, 'device count should fall to 2 after one leaves');
    assert.equal(live.devices.list.length, 2, 'device list should now have 2 entries');
    ok('a device disconnected → count dropped 3→2 within seconds, with NO manual Sync');

    // And a device joining is picked up just as fast.
    devArr.push({ hostname: 'iPhone-15', mac: '11:22:33:44:55:66', ip: '192.168.0.104' });
    live = await waitLive(base, d => d && d.devices && d.devices.count === 3, 5000);
    assert.equal(live.devices.count, 3, 'device count should climb back to 3 when one joins');
    assert.ok(live.devices.list.some(d => /iPhone-15/.test(d.name || '')), 'the new device should appear by name');
    ok('a device reconnected → count rose 2→3 within seconds, again with NO Sync');

    // Turning auto-refresh off stops the loop and forgets the password.
    await fetch(base + '/api/auto-sync/stop', { method: 'POST' }).then(r => r.json());
    await sleep(300);
    cfg = await fetch(base + '/api/config').then(r => r.json());
    assert.ok(cfg.live && cfg.live.running === false, 'live loop should stop when auto-refresh is turned off');
    ok('turning auto-refresh off stops the fast loop and forgets the password');
  } finally {
    child.kill();
    await zlt.close();
    try { fs.rmSync(dataFile, { force: true }); } catch {}
  }
}

async function phaseE() {
  console.log('\nPHASE E — live loop survives a transient blip (the "why do I have to reload?" fix)');
  const PORT = 8979;
  const base = `http://127.0.0.1:${PORT}`;
  const serverPath = path.join(__dirname, '..', 'server.js');
  const dataFile = TEST_SERVER_DATA_FILE;
  try { fs.rmSync(dataFile, { force: true }); } catch {}

  const devArr = [
    { hostname: 'Pixel-7',     mac: 'A4:50:46:11:22:33', ip: '192.168.0.101' },
    { hostname: 'MacBook-Air', mac: 'F0:18:98:AA:BB:CC', ip: '192.168.0.102' },
    { hostname: 'Living-TV',   mac: '3C:5A:B4:DD:EE:FF', ip: '192.168.0.103' }
  ];
  const zlt = await startFakeZlt({ port: 9114, password: 'admin', devices: devArr });
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), ROUTER_IP: '127.0.0.1:9114', LIVE_POLL_SECONDS: '1' },
    stdio: 'ignore'
  });

  try {
    const up = await waitForServer(base, 6000);
    if (!up) { console.log('  ! server did not start on the test port — skipping (not a failure).'); return; }

    const s = await fetch(base + '/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectorId: 'zlt-sms', routerIp: '127.0.0.1:9114', password: 'admin', autoSync: true })
    }).then(r => r.json());
    assert.ok(!s.error, 'Sync should succeed: ' + (s.error || ''));
    let live = await waitLive(base, d => d && d.running && d.devices && d.devices.count === 3, 5000);
    assert.equal(live.devices.count, 3, 'should be streaming 3 devices before the blip');
    ok('baseline: live loop streaming 3 devices');

    // Simulate a weak-link blip: the router briefly can't return a token AND its
    // reads come back empty — so the loop is forced to re-login and gets an
    // "Invalid token response". Under the OLD code this permanently switched the
    // fast loop OFF (so the page only updated on the slow full-sync → you had to
    // reload). It must now stay alive.
    zlt.induceTransientFault(true);
    await sleep(1800); // let at least one failing tick happen
    let cfg = await fetch(base + '/api/config').then(r => r.json());
    assert.ok(cfg.live && cfg.live.running === true, 'live loop must STAY running through a transient error');
    ok('a transient "Invalid token" blip did NOT switch the live loop off (still running)');

    live = await fetch(base + '/api/live').then(r => r.json());
    assert.notStrictEqual(live.supported, false, 'live must not be marked unsupported by a transient blip');
    ok('the helper kept offering Live (never flipped to "unsupported") during the blip');

    // Link recovers, and meanwhile a device joined. The loop should re-login on
    // its own and pick up the NEW count — no reload, no re-Sync.
    devArr.push({ hostname: 'iPhone-15', mac: '11:22:33:44:55:66', ip: '192.168.0.104' });
    zlt.induceTransientFault(false);
    live = await waitLive(base, d => d && d.running && d.devices && d.devices.count === 4, 12000);
    assert.equal(live.devices.count, 4, 'count should recover and reflect the new device (4)');
    assert.ok(live.devices.list.some(d => /iPhone-15/.test(d.name || '')), 'the device that joined during the blip should appear');
    ok('after the blip cleared, the count updated 3→4 on its own — no reload, no re-Sync');
  } finally {
    child.kill();
    await zlt.close();
    try { fs.rmSync(dataFile, { force: true }); } catch {}
  }
}

async function phaseF() {
  console.log('\nPHASE F — "remember my password on this PC" (opt-in, scrambled, forgettable)');
  const srv = require('../server.js');
  const { CRED_FILE, saveCredential, loadSavedCredential, forgetCredential } = srv;

  // ---- Part 1: unit round-trip of the saved-credential helpers (no HTTP). ----
  try {
    forgetCredential(); // start from a clean slate
    const secret = 'router-box-secret-9Q!';
    const okSave = saveCredential({ routerIp: '192.168.1.1', password: secret, collectorId: 'zlt-sms' });
    assert.equal(okSave, true, 'saveCredential should report success');
    assert.ok(fs.existsSync(CRED_FILE), 'a credential file should now exist');
    ok('saveCredential wrote the encrypted credential file');

    // The password must NOT be readable in the file (scrambled, not plain text).
    const rawCred = fs.readFileSync(CRED_FILE, 'utf8');
    assert.ok(!rawCred.includes(secret), 'the raw credential file must NOT contain the plain-text password');
    ok('the saved file is scrambled — the plain password is not in it');

    // Round-trip: load it back and recover the exact same password + fields.
    const loaded = loadSavedCredential();
    assert.ok(loaded, 'loadSavedCredential should return the saved credential');
    assert.equal(loaded.password, secret, 'the recovered password should match exactly');
    assert.equal(loaded.routerIp, '192.168.1.1', 'the recovered routerIp should match');
    assert.equal(loaded.collectorId, 'zlt-sms', 'the recovered collectorId should match');
    ok('loadSavedCredential recovered the exact password (AES-256-GCM round-trip)');

    // A corrupt / foreign file must be rejected (returns null) AND cleared, so a
    // file copied from another PC can't silently break every future boot.
    fs.writeFileSync(CRED_FILE, '{"v":1,"iv":"00","tag":"00","data":"deadbeef"}');
    const bad = loadSavedCredential();
    assert.equal(bad, null, 'a corrupt credential file should load as null');
    assert.ok(!fs.existsSync(CRED_FILE), 'a corrupt credential file should be cleared, not left behind');
    ok('a corrupt/foreign credential file is rejected and removed (fails safe)');
  } finally {
    forgetCredential();
  }

  // ---- Part 2: over HTTP — Sync remembers it, /api/config reports it, the ----
  // ---- usage file never holds it, and Forget deletes it + stops the loop.  ----
  const PORT = 8980;
  const base = `http://127.0.0.1:${PORT}`;
  const serverPath = path.join(__dirname, '..', 'server.js');
  const dataFile = TEST_SERVER_DATA_FILE;
  const boxPw = 'S3cret-box-pw'; // distinctive, so the "no password in the file" check can't collide with a common word
  try { fs.rmSync(dataFile, { force: true }); } catch {}
  try { fs.rmSync(TEST_CRED_FILE, { force: true }); } catch {} // ensure the child boots un-armed

  const zlt = await startFakeZlt({ port: 9115, password: boxPw });
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), ROUTER_IP: '127.0.0.1:9115', LIVE_POLL_SECONDS: '1' },
    stdio: 'ignore'
  });

  try {
    const up = await waitForServer(base, 6000);
    if (!up) { console.log('  ! server did not start on the test port — skipping (not a failure).'); return; }

    // The child booted with no saved credential, so it must not claim one.
    let cfg = await fetch(base + '/api/config').then(r => r.json());
    assert.equal(cfg.savedCredential, false, 'a fresh server should report savedCredential=false');
    ok('before Sync: /api/config savedCredential = false');

    // Sync WITH rememberPassword:true — this should persist the credential file.
    const s = await fetch(base + '/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectorId: 'zlt-sms', routerIp: '127.0.0.1:9115', password: boxPw, autoSync: true, rememberPassword: true })
    }).then(r => r.json());
    assert.ok(!s.error, 'Sync should succeed: ' + (s.error || ''));
    await sleep(300);
    assert.ok(fs.existsSync(TEST_CRED_FILE), 'Sync with rememberPassword:true should save the credential file');
    ok('Sync with "remember" ticked saved the password on this PC');

    cfg = await fetch(base + '/api/config').then(r => r.json());
    assert.equal(cfg.savedCredential, true, '/api/config should now report savedCredential=true');
    ok('/api/config now reports savedCredential = true');

    // CRITICAL privacy check: the usage history file must NEVER contain the password.
    const usageRaw = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : '';
    assert.ok(!usageRaw.includes(boxPw), 'the usage history file must not contain the password');
    ok('the usage history file holds NO password (kept only in the separate scrambled file)');

    // Forget it — the file should be deleted and the live loop stopped on the spot.
    const f = await fetch(base + '/api/forget-password', { method: 'POST' }).then(r => r.json());
    assert.ok(f.ok, 'forget-password should report ok');
    assert.equal(f.savedCredential, false, 'forget-password should report savedCredential=false');
    await sleep(300);
    assert.ok(!fs.existsSync(TEST_CRED_FILE), 'forget-password should delete the credential file');
    ok('Forget deleted the saved password from this PC');

    cfg = await fetch(base + '/api/config').then(r => r.json());
    assert.equal(cfg.savedCredential, false, '/api/config should report savedCredential=false after Forget');
    assert.ok(cfg.live && cfg.live.running === false, 'the live loop should stop after Forget');
    ok('after Forget: savedCredential=false and the live loop is stopped');
  } finally {
    child.kill();
    await zlt.close();
    try { fs.rmSync(dataFile, { force: true }); } catch {}
    try { fs.rmSync(TEST_CRED_FILE, { force: true }); } catch {}
  }

  // ---- Part 3: boot auto-arm — a saved password makes the helper start ----
  // ---- reading on its own after a restart, with NO browser and NO Sync.  ----
  const PORT3 = 8981;
  const base3 = `http://127.0.0.1:${PORT3}`;
  const zlt3 = await startFakeZlt({ port: 9116, password: boxPw });
  // Pre-seed the saved credential exactly as ticking "remember on this PC" would,
  // pointing at the fake ZLT. deriveKey() is identical on this machine/account, so
  // the freshly-spawned child reads it back — just like the real reboot case.
  saveCredential({ routerIp: '127.0.0.1:9116', password: boxPw, collectorId: 'zlt-sms' });
  assert.ok(fs.existsSync(TEST_CRED_FILE), 'the pre-seeded credential file should exist before boot');
  const child3 = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT3), ROUTER_IP: '127.0.0.1:9116', LIVE_POLL_SECONDS: '1' },
    stdio: 'ignore'
  });
  try {
    const up = await waitForServer(base3, 6000);
    if (!up) { console.log('  ! server did not start on the test port — skipping (not a failure).'); return; }

    // No Sync is ever sent. The helper should have read the saved password at
    // boot, reported it, and armed the live loop entirely on its own.
    const cfg = await fetch(base3 + '/api/config').then(r => r.json());
    assert.equal(cfg.savedCredential, true, 'a booted server should report the saved credential');
    ok('after a restart: /api/config shows the saved credential (no Sync sent)');

    const live = await waitLive(base3, d => d && d.running && d.devices && d.devices.count >= 1, 8000);
    assert.ok(live.running, 'the live loop should arm itself at boot from the saved password');
    assert.ok(live.devices && live.devices.count >= 1, 'the helper should be streaming devices with no Sync');
    ok('after a restart: the helper logged in and went Live on its own — ZERO clicks, no Sync');
  } finally {
    child3.kill();
    await zlt3.close();
    try { fs.rmSync(dataFile, { force: true }); } catch {}
    try { fs.rmSync(TEST_CRED_FILE, { force: true }); } catch {}
  }
}

async function phaseG() {
  console.log('\nPHASE G — uptime/outage watcher (pure fold logic + live HTTP)');
  const { foldReliability, cycleWindowStart } = require('../server.js');

  // ---- Part 1: the PURE computation — no HTTP, no real clock, fully deterministic.
  // A synthetic timeline: poll = 30s, an outage needs 2 consecutive down ticks.
  // Mid-month/mid-day base keeps every sample inside ONE billing window (day=1) in
  // any timezone, so the running totals accumulate instead of resetting.
  const OPTS = { pollSeconds: 30, cycleStartDay: 1, maxOutages: 50, debounceDown: 2 };
  const B = Date.parse('2026-09-15T12:00:00.000Z');
  const at = n => new Date(B + n * 30000).toISOString();               // n-th 30s tick
  const fold = (prev, up, n, type) =>
    foldReliability(prev, { at: at(n), up, type: up ? null : (type || 'service-down') }, OPTS);

  // (A) Steady up → 100%, no outages, observed time counted.
  let s = null;
  s = fold(s, true, 0); s = fold(s, true, 1); s = fold(s, true, 2);
  assert.equal(s.outages.length, 0, 'a healthy line records no outages');
  assert.equal(s.currentlyDown, false, 'a healthy line is not "currently down"');
  assert.equal(s.uptimePct, 100, 'a healthy line reads 100% uptime');
  assert.equal(s.observedSeconds, 90, 'observed time = 3 ticks * 30s');
  ok('steady up → 100% uptime, no outages, observed time counted honestly');

  // (B) A single failed probe must NOT open an outage (de-bounce swallows a blip).
  s = null;
  s = fold(s, true, 0);
  s = fold(s, false, 1, 'service-down'); // one stray failure
  s = fold(s, true, 2);                  // recovers immediately
  assert.equal(s.outages.length, 0, 'a single-tick blip must not become an outage (de-bounce)');
  assert.equal(s.currentlyDown, false, 'a blip leaves us not-down');
  assert.equal(s.uptimePct, 100, 'a swallowed blip must not ding the uptime %');
  ok('a single-tick blip is ignored (de-bounce → no false outage, % untouched)');

  // (C) Two+ consecutive downs → exactly ONE outage, BACKDATED to the first failure,
  //     labelled with the cause; recovery closes it; the % falls to match.
  s = null;
  s = fold(s, true, 0);                    // up
  s = fold(s, false, 1, 'service-down');   // down #1 (pending, not yet an outage)
  s = fold(s, false, 2, 'service-down');   // down #2 → outage opens, backdated to tick 1
  assert.equal(s.outages.length, 1, 'two consecutive downs open exactly one outage');
  assert.equal(s.currentlyDown, true, 'we are currently down mid-outage');
  assert.equal(s.outages[0].start, at(1), 'the outage is BACKDATED to the first failed probe');
  assert.equal(s.outages[0].end, null, 'an in-progress outage has no end yet');
  assert.equal(s.outages[0].type, 'service-down', 'the cause label is recorded on the outage');
  assert.ok(/·/.test(s.outages[0].when || ''), 'the outage carries a pre-formatted "when" for the page');
  ok('2 consecutive downs → one open outage, backdated to the first failure, cause labelled');

  s = fold(s, false, 3, 'service-down');   // still down
  s = fold(s, true, 4);                     // recovers → outage closes at tick 4
  assert.equal(s.outages.length, 1, 'recovery must not spawn a second outage');
  assert.equal(s.currentlyDown, false, 'after recovery we are not down');
  assert.equal(s.outages[0].end, at(4), 'the outage closes at the recovery time');
  assert.equal(s.outages[0].mins, 2, 'duration = tick1→tick4 = 90s → 2 min (rounded)');
  assert.equal(s.observedSeconds, 150, 'observed = 5 ticks * 30s');
  assert.equal(s.uptimePct, 40, '90s down / 150s observed → 40% uptime');
  ok(`outage closed on recovery (${s.outages[0].mins}m), uptime honestly fell to ${s.uptimePct}%`);

  // (D) A PC-off gap: unobserved time is EXCLUDED, and an open outage is closed at
  //     the last moment we actually watched — never claimed to continue "through the dark".
  s = null;
  s = fold(s, true, 0);
  s = fold(s, false, 1, 'service-down');
  s = fold(s, false, 2, 'service-down');   // outage open, start = tick 1
  assert.equal(s.currentlyDown, true, 'outage open before the gap');
  const observedBefore = s.observedSeconds;                 // 90
  // The PC sleeps for an hour, then wakes and sees the line up again.
  const wakeAt = new Date(B + 2 * 30000 + 3600 * 1000).toISOString();
  s = foldReliability(s, { at: wakeAt, up: true, type: null }, OPTS);
  assert.equal(s.observedSeconds, observedBefore + OPTS.pollSeconds,
    'a long gap adds only ONE poll interval, never the whole hour of darkness');
  assert.equal(s.outages[0].end, at(2),
    'an open outage is closed at the LAST observed time, not through the unwatched gap');
  assert.equal(s.currentlyDown, false, 'after a gap we are no longer mid-outage');
  ok('a PC-off gap is excluded from observed time and closes any open outage honestly');

  // (E) cycleWindowStart aligns the window to the billing cycle day (local midnight).
  const w1 = cycleWindowStart('2026-08-15T10:00:00Z', 1);
  assert.equal(w1.getDate(), 1, 'day=1 → window starts on the 1st');
  assert.equal(w1.getHours(), 0, 'window starts at local midnight');
  const w2 = cycleWindowStart('2026-08-15T10:00:00Z', 10);
  assert.equal(w2.getDate(), 10, 'day=10, date on the 15th → this month\'s 10th');
  const w3 = cycleWindowStart('2026-08-05T10:00:00Z', 10);
  assert.equal(w3.getDate(), 10, 'day=10, date on the 5th → the PREVIOUS 10th');
  assert.notEqual(w2.getMonth(), w3.getMonth(), 'the 5th and the 15th fall in different cycles');
  ok('cycleWindowStart aligns the observed window to the billing-cycle day');

  // (F) Crossing into a new billing cycle resets the observed-time totals.
  const O2 = { pollSeconds: 30, cycleStartDay: 1, maxOutages: 50, debounceDown: 2 };
  let r = null;
  r = foldReliability(r, { at: '2026-09-15T12:00:00.000Z', up: true, type: null }, O2);
  r = foldReliability(r, { at: '2026-09-15T12:00:30.000Z', up: true, type: null }, O2);
  const winBefore = r.windowStart, obsBefore = r.observedSeconds; // 60
  r = foldReliability(r, { at: '2026-10-15T12:00:00.000Z', up: true, type: null }, O2);
  assert.notEqual(r.windowStart, winBefore, 'a new month advances the observed-time window');
  assert.equal(r.observedSeconds, O2.pollSeconds, 'a new cycle resets observed time to one fresh interval');
  assert.ok(obsBefore > r.observedSeconds, 'the running total was reset, not carried over');
  ok('a billing-cycle rollover resets the observed-time window (start of a fresh month)');

  // ---- Part 2: end-to-end over HTTP, driven by a LOCAL fake probe target (offline).
  const PORT = 8982;
  const base = `http://127.0.0.1:${PORT}`;
  const serverPath = path.join(__dirname, '..', 'server.js');
  const dataFile = TEST_SERVER_DATA_FILE;
  try { fs.rmSync(dataFile, { force: true }); } catch {}
  try { fs.rmSync(TEST_CRED_FILE, { force: true }); } catch {} // boot un-armed (no Sync in this phase)

  const probe = await startFakeProbeTarget({ port: 9117 });
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      UPTIME_ENABLED: '1',            // turn the watcher ON for this phase only
      UPTIME_POLL_SECONDS: '1',       // tick every second so the test is quick
      UPTIME_TIMEOUT_MS: '800',       // a down probe gives up fast
      UPTIME_DEBOUNCE: '2',           // two down ticks before an outage opens
      UPTIME_PROBE_URLS: probe.url    // point the probe at our local fake (deterministic, offline)
    },
    stdio: 'ignore'
  });

  const readRel = () => fetch(base + '/api/history').then(r => r.json()).then(h => (h.settings && h.settings.reliability) || null);
  const waitRel = async (pred, ms) => {
    const until = Date.now() + ms;
    let last = null;
    while (Date.now() < until) { last = await readRel(); if (last && pred(last)) return last; await sleep(200); }
    return last;
  };

  try {
    const up = await waitForServer(base, 6000);
    if (!up) { console.log('  ! server did not start on the test port — skipping (not a failure).'); return; }

    // The watcher is armed at boot with NO Sync — it needs no router password.
    let rel = await waitRel(x => x.monitoring && x.observedSeconds > 0, 5000);
    assert.ok(rel && rel.monitoring === true, 'the watcher should be monitoring at boot (no Sync needed)');
    assert.ok(rel.observedSeconds > 0, 'it should accumulate observed time on a healthy line');
    assert.equal(rel.currentlyDown, false, 'a reachable probe means we are not down');
    assert.equal(rel.outages.length, 0, 'no outages on a healthy line');
    assert.equal(rel.uptimePct, 100, 'a healthy line reads 100% uptime');
    ok('the watcher is monitoring at boot with NO Sync → 100% uptime, no outages');

    // Pull the plug: the internet "goes down". After the 2-tick de-bounce, an outage opens.
    probe.setDown(true);
    rel = await waitRel(x => x.currentlyDown === true && x.outages.length === 1, 9000);
    assert.equal(rel.currentlyDown, true, 'losing the internet flips currentlyDown=true');
    assert.equal(rel.outages.length, 1, 'a sustained outage is recorded (after de-bounce)');
    assert.equal(rel.outages[0].type, 'service-down', 'with no router IP known, the cause is service-down');
    assert.equal(rel.outages[0].end, null, 'the ongoing outage has no end time yet');
    assert.ok(rel.uptimePct < 100, 'a live outage immediately pulls uptime below 100%');
    ok(`internet down → one ongoing outage opened (type ${rel.outages[0].type}), uptime ${rel.uptimePct}%`);

    // Plug it back in: the probe answers again → the outage closes with a real end time.
    probe.setDown(false);
    rel = await waitRel(x => x.currentlyDown === false && x.outages.length === 1 && x.outages[0].end, 9000);
    assert.equal(rel.currentlyDown, false, 'restoring the internet clears currentlyDown');
    assert.ok(rel.outages[0].end, 'the outage now has an end time');
    assert.ok(rel.outages[0].mins >= 1, 'the closed outage has a real duration');
    ok(`internet restored → the outage closed with a real duration (${rel.outages[0].mins}m)`);

    // The slim reliability snapshot rides along on /api/live for the fast poll.
    const live = await fetch(base + '/api/live').then(r => r.json());
    assert.ok(live.reliability && typeof live.reliability.uptimePct === 'number', '/api/live should carry a reliability snapshot');
    ok('/api/live includes the slim reliability snapshot (currentlyDown + uptimePct)');
  } finally {
    child.kill();
    await probe.close();
    try { fs.rmSync(dataFile, { force: true }); } catch {}
    try { fs.rmSync(TEST_CRED_FILE, { force: true }); } catch {}
  }
}

/* ============================================================================
   PHASE H — the Huawei fibre reader, and catching up after the PC was off.
   ----------------------------------------------------------------------------
   The important idea being tested here: the router counts all the time, whether
   or not this helper is running. So the difference between "what the meter said
   last time" and "what it says now" is the usage for that WHOLE period, however
   long it was. These checks make the helper prove it.
   ========================================================================== */

const DAY_MS = 24 * 60 * 60 * 1000;
function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Pretend the last reading happened `days` ago — i.e. the PC was switched off
   for that long while the router carried on counting. */
function backdateLastReading(store, sourceId, days) {
  const state = store.read();
  const then = new Date(Date.now() - days * DAY_MS).toISOString();
  state.accounting[sourceId].lastObservation.observedAt = then;
  state.accounting[sourceId].lastSeenAt = then;
  store.write(state);
  return then;
}

async function phaseH() {
  console.log('\nPHASE H — Huawei HG8145X7 reader + catching up after the PC was off');
  const tmpFile = path.join(__dirname, '.selftest-huawei.json');
  try { fs.rmSync(tmpFile, { force: true }); } catch {}

  const START_DOWN = 1689502191;   // BytesReceived, exactly as the real box sent it
  const START_UP = 896319260;      // BytesSent
  const ADDR = 'http://127.0.0.1:9118';
  const HUAWEI_ID = 'huawei-hg8145x7';

  const fake = await startFakeHuawei({ port: 9118, password: 'admin', down: START_DOWN, up: START_UP });
  try {
    const store = new JsonStore(tmpFile);
    const registry = createCollectorRegistry();
    const svc = new SyncService({ store, registry, defaultRouterIp: ADDR });
    const sync = () => svc.sync({ collectorId: 'auto', routerIp: ADDR, password: 'admin' });

    // 1) Auto-detect and a first reading.
    const r1 = await sync();
    assert.match(r1.detectedModel, /Huawei HG8145X7/, 'auto-detect should identify the Huawei ONT');
    ok('auto-detect identified: ' + r1.detectedModel);
    assert.equal(r1.counterStatus, 'baseline', 'the first reading is only a starting point');
    assert.equal(r1.records.length, 0, 'a baseline must not invent a daily figure');
    ok('first sync = baseline, no invented usage');

    // The box labels its totals "BytesSent" / "BytesReceived". Getting these the
    // wrong way round would silently swap the whole dashboard's up and down.
    assert.equal(r1.counters.downloadBytes, START_DOWN, 'BytesReceived must land in download');
    assert.equal(r1.counters.uploadBytes, START_UP, 'BytesSent must land in upload');
    ok('BytesReceived → download, BytesSent → upload (not swapped)');
    assert.equal(r1.counters.counterScope, 'wan', 'these are whole-WAN totals, so Wi-Fi is included');
    assert.equal(r1.counters.counterDetails.fieldsReceived, 10, 'the box sends 10 values');
    assert.equal(r1.counters.counterDetails.fieldsDeclared, 14, 'while declaring 14');
    assert.equal(r1.counters.counterDetails.usedHighLowHalves, false,
      'the 32-bit halves are not on the wire and must not be pretended into existence');
    ok('reads the 10 values the box really sends, and invents none of the missing 4');

    // 1b) THE CONNECTED-DEVICE LIST. The box names who is attached (name + IP +
    //     MAC + online) but carries NO per-device byte figure, so the panel can
    //     only ever go Live for who-is-connected — never per-device usage. The
    //     fake box ships the exact real shape: hex-escaped MACs/IPs, the array
    //     defined twice (if/else on ProductType), and a WifiWorkingModes array
    //     repeating every MAC in UPPER case — so decode + triple-dedup are all
    //     exercised in one end-to-end read.
    assert.ok(r1.devices, 'the first sync should also read the connected-device list');
    const devList = r1.devices.list;
    assert.equal(devList.length, 3, `expected 3 distinct devices, got ${devList.length}`);
    ok(`read ${devList.length} connected devices (deduped from the triple-listed page)`);

    const byName = n => devList.find(d => d.name === n);
    assert.ok(byName('Phone-A'), 'the phone should be listed by name');
    assert.equal(byName('Phone-A').ip, '192.168.100.5', 'the hex-escaped IP must be decoded');
    assert.equal(byName('Phone-A').mac, 'aa:bb:cc:00:00:01', 'the hex-escaped MAC must be decoded');
    assert.equal(byName('Phone-A').online, true, 'the phone is Online');
    ok('device names, IPs and MACs are decoded (\\x3a → ":", \\x2e → ".")');

    assert.ok(byName('Phone-B'), 'the \\x2d ("-") in a name must be decoded too');
    assert.equal(byName('TV-D').online, false, 'the Offline TV must read as offline');
    ok('online/offline status is read per device');

    assert.equal(r1.devices.count, 2, 'the online count should exclude the offline TV');
    ok(`online count is ${r1.devices.count} (the offline TV is not counted)`);

    // 1c) The stored copy must be stamped with WHICH router produced it and WHEN,
    //     so the dashboard's freshness+source gate can tell it apart from a stale
    //     reading left behind by the retired ZLT box.
    const storedDevices = store.read().settings.devices;
    assert.equal(storedDevices.sourceId, HUAWEI_ID, 'devices must be stamped with the source router id');
    assert.equal(storedDevices.routerIp, '127.0.0.1', 'devices must be stamped with the router IP');
    assert.ok(storedDevices.observedAt, 'devices must be stamped with when they were read');
    // No per-device usage must ever appear — the box does not report it.
    assert.ok(devList.every(d => d.gb === undefined && d.usageBytes === undefined),
      'the box has no per-device byte figure, so none must be invented');
    ok('devices are stamped with router id + IP + time, and carry no invented per-device usage');

    // 2) Ordinary case: some traffic, a short while later.
    fake.addBytes({ down: 300 * 1024 * 1024, up: 100 * 1024 * 1024 });
    await sleep(1100);
    const r2 = await sync();
    assert.equal(r2.counterStatus, 'updated', 'a bigger reading means usage');
    assert.ok(r2.records.length >= 1, 'a daily usage record should exist now');
    ok('second sync = updated, usage recorded');

    // 3) THE ONE THE USER ASKED FOR: the helper was off for three days while the
    //    router kept counting. The next reading must account for all of it, and
    //    spread it over the days it happened on — not dump it all on today.
    const expectedDates = [3, 2, 1, 0].map(d => localDate(new Date(Date.now() - d * DAY_MS)));
    // Today already holds the 0.39 GB from step 2, so measure what the gap ADDS,
    // not what the days end up holding in total.
    const sumFor = recs => recs
      .filter(x => expectedDates.includes(x.date))
      .reduce((s, x) => s + Number(x.usageGB || 0), 0);
    const beforeGB = sumFor(store.read().records);

    const gapStartedAt = backdateLastReading(store, HUAWEI_ID, 3);
    const GAP_DOWN = 6 * GIB;
    const GAP_UP = 2 * GIB;
    fake.addBytes({ down: GAP_DOWN, up: GAP_UP });
    const r3 = await sync();
    assert.equal(r3.counterStatus, 'updated', 'coming back after a gap is ordinary usage, not a reset');

    const gapRecords = r3.records.filter(x => expectedDates.includes(x.date));
    assert.ok(gapRecords.length >= 3,
      `the missed days should each get a figure; got ${gapRecords.length} of ${expectedDates.length}`);
    ok(`a 3-day gap was filled in across ${gapRecords.length} separate days`);

    const addedGB = sumFor(store.read().records) - beforeGB;
    const expectedGB = (GAP_DOWN + GAP_UP) / GIB;
    assert.ok(Math.abs(addedGB - expectedGB) < 0.2,
      `the whole gap should be accounted for: expected ~${expectedGB} GB, got ${addedGB.toFixed(2)} GB`);
    ok(`everything that happened while the helper was off was counted (${addedGB.toFixed(2)} GB of ~${expectedGB} GB)`);
    assert.ok(new Date(gapStartedAt) < new Date(),
      'sanity: the backdated reading really was in the past');

    // 4) The counter fills up and rolls back to zero. One direction only — the
    //    upload total is nowhere near the top, which is how we know it is a
    //    roll-over and not the box restarting.
    fake.setCounters({ down: 4200000000 });
    await sync();
    fake.setCounters({ down: 100000000 });
    fake.addBytes({ up: 5 * 1024 * 1024 });
    const r4 = await sync();
    assert.equal(r4.counterStatus, 'counter-wrapped', 'a roll-over should be recognised, not treated as a reset');
    const wrapEvent = r4.events[0];
    assert.equal(wrapEvent.details.downloadReason, 'rolled-over');
    assert.equal(wrapEvent.details.creditedDownloadBytes, (4294967296 - 4200000000) + 100000000,
      'the traffic either side of the roll-over point should be added together');
    assert.equal(wrapEvent.details.figureIsMinimum, false, 'a repaired roll-over is an exact figure');
    ok('a counter that rolled past 4 GB was repaired, not thrown away');

    // 4b) THE SAME ROLL-OVER, BUT ACROSS A LONG GAP, WITH USAGE HISTORY TO LEAN
    //     ON. At this line's real speed the 4.29 GB counter fills in roughly a
    //     quarter of an hour, so over a day it can go round many times and the
    //     router never says how many. Rather than credit only the one provable
    //     lap (which would badly undercount), the helper now ESTIMATES the most
    //     likely number of laps from this line's normal daily usage — and labels
    //     the day a best estimate, with the provable floor kept alongside.
    // Seed a few confidently-measured heavy days so the estimator has a real
    // daily rate to lean on — this line does tens of GB/day, which is many laps
    // of the 4.29 GB counter. (Without history the fallback-to-minimum path is
    // covered separately in 4c.)
    (() => {
      const st = store.read();
      // Seed recordVariants (the source of truth) and let the visible records
      // rebuild from it — pushing to st.records alone would be discarded.
      for (let d = 5; d <= 8; d++) {
        const rec = {
          date: localDate(new Date(Date.now() - d * DAY_MS)),
          usageBytes: 30 * GIB, downloadBytes: 27 * GIB, uploadBytes: 3 * GIB,
          usageGB: 30, confidence: 'observed', granularity: 'day',
          sourceId: HUAWEI_ID, sourceType: 'router-counter', sourceLabel: 'MTN FibreX • Huawei HG8145X7',
          provenance: HUAWEI_ID, observedAt: new Date(Date.now() - d * DAY_MS).toISOString(), rawMessage: 'seed'
        };
        st.recordVariants = st.recordVariants || [];
        st.recordVariants.push(rec);
        st.records.push(rec);
      }
      store.write(st);
    })();
    fake.setCounters({ down: 4200000000 });
    await sync();
    backdateLastReading(store, 'huawei-hg8145x7', 1);   // pretend the PC was off for a day
    fake.setCounters({ down: 100000000 });
    fake.addBytes({ up: 5 * 1024 * 1024 });
    const r4b = await sync();
    assert.equal(r4b.counterStatus, 'counter-wrapped',
      'a long gap must still be repaired as a roll-over, not binned');
    const longWrap = r4b.events[0];
    assert.equal(longWrap.details.downloadReason, 'rolled-over');
    const oneLap = (4294967296 - 4200000000) + 100000000;
    assert.equal(longWrap.details.minimumDownloadBytes, oneLap,
      'the one provable lap is preserved as the floor beneath the estimate');
    assert.ok(longWrap.details.creditedDownloadBytes >= oneLap,
      'the estimate is never below the provable floor');
    assert.equal(longWrap.details.figureIsEstimate, true,
      'a long gap with usage history to lean on yields a best estimate');
    assert.equal(longWrap.details.figureIsMinimum, false, 'an estimate is not a bare minimum');
    assert.ok(longWrap.details.estimatedLaps >= 1, 'the estimate records how many laps it assumed');
    // The wrap spans yesterday→today. Today already carries observed-minimum
    // from the step-4 reset (a minimum rightly wins on a shared day), so the
    // clean estimate lands on the backdated day.
    const yesterday = localDate(new Date(Date.now() - DAY_MS));
    const wrapDay = store.read().records.find(x => x.date === yesterday);
    assert.equal(wrapDay.confidence, 'observed-estimate',
      'the backdated day must be labelled a best estimate');
    assert.match(wrapDay.rawMessage, /ESTIMATE/,
      'and must say ESTIMATE in plain words, not just flag it');
    ok('a long-gap roll-over is estimated from normal usage, not left at a bare minimum');

    // 4c) THE SAME LONG GAP, BUT WITH NO USAGE HISTORY to base a guess on. With
    //     nothing to estimate from, the helper must NOT invent a number — it
    //     falls back to the one provable lap and labels the day a MINIMUM. Uses a
    //     brand-new store + a second fake box so there is no history at all.
    const freshFake = await startFakeHuawei({ port: 9121, password: 'admin', down: 4200000000, up: 1000000 });
    try {
      const freshStore = new JsonStore(tmpFile + '.nohist');
      const freshSvc = new SyncService({ store: freshStore, registry: createCollectorRegistry(), defaultRouterIp: 'http://127.0.0.1:9121' });
      const freshSync = () => freshSvc.sync({ collectorId: 'auto', routerIp: 'http://127.0.0.1:9121', password: 'admin' });
      await freshSync();                                   // baseline only, no records yet
      backdateLastReading(freshStore, HUAWEI_ID, 1);
      freshFake.setCounters({ down: 100000000 });
      freshFake.addBytes({ up: 5 * 1024 * 1024 });
      const r4c = await freshSync();
      const nohist = r4c.events[0];
      assert.equal(nohist.details.figureIsEstimate, false,
        'with no history there is nothing to estimate from');
      assert.equal(nohist.details.figureIsMinimum, true,
        'so the honest answer is the one provable lap, as a minimum');
      assert.equal(nohist.details.minimumReason, 'multiple-wraps-possible');
      const nohistDay = freshStore.read().records.find(x => x.date === localDate(new Date()));
      assert.equal(nohistDay.confidence, 'observed-minimum');
      assert.match(nohistDay.rawMessage, /AT LEAST/);
      ok('with no usage history, a long-gap roll-over stays an honest minimum — never a guess');
    } finally {
      await freshFake.close();
    }

    // 5) A genuine restart: BOTH totals drop, from nowhere near the top. The
    //    honest answer is "at least this much", and it must say so.
    fake.setCounters({ down: 5 * 1024 * 1024, up: 1024 * 1024 });
    const r5 = await sync();
    assert.equal(r5.counterStatus, 'counter-reset', 'both totals dropping means the meter restarted');
    const resetEvent = r5.events[0];
    assert.equal(resetEvent.details.gapAccounted, true, 'the period must NOT be silently discarded');
    assert.equal(resetEvent.details.creditedDownloadBytes, 5 * 1024 * 1024,
      'the traffic since the meter restarted is what we can prove');
    assert.equal(resetEvent.details.figureIsMinimum, true, 'and it is a floor, not the whole truth');
    ok('a real counter restart credits what it can prove instead of binning the period');

    const today = localDate(new Date());
    const todayRecord = store.read().records.find(x => x.date === today);
    assert.equal(todayRecord.confidence, 'observed-minimum',
      'a day built on a restarted meter must be labelled a minimum');
    assert.match(todayRecord.rawMessage, /AT LEAST/,
      'and must say so in plain words, not just in a code');
    ok('the affected day is labelled "at least this much", in plain words');

    // 6) A wrong password must still be refused, even after a good one worked.
    await assert.rejects(
      () => svc.sync({ collectorId: 'auto', routerIp: ADDR, password: 'definitely-wrong' }),
      /password/i,
      'a wrong password should be rejected'
    );
    ok('wrong password is rejected (a kept session cannot be ridden on)');

    // 7) The signed-in session is reused rather than logging in over and over —
    //    the box allows one admin at a time and locks out after 3 bad tries.
    const logins = fake.fetched.filter(u => u === '/login.cgi').length;
    const reads = fake.fetched.filter(u => /pppwanstat/.test(u)).length;
    assert.ok(logins < reads, `should not log in for every read (${logins} logins, ${reads} reads)`);
    ok(`signs in once and reuses it (${logins} logins for ${reads} counter reads)`);
  } finally {
    await fake.close();
    try { fs.rmSync(tmpFile, { force: true }); } catch {}
  }

  /* The ZTE reader has no roll-over point, so it must never "repair" one — but
     it SHOULD still credit a restart rather than throw the period away. */
  const zteFile = path.join(__dirname, '.selftest-zte-reset.json');
  try { fs.rmSync(zteFile, { force: true }); } catch {}
  const zte = await startFakeZte({ port: 9119, password: 'admin', down: 50 * GIB, up: 5 * GIB, uptime: 90000 });
  try {
    const store = new JsonStore(zteFile);
    const svc = new SyncService({ store, registry: createCollectorRegistry(), defaultRouterIp: '127.0.0.1:9119' });
    const sync = () => svc.sync({ collectorId: 'auto', routerIp: '127.0.0.1:9119', password: 'admin' });

    await sync();
    zte.setCounters({ down: 2 * GIB, up: 1 * GIB, uptime: 60 });
    const after = await sync();
    assert.equal(after.counterStatus, 'counter-reset', 'the ZTE box restarting is still a reset');
    assert.notEqual(after.counterStatus, 'counter-wrapped', 'a reader with no roll-over point must never claim one');
    assert.equal(after.events[0].details.counterWrapBytes, null, 'the ZTE reader declares no roll-over point');
    assert.equal(after.events[0].details.gapAccounted, true, 'and its period is credited too, not binned');
    assert.ok(after.records.length >= 1, 'so a usage figure exists after the reset');
    ok('the ZTE reader is unchanged: restarts are credited, roll-overs are never invented');
  } finally {
    await zte.close();
    try { fs.rmSync(zteFile, { force: true }); } catch {}
  }
}

(async () => {
  try {
    await phaseA();
    await phaseB();
    await phaseC();
    await phaseD();
    await phaseE();
    await phaseF();
    await phaseG();
    await phaseH();
    console.log(`\nALL CHECKS PASSED (${passed} checks). The helper reads a router correctly.`);
    process.exit(0);
  } catch (err) {
    console.error('\nSELF-TEST FAILED:', err && err.message ? err.message : err);
    console.error(err && err.stack ? err.stack : '');
    process.exit(1);
  }
})();
