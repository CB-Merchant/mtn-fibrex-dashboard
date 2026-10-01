'use strict';

/* ============================================================================
   Fake ZTE F6600P router — for TESTING the helper without the real box.
   ----------------------------------------------------------------------------
   It pretends to be an MTN FibreX (ZTE) gateway just enough to satisfy the
   real router-reading engine (helper/engine/collectors/zte-f6600p.js):

     - GET  /                                     landing HTML with ZTE markers
     - GET  /?_type=loginData&_tag=login_entry    session JSON
     - GET  /?_type=loginData&_tag=login_token     login challenge
     - POST /?_type=loginData&_tag=login_entry     validates sha256(pw+challenge)
     - GET  /?_type=menuView&_tag=...              page shell (no SessionTimeout)
     - GET  /?_type=menuData&_tag=wan_...          WAN counters (Rx/Tx/UpTime)
     - GET  /?_type=menuData&_tag=status_lan_...   LAN access counters
     - GET  /?_type=menuData&_tag=wlan_...         WLAN access counters

   The download/upload totals it reports are cumulative (like a real counter),
   so bumping them with setCounters() between two syncs produces a real daily
   usage record. Used by selftest.js. Not part of normal operation.
   ========================================================================== */

const http = require('http');
const crypto = require('crypto');

const GIB = 1024 * 1024 * 1024;
const CHALLENGE = 'FAKEZTECHALLENGE01';

function xmlPairs(pairs) {
  return pairs.map(([name, value]) =>
    `<ParaName>${name}</ParaName><ParaValue>${value}</ParaValue>`).join('\n');
}

function instance(pairs) {
  return `<Instance>\n${xmlPairs(pairs)}\n</Instance>`;
}

function startFakeZte({ port = 9101, password = 'admin', down = 200 * GIB, up = 20 * GIB, uptime = 90000 } = {}) {
  const state = { password, down, up, uptime };

  const landing =
    '<!DOCTYPE html><html><head><title>ZTE F6600P</title></head>' +
    '<body>ZTE Corporation. Router login: _type=loginData&_tag=login_entry</body></html>';

  function wanXml() {
    return '<ajax_response_xml_root>\n' + xmlPairs([
      ['RxBytes', Math.round(state.down)],
      ['TxBytes', Math.round(state.up)],
      ['UpTime', Math.round(state.uptime)],
      ['ConnStatus', 'Connected']
    ]) + '\n</ajax_response_xml_root>';
  }

  // All traffic reported on WLAN AP #1 (LAN ports present but zero) so the
  // engine's access-counter aggregation succeeds → counterScope = 'access'.
  function wlanXml() {
    return '<ajax_response_xml_root>\n' +
      '<OBJ_WLANAP_ID>\n' + instance([['_InstID', '1'], ['Enable', '1']]) + '\n</OBJ_WLANAP_ID>\n' +
      '<OBJ_WLANCONFIGDRV_ID>\n' + instance([
        ['_InstID', '1'],
        ['TotalBytesSent', Math.round(state.down)],
        ['TotalBytesReceived', Math.round(state.up)]
      ]) + '\n</OBJ_WLANCONFIGDRV_ID>\n</ajax_response_xml_root>';
  }

  function lanXml() {
    return '<ajax_response_xml_root>\n' +
      '<OBJ_PON_PORT_BASIC_STATUS_ID>\n' + instance([
        ['_InstID', '1'], ['InBytes', '0'], ['OutBytes', '0']
      ]) + '\n</OBJ_PON_PORT_BASIC_STATUS_ID>\n</ajax_response_xml_root>';
  }

  function send(res, status, contentType, body) {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const type = url.searchParams.get('_type');
    const tag = url.searchParams.get('_tag');

    // Login: session JSON (GET) vs login submit (POST)
    if (type === 'loginData' && tag === 'login_entry') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const expected = crypto.createHash('sha256').update(state.password + CHALLENGE).digest('hex');
          if (params.get('Password') === expected) {
            send(res, 200, 'application/json', JSON.stringify({ sess_token: 'authok123' }));
          } else {
            send(res, 200, 'application/json', JSON.stringify({ loginErrMsg: 'user name or password error' }));
          }
        });
        return;
      }
      return send(res, 200, 'application/json', JSON.stringify({ sess_token: 'sesstoken123' }));
    }

    if (type === 'loginData' && tag === 'login_token') {
      return send(res, 200, 'application/xml', `<ajax_response_xml_root>${CHALLENGE}</ajax_response_xml_root>`);
    }

    if (type === 'menuView') {
      return send(res, 200, 'text/html', '<html><body>menu ok</body></html>');
    }

    if (type === 'menuData') {
      if (tag && tag.startsWith('wan_internetstatus')) return send(res, 200, 'application/xml', wanXml());
      if (tag && tag.startsWith('status_lan_info')) return send(res, 200, 'application/xml', lanXml());
      if (tag && tag.startsWith('wlan_wlanstatus')) return send(res, 200, 'application/xml', wlanXml());
      return send(res, 404, 'application/xml', '<ajax_response_xml_root/>');
    }

    // Landing page (probe + post-login GET /). Everything else → 404.
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html', landing);
    }
    return send(res, 404, 'text/plain', 'not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        url: `127.0.0.1:${port}`,
        setCounters({ down, up, uptime } = {}) {
          if (down != null) state.down = down;
          if (up != null) state.up = up;
          if (uptime != null) state.uptime = uptime;
        },
        addBytes({ down = 0, up = 0, uptime = 0 } = {}) {
          state.down += down; state.up += up; state.uptime += uptime;
        },
        close() { return new Promise(r => server.close(r)); }
      });
    });
  });
}

/* ============================================================================
   Fake ZLT X17U (MTN 5G ODU) — for TESTING the zlt-sms collector.
   ----------------------------------------------------------------------------
   Everything is a POST of JSON to /cgi-bin/http.cgi with a `cmd` number, just
   like the real box. We answer the handful of cmds the collector uses:
     232 token · 100 login (checks sha256(token+password)) · 233 refresh ·
     1005 model · 12 SMS pages · 113 network · 205 signal · 133 throughput ·
     223 device list (the real "getAllDevice" cmd → array under `dhcp_list_info`,
     each entry with hostname/mac/ip + a flow counter we leave at 0). Any other
     cmd → {} (so the collector's device cmd-sweep moves on cleanly). Used by
     selftest.js only.
   ========================================================================== */
const DEFAULT_ZLT_DEVICES = [
  { hostname: 'Pixel-7',        mac: 'A4:50:46:11:22:33', ip: '192.168.0.101' },
  { hostname: 'MacBook-Air',    mac: 'F0:18:98:AA:BB:CC', ip: '192.168.0.102' },
  { hostname: 'TV-D', mac: '3C:5A:B4:DD:EE:FF', ip: '192.168.0.103' }
];
const DEFAULT_ZLT_SIGNAL = {
  networkType: '5G(NSA)', signalLevel: 4,
  rsrp: -72, rsrp5g: -65, rsrq: -12, sinr: 15,
  band: 'B7+B3', cellId: '6301153', enodebId: '405521',
  rxRate: 6_250_000, txRate: 1_250_000 // bytes/sec → 50 Mbps down, 10 Mbps up
};
const DEFAULT_ZLT_SMS = [
  "Y'ello, your data usage for 19-08-2026 is 17.2 GB.",
  "Y'ello, your data usage for 20-08-2026 is 18.4 GB."
];

function startFakeZlt({
  port = 9111,
  password = 'admin',
  model = 'ZLT X17U',
  devices = DEFAULT_ZLT_DEVICES,
  signal = DEFAULT_ZLT_SIGNAL,
  sms = DEFAULT_ZLT_SMS
} = {}) {
  const token = 'FAKEZLTTOKEN0001';
  // Runtime-injectable faults (for the resilience regression test). Left off by
  // default, so normal tests are unaffected.
  const fault = {
    tokenFail: false, // cmd 232 returns junk → login() throws "Invalid token response" (a TRANSIENT error)
    blankReads: false // signal + device cmds return {} → both reads null → collectLive re-logs in (hitting tokenFail)
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/cgi-bin/http.cgi')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body || '{}'); } catch {}
      const cmd = Number(msg.cmd);
      const json = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const junk = () => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('SERVICE TEMPORARILY BUSY'); };

      switch (cmd) {
        case 232: return fault.tokenFail ? junk() : json({ token });
        case 233: return json({ token });
        case 100: {
          const expected = crypto.createHash('sha256').update(token + password).digest('hex');
          if (msg.passwd !== expected) return json({ login_fail: 'fail' });
          return json({ sessionId: msg.sessionId || 'srv-session' });
        }
        case 1005: return json({ board_type: model });
        case 12: {
          const page = Number(msg.page_num) || 1;
          const list = page === 1 ? sms.map(s => Buffer.from(String(s), 'utf8').toString('base64')) : [];
          return json({ sms_list: list });
        }
        case 113: return fault.blankReads ? json({}) : json({ network_type_str: signal.networkType, signal_lvl: signal.signalLevel });
        case 205: return fault.blankReads ? json({}) : json({
          RSRP: signal.rsrp, RSRP_5G: signal.rsrp5g, RSRQ: signal.rsrq, SINR: signal.sinr,
          FREQ: signal.band, CELL_ID: signal.cellId, ENODEBID: signal.enodebId
        });
        case 133: return fault.blankReads ? json({}) : json({ netWanRxRate: signal.rxRate, netWanTxRate: signal.txRate });
        case 223: return fault.blankReads ? json({}) : json({ dhcp_list_info: devices.map(d => ({ ...d, flow: 0 })) });
        default: return json({}); // any other cmd in the sweep → move on cleanly
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        url: `127.0.0.1:${port}`,
        // Turn a transient blip on/off: the router briefly can't hand out a token
        // AND its status/device reads come back empty — exactly what a weak 5G
        // link does mid-read. Used to prove the live loop survives and recovers.
        induceTransientFault(on = true) { fault.tokenFail = !!on; fault.blankReads = !!on; },
        close() { return new Promise(r => server.close(r)); }
      });
    });
  });
}

/* ============================================================================
   Fake speed-test target — stands in for Cloudflare so runSpeedTest() can be
   exercised offline with no data cost.
     GET  /__down?bytes=N   → N bytes
     POST /__up             → 200 (counts what it received)
   ========================================================================== */
function startFakeSpeedTarget({ port = 9112 } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/__down') {
      const bytes = Math.max(0, Number(url.searchParams.get('bytes')) || 0);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) });
      return res.end(Buffer.alloc(bytes, 0x61));
    }
    if (req.method === 'POST' && url.pathname === '/__up') {
      let received = 0;
      req.on('data', c => { received += c.length; });
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ received })); });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        downUrl: `http://127.0.0.1:${port}/__down`,
        upUrl: `http://127.0.0.1:${port}/__up`,
        close() { return new Promise(r => server.close(r)); }
      });
    });
  });
}

/* ============================================================================
   Fake internet-probe target — stands in for cp.cloudflare.com/generate_204 so
   the uptime watcher can be driven offline and deterministically.
     up   → responds 204 (ANY HTTP response = the internet is reachable)
     down → resets the connection (a network failure = internet unreachable)
   Flip at runtime with setDown(true/false) to simulate the line dropping/coming
   back. Sends "Connection: close" so each probe is a fresh socket (no keep-alive
   reuse to muddy the up<->down transition). Port 0 = pick any free port.
   ========================================================================== */
function startFakeProbeTarget({ port = 0, down = false } = {}) {
  let isDown = !!down;
  const server = http.createServer((req, res) => {
    if (isDown) { try { req.socket.destroy(); } catch {} return; } // no internet: reset the connection
    res.writeHead(204, { 'Connection': 'close' });
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}/generate_204`,
        setDown(v) { isDown = !!v; },
        close() { return new Promise(r => server.close(r)); }
      });
    });
  });
}

/* ============================================================================
   Fake Huawei HG8145X7 (MTN FibreX ONT) — for TESTING the Huawei collector.
   ----------------------------------------------------------------------------
   Copies the real box's shapes, character for character where it matters:

     - GET  /                                     login page with its markers
     - POST /asp/GetRandCount.asp                 64-hex token, with a BOM
     - POST /login.cgi                            UserName=root + base64 password
     - everything under /html/...                 403 until signed in
     - .../wan_list_info.asp                      declares the WaninfoStats order
     - .../get_wan_list_pppwanstat.asp            the live values, unnamed
     - .../get_wan_list_ipwanstat.asp             empty (this line is PPPoE)
     - .../wan_list_cache_wan.asp                 a WanPPP record ("Connected")

   Note the reply carries TEN values where the layout declares FOURTEEN — the
   four High/Low halves are absent, exactly as the real box sends it. Anything
   that silently invents them will fail against this.

   The totals are cumulative, so addBytes() between two syncs produces a real
   daily usage figure. setCounters() can also put them anywhere, which is how
   the roll-over and restart cases get tested.
   ========================================================================== */

const HUAWEI_LAYOUT = 'function WaninfoStats(domain, BytesSent, BytesReceived, PacketsSent,'
  + ' PacketsReceived,UnicastSent,UnicastReceived,MulticastSent,MulticastReceived,'
  + 'BroadcastSent,BroadcastReceived,BytesSentHigh,BytesSentLow,BytesReceivedHigh,'
  + 'BytesReceivedLow) { this.domain = domain; this.BytesSent = BytesSent; }';

const HUAWEI_WAN_DOMAIN =
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1';

function startFakeHuawei({ port = 9118, password = 'admin', down = 1689502191, up = 896319260 } = {}) {
  const state = { password, down, up, status: 'Connected' };
  let issuedToken = null;
  let sessionId = null;
  const fetched = [];

  function send(res, status, contentType, body) {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  }

  const landing = '<!DOCTYPE html><html><head><title>Huawei Technologies</title></head>'
    + '<body><script>var ProductName = \'HG8145X7\\x2d10\'; var CfgMode = \'MTN\';'
    + ' var SSLPort = \'80\'; function Submit(){ GetRandCount(); }</script>'
    + '<input id="txt_Password" type="password"></body></html>';

  function pppStats() {
    // The real reply, with our counters dropped into the first two slots.
    return 'function() { return new Array(new WaninfoStats('
      + `"${HUAWEI_WAN_DOMAIN}.Stats",`
      + `"${Math.round(state.up)}","${Math.round(state.down)}",`
      + '"2636353","12140647","2636351","12030504","0","0","2","110143"),null); }';
  }

  function cacheWan() {
    return `var wan = new WanPPP("${HUAWEI_WAN_DOMAIN}",`
      + `"1","${state.status}","AlwaysOn","1492","4C:D0:DD:0A:1E:60","4294967295");`;
  }

  /* The connected-device page EXACTLY as the real HG8145X7 ships it (trimmed to
     three devices): every MAC and IP is written with JavaScript hex escapes
     (\x3a=":", \x2e="."), the device array is defined TWICE (an if/else on
     ProductType), and a separate WifiWorkingModes array repeats each MAC in
     UPPER case. Left undecoded this reads "0 devices"; without a case-folded
     dedup, each device appears three times. One device (the TV) is Offline so
     the online count can be checked. A Wi-Fi key sits alongside so scrubbing can
     be proven. */
  function deviceList() {
    const dev = (n, dom, ip, mac, host, status) =>
      `new USERDevice("InternetGatewayDevice.LANDevice.1.X_HW_UserDev.${n}",`
      + `"${ip}","${mac}","SSID5","DHCP","","${status}","WIFI","15\\x3a18",`
      + `"${host}","1","1","0","","0","51676","${mac}","","",`
      + `"2026\\x2d09\\x2d23T02\\x3a18\\x3a26Z")`;
    const mode = (dom, ip, MAC) =>
      `new stWifiWorkingMode("InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice.${dom}",`
      + `"11ax","${ip}","${MAC}")`;
    const rows =
      dev(1, 1, '192\\x2e168\\x2e100\\x2e5', 'aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a01', 'Phone-A', 'Online') + ','
      + dev(2, 2, '192\\x2e168\\x2e100\\x2e4', 'aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a02', 'Phone\\x2dB', 'Online') + ','
      + dev(3, 3, '192\\x2e168\\x2e100\\x2e81', 'aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a03', 'TV\\x2dD', 'Offline') + ',null';
    return '<html><body><script>'
      + 'function USERDevice(Domain,IpAddr,MacAddr,Port,IpType,DevType,DevStatus,'
      + 'PortType,Time,HostName,IPv4Enabled,IPv6Enabled,DeviceType,UserDevAlias,'
      + 'UserSpecifiedDeviceType,LeaseTimeRemaining,RealMacAddr,BrandName,OsName,'
      + 'X_HW_LastChgUtc){ this.Domain = Domain; }'
      + ' var X_HW_WlanPsk = "super-secret-wifi-key-99";'
      + ' var ProductType = \'1\';'
      + ' if (ProductType == "2") { var UserDevinfo = new Array(' + rows + '); }'
      + ' else { var UserDevinfo = new Array(' + rows + '); }'
      + ' function stWifiWorkingMode(domain,WifiMode,IPAddress,MacAddress){ this.domain = domain; }'
      + ' var WifiWorkingModes = new Array('
      + mode(1, '192\\x2e168\\x2e100\\x2e5', 'AA\\x3aBB\\x3aCC\\x3a00\\x3a00\\x3a01') + ','
      + mode(2, '192\\x2e168\\x2e100\\x2e4', 'AA\\x3aBB\\x3aCC\\x3a00\\x3a00\\x3a02') + ','
      + mode(3, '192\\x2e168\\x2e100\\x2e81', 'AA\\x3aBB\\x3aCC\\x3a00\\x3a00\\x3a03') + ',null);'
      + '</script></body></html>';
  }

  const pages = {
    '/html/bbsp/common/wan_list_info.asp': '<html><script>' + HUAWEI_LAYOUT + '</script></html>',
    '/html/bbsp/common/get_wan_list_ipwanstat.asp': 'function() { return new Array(null); }',
    '/html/bbsp/common/GetLanUserDevInfo.asp': deviceList(),
    '/html/ssmp/deviceinfo/deviceinfo.asp': '<html><body>Model HG8145X7-10</body></html>'
  };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    fetched.push(url);
    const signedIn = sessionId && (req.headers.cookie || '').includes('SessionID=' + sessionId);

    if (url === '/') return send(res, 200, 'text/html', landing);

    if (url === '/asp/GetRandCount.asp') {
      issuedToken = 'b9c86220bd57bee80ffbbfb5246f4fe6bed09aa8a9a0ecadb1f99423a4e52558';
      return send(res, 200, 'text/html', '﻿' + issuedToken);   // note the BOM
    }

    if (url === '/login.cgi') {
      let body = '';
      req.on('data', d => { body += d; });
      return req.on('end', () => {
        const form = {};
        body.split('&').forEach(kv => {
          const i = kv.indexOf('=');
          if (i > 0) form[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
        });
        const given = Buffer.from(form.PassWord || '', 'base64').toString('utf8');
        const ok = form.UserName === 'root'
          && given === state.password
          && form['x.X_HW_Token'] === issuedToken;
        if (!ok) return send(res, 200, 'text/html', '<input id="txt_Password">');
        sessionId = 'FAKEHUAWEISESSION';
        res.writeHead(302, {
          'Set-Cookie': 'SessionID=' + sessionId + '; path=/',
          Location: '/'
        });
        return res.end('');
      });
    }

    if (!signedIn) return send(res, 403, 'text/html', 'Forbidden');

    if (url === '/html/bbsp/common/get_wan_list_pppwanstat.asp') {
      return send(res, 200, 'text/html', pppStats());
    }
    if (url === '/html/bbsp/common/wan_list_cache_wan.asp') {
      return send(res, 200, 'text/html', cacheWan());
    }
    if (pages[url]) return send(res, 200, 'text/html', pages[url]);
    return send(res, 404, 'text/plain', 'not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        url: `127.0.0.1:${port}`,
        fetched,
        setCounters({ down, up, status } = {}) {
          if (down != null) state.down = down;
          if (up != null) state.up = up;
          if (status != null) state.status = status;
        },
        addBytes({ down = 0, up = 0 } = {}) { state.down += down; state.up += up; },
        // Pretend the box forgot us, so the collector has to sign in again.
        expireSession() { sessionId = null; },
        close() { return new Promise(r => server.close(r)); }
      });
    });
  });
}

module.exports = {
  startFakeZte, startFakeZlt, startFakeSpeedTarget, startFakeProbeTarget, startFakeHuawei,
  GIB, CHALLENGE
};

// Allow running standalone:  node fake-router.js  (listens on :9101)
if (require.main === module) {
  const port = Number(process.env.FAKE_PORT || 9101);
  startFakeZte({ port }).then(fake => {
    console.log(`Fake ZTE F6600P listening on http://${fake.url}  (password: admin)`);
    console.log('Point the helper at this address to test. Ctrl+C to stop.');
  }).catch(err => {
    console.error('Could not start fake router:', err.message);
    process.exit(1);
  });
}
