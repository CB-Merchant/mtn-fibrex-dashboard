'use strict';

/* Live browser harness (NOT part of normal operation, NOT the self-test).
   Runs the REAL server.js + dashboard against a fake ZLT whose device list we
   can change at runtime, so we can watch the page update (or fail to) in a real
   browser with no reload.

   Ports:
     8961  the helper (server.js) — open http://127.0.0.1:8961/ in the browser
     9123  the fake ZLT router
     9124  a tiny control server:  GET /set?n=K  sets the device count to K
                                    GET /state    returns the current count
   Safe: server.js writes to a throwaway DATA_FILE, never the real history. */

const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const { startFakeZlt } = require('./fake-router');

const HELPER_PORT = 8961;
const ZLT_PORT = 9123;
const CTRL_PORT = 9124;
const DATA_FILE = path.join(__dirname, '.live-harness-data.json');
try { fs.rmSync(DATA_FILE, { force: true }); } catch {}

const ALL = [
  { hostname: 'Pixel-7',        mac: 'A4:50:46:11:22:33', ip: '192.168.0.101' },
  { hostname: 'MacBook-Air',    mac: 'F0:18:98:AA:BB:CC', ip: '192.168.0.102' },
  { hostname: 'TV-D', mac: '3C:5A:B4:DD:EE:FF', ip: '192.168.0.103' },
  { hostname: 'iPhone-15',      mac: '11:22:33:44:55:66', ip: '192.168.0.104' },
  { hostname: 'HP-Printer',     mac: '99:88:77:66:55:44', ip: '192.168.0.105' }
];
// devArr is what the fake serves on cmd 223; the fake reads it BY REFERENCE, so
// splicing it here changes what the router "reports" without another Sync.
const devArr = ALL.slice(0, 3);

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const zlt = await startFakeZlt({ port: ZLT_PORT, password: 'admin', devices: devArr });
  console.log(`[harness] fake ZLT on 127.0.0.1:${ZLT_PORT} (3 devices)`);

  const ctrl = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${CTRL_PORT}`);
    if (u.pathname === '/set') {
      const n = Math.max(0, Math.min(ALL.length, Number(u.searchParams.get('n')) || 0));
      devArr.length = 0;
      for (let i = 0; i < n; i++) devArr.push(ALL[i]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, count: devArr.length }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: devArr.length }));
  });
  await new Promise(r => ctrl.listen(CTRL_PORT, '127.0.0.1', r));
  console.log(`[harness] control on 127.0.0.1:${CTRL_PORT}  (GET /set?n=K)`);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(HELPER_PORT), ROUTER_IP: `127.0.0.1:${ZLT_PORT}`,
           LIVE_POLL_SECONDS: '3', DATA_FILE },
    stdio: 'inherit'
  });

  // Wait for the server, then Sync once to arm the fast loop (as the page would).
  const base = `http://127.0.0.1:${HELPER_PORT}`;
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await fetch(base + '/api/config'); up = r.ok; } catch {}
    if (!up) await sleep(200);
  }
  if (!up) { console.error('[harness] server did not start'); process.exit(1); }

  const s = await fetch(base + '/api/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collectorId: 'zlt-sms', routerIp: `127.0.0.1:${ZLT_PORT}`, password: 'admin', autoSync: true })
  }).then(r => r.json());
  console.log('[harness] synced once; live loop armed. detectedModel:', s.detectedModel || s.error);
  console.log(`[harness] READY — open ${base}/ in the browser. Change devices with:`);
  console.log(`[harness]   curl "http://127.0.0.1:${CTRL_PORT}/set?n=2"   (and n=3, n=4 …)`);

  const shutdown = async () => {
    try { child.kill(); } catch {}
    try { await zlt.close(); } catch {}
    try { ctrl.close(); } catch {}
    try { fs.rmSync(DATA_FILE, { force: true }); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
