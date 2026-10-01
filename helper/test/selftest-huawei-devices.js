'use strict';

/* ============================================================================
   Self-test for the connected-device probe (helper/tools/probe-huawei-devices.js)
   ----------------------------------------------------------------------------
   The pretend router copies the SHAPE the EG8145V5 client expects: a page that
   defines a device constructor (so we can prove the layout is learned off the
   box) and returns an array of rows, each with a hostname, IP, MAC and status.
   It answers the get page on POST only, so the GET->POST fallback is exercised.
   The page also carries a Wi-Fi key, to prove the report scrubs it, and names
   a settings-changing address, to prove the crawl refuses to follow it.

   Nothing here touches the real router or the real usage file.

       node test/selftest-huawei-devices.js
   ========================================================================== */

const http = require('http');
const assert = require('assert');
const path = require('path');

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('  ok   ' + label); }
  catch (e) { console.log('  FAIL ' + label + '\n       ' + e.message); process.exitCode = 1; }
}

const GOOD_USER = 'root';
const GOOD_PASS = 'sekrit-Passw0rd';
const WIFI_SECRET = 'super-secret-wifi-key-99';

/* The device-list payload: a layout function, then an array of rows built by
   that constructor. Row 1 is an online phone, row 2 an offline TV. A Wi-Fi key
   sits alongside (must be scrubbed). One row-shaped call has NO MAC and must be
   ignored. Column order matches the EG8145V5 client's struct exactly. */
const DEVICE_PAGE = '<html><body><script>'
  + 'function UserDevInfo(Domain, IpAddr, MacAddr, Port, PortID, DevStatus, IpType,'
  + ' Time, HostName, IPv4Enabled, IPv6Enabled, DeviceType, UserDevAlias,'
  + ' UserSpecifiedDeviceType, LeaseTimeRemaining){ this.Domain = Domain; }'
  + ' var X_HW_WlanPsk = "' + WIFI_SECRET + '";'
  + ' var GetUserDevInfoList = new Array('
  + ' new UserDevInfo("InternetGatewayDevice.LANDevice.1.Hosts.Host.1",'
  + '"192.168.100.23","AC:12:34:56:78:9A","LAN1","1","Online","IPv4",'
  + '"2026-09-23","Ade-Phone","1","0","Phone","","","86400"),'
  + ' new UserDevInfo("InternetGatewayDevice.LANDevice.1.Hosts.Host.2",'
  + '"192.168.100.31","B8:27:EB:00:11:22","SSID1","5","Offline","IPv4",'
  + '"2026-09-22","TV-D","1","0","STB","","","0"),'
  + ' new SomeConfigRow("InternetGatewayDevice.X","enable","1","0","yes") );'
  + '</script></body></html>';

/* A menu page that names the get page (should be followed) and a set page
   (must be refused). */
const MENU_PAGE = '<html><body><script>'
  + ' function loadDevs(){ $.ajax({url:"GetLanUserDevInfo.asp"});'
  + ' $.ajax({url:"SetLanUserDevInfo.asp"}); } // userdevinfo'
  + '</script></body></html>';

/* A row exactly as the REAL HG8145X7 ships it: quoted text MIXED with bare
   numbers (booleans, lease seconds, a UTC timestamp) — no quotes on those. The
   first build read ZERO rows off this shape, so it is pinned here. Layout also
   differs from the reference (extra RealMacAddr/BrandName/OsName fields), which
   is why the probe learns the order off the box instead of assuming it. */
const REAL_SHAPE_PAGE = '<html><body><script>'
  + 'function USERDEVICE(Domain, IpAddr, MacAddr, Port, IpType, DevType, DevStatus,'
  + ' PortType, Time, HostName, IPv4Enabled, IPv6Enabled, DeviceType, UserDevAlias,'
  + ' UserSpecifiedDeviceType, LeaseTimeRemaining, RealMacAddr, BrandName, OsName,'
  + ' X_HW_LastChgUtc){ this.Domain = Domain; }'
  + ' var GetUserDevInfoList = new Array('
  + ' new USERDEVICE("InternetGatewayDevice.LANDevice.1.Hosts.Host.1",'
  + '"192.168.100.42","DE:AD:BE:EF:00:11","LAN2","IPv4","Ethernet","Online",'
  + '"Ethernet","2026-09-23","Kemi-Laptop",1,0,"Computer","","",86400,'
  + '"DE:AD:BE:EF:00:11","Dell","Windows",1758600000) );'
  + '</script></body></html>';

/* The page EXACTLY as the real HG8145X7 ships it (trimmed to 2 devices): every
   MAC and IP is written with JavaScript hex escapes (\x3a = ":", \x2e = "."),
   the device array is defined TWICE (an if/else on ProductType), and a separate
   WifiWorkingModes array repeats each MAC in UPPER case. Left undecoded this
   read "0 devices"; and without case-folding the dedup, each device would
   appear three times. Pinned here so neither regresses. */
const ESCAPED_PAGE = '<html><body><script>'
  + 'function USERDevice(Domain,IpAddr,MacAddr,Port,IpType,DevType,DevStatus,'
  + 'PortType,Time,HostName,IPv4Enabled,IPv6Enabled,DeviceType,UserDevAlias,'
  + 'UserSpecifiedDeviceType,LeaseTimeRemaining,RealMacAddr,BrandName,OsName,'
  + 'X_HW_LastChgUtc){ this.Domain = Domain; }'
  + ' var X_HW_WlanPsk = "' + WIFI_SECRET + '";'
  + ' if (ProductType == "2") {'
  + ' var UserDevinfo = new Array('
  + 'new USERDevice("InternetGatewayDevice.LANDevice.1.X_HW_UserDev.1","192\\x2e168\\x2e100\\x2e5","aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a01","SSID5","DHCP","","Online","WIFI","15\\x3a18","Phone-A","1","1","0","","0","51676","aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a01","","","2026\\x2d09\\x2d23T02\\x3a18\\x3a26Z"),'
  + 'new USERDevice("InternetGatewayDevice.LANDevice.1.X_HW_UserDev.2","192\\x2e168\\x2e100\\x2e81","aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a03","SSID5","DHCP","MSFT\\x205\\x2e0","Online","WIFI","3\\x3a56","Laptop\\x2dC","1","1","0","","0","72217","aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a03","","","2026\\x2d09\\x2d23T13\\x3a41\\x3a00Z"),null); }'
  + ' else {'
  + ' var UserDevinfo = new Array('
  + 'new USERDevice("InternetGatewayDevice.LANDevice.1.X_HW_UserDev.1","192\\x2e168\\x2e100\\x2e5","aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a01","SSID5","DHCP","","Online","WIFI","15\\x3a18","Phone-A","1","1","0","","0","51676","aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a01","","","2026\\x2d09\\x2d23T02\\x3a18\\x3a26Z"),'
  + 'new USERDevice("InternetGatewayDevice.LANDevice.1.X_HW_UserDev.2","192\\x2e168\\x2e100\\x2e81","aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a03","SSID5","DHCP","MSFT\\x205\\x2e0","Online","WIFI","3\\x3a56","Laptop\\x2dC","1","1","0","","0","72217","aa\\x3abb\\x3acc\\x3a00\\x3a00\\x3a03","","","2026\\x2d09\\x2d23T13\\x3a41\\x3a00Z"),null); }'
  + ' function stWifiWorkingMode(domain,WifiMode,IPAddress,MacAddress){ this.domain = domain; }'
  + ' var WifiWorkingModes = new Array('
  + 'new stWifiWorkingMode("InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice.1","11ax","192\\x2e168\\x2e100\\x2e5","AA\\x3aBB\\x3aCC\\x3a00\\x3a00\\x3a01"),'
  + 'new stWifiWorkingMode("InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice.2","11ac","192\\x2e168\\x2e100\\x2e81","AA\\x3aBB\\x3aCC\\x3a00\\x3a00\\x3a03"),null);'
  + '</script></body></html>';

/* A fake box that only answers the device get page on POST. */
function startFakeHuawei(pages, postOnly) {
  let issuedToken = null, sessionId = null;
  const fetched = [];
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    fetched.push(req.method + ' ' + url);
    const signedIn = sessionId && (req.headers.cookie || '').includes('SessionID=' + sessionId);

    if (url === '/asp/GetRandCount.asp') {
      issuedToken = 'b9c86220bd57bee80ffbbfb5246f4fe6bed09aa8a9a0ecadb1f99423a4e52558';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('﻿' + issuedToken);
    }
    if (url === '/login.cgi') {
      let body = '';
      req.on('data', d => body += d);
      return req.on('end', () => {
        const f = {};
        body.split('&').forEach(kv => {
          const i = kv.indexOf('=');
          if (i > 0) f[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
        });
        const pw = Buffer.from(f.PassWord || '', 'base64').toString('utf8');
        if (!(f.UserName === GOOD_USER && pw === GOOD_PASS && f['x.X_HW_Token'] === issuedToken)) {
          res.writeHead(200); return res.end('<input id="txt_Password">');
        }
        sessionId = 'FAKESESSION3';
        res.writeHead(302, { 'Set-Cookie': 'SessionID=' + sessionId + '; path=/', Location: '/' });
        return res.end('');
      });
    }
    if (url === '/logout.cgi') { sessionId = null; res.writeHead(200); return res.end('bye'); }
    if (!signedIn) { res.writeHead(403); return res.end('x'.repeat(602)); }
    if (url === '/html/ssmp/deviceinfo/deviceinfo.asp') {
      res.writeHead(200); return res.end('<html>Model HG8145X7-10</html>');
    }
    if (postOnly && postOnly.has(url) && req.method !== 'POST') {
      res.writeHead(404); return res.end('not found');
    }
    if (pages[url]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(pages[url]); }
    res.writeHead(404); res.end('not found');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, fetched }));
  });
}

/* ------------------------------------------------------------------- run it */

(async () => {
  console.log('Self-test: connected-device probe (probe-huawei-devices.js)');
  console.log('');

  /* Bring the fake box up first: it serves the REAL-shape page (hex-escaped
     values, if/else double list, Wi-Fi-mode duplicate MACs) on POST ONLY, so
     one end-to-end run proves decode + GET->POST fallback + dedup together. */
  const GET_PAGE = '/html/bbsp/common/GetLanUserDevInfo.asp';
  const fake = await startFakeHuawei({ [GET_PAGE]: ESCAPED_PAGE }, new Set([GET_PAGE]));

  /* Point probe-huawei.js at the pretend box BEFORE it is required (it reads
     these once at load). Plain HTTP, no certificates. */
  process.env.ROUTER_IP = '127.0.0.1';
  process.env.ROUTER_PORT = String(fake.port);
  process.env.ROUTER_SCHEME = 'http';

  const dev = require(path.join(__dirname, '..', 'tools', 'probe-huawei-devices.js'));
  const probe = require(path.join(__dirname, '..', 'tools', 'probe-huawei.js'));

  /* ---- the box teaches us the record layout ---- */
  check('deviceSignature learns the record layout off the box', () => {
    const sig = dev.deviceSignature(DEVICE_PAGE);
    assert(sig, 'no layout learned from the page');
    assert.strictEqual(sig[0], 'Domain');
    assert.strictEqual(sig[1], 'IpAddr');
    assert.strictEqual(sig[2], 'MacAddr');
    assert.strictEqual(sig[8], 'HostName');
  });
  check('deviceSignature ignores functions with no MAC field', () => {
    const html = 'function noMac(a, b, c, d){}';
    assert.strictEqual(dev.deviceSignature(html), null);
  });

  /* ---- device rows are found by their MAC; non-device rows are dropped ---- */
  check('deviceRecords finds the two real device rows', () => {
    const recs = dev.deviceRecords(DEVICE_PAGE);
    assert.strictEqual(recs.length, 2, 'expected 2 device rows, got ' + recs.length);
    assert(recs.every(r => r.via === 'UserDevInfo'), 'rows came from the wrong constructor');
  });
  check('deviceRecords ignores a row-shaped call with no MAC', () => {
    const recs = dev.deviceRecords(DEVICE_PAGE);
    assert(!recs.some(r => r.values.join(' ').includes('SomeConfigRow')), 'a non-device row leaked in');
    assert(!recs.some(r => r.via === 'SomeConfigRow'), 'the settings row was treated as a device');
  });

  /* ---- the real box mixes quoted text with bare numbers (regression) ---- */
  check('deviceRecords reads a REAL-shape row (quoted text + bare numbers)', () => {
    const recs = dev.deviceRecords(REAL_SHAPE_PAGE);
    assert.strictEqual(recs.length, 1, 'expected 1 real-shape row, got ' + recs.length);
    assert.strictEqual(recs[0].via, 'USERDEVICE');
    assert.strictEqual(recs[0].values.length, 20, 'lost fields while splitting');
    assert.strictEqual(recs[0].values[15], '86400', 'a bare number was mangled');
  });
  check('readable reads the real-shape row despite the different layout', () => {
    const sig = dev.deviceSignature(REAL_SHAPE_PAGE);
    const d = dev.readable(dev.deviceRecords(REAL_SHAPE_PAGE)[0], sig);
    assert.strictEqual(d.host, 'Kemi-Laptop');
    assert.strictEqual(d.ip, '192.168.100.42');
    assert.strictEqual(d.mac, 'DE:AD:BE:EF:00:11');
    assert.strictEqual(d.online, true);
  });

  /* ---- values get their names, and the four human facts read by shape ---- */
  check('labelDevice zips the learned layout onto a row', () => {
    const sig = dev.deviceSignature(DEVICE_PAGE);
    const rec = dev.deviceRecords(DEVICE_PAGE)[0];
    const labelled = dev.labelDevice(rec, sig);
    const byName = n => labelled.find(x => x.name === n).value;
    assert.strictEqual(byName('HostName'), 'Ade-Phone');
    assert.strictEqual(byName('MacAddr'), 'AC:12:34:56:78:9A');
    assert.strictEqual(byName('DevStatus'), 'Online');
  });
  check('readable reads host / IP / MAC / online for the phone', () => {
    const sig = dev.deviceSignature(DEVICE_PAGE);
    const d = dev.readable(dev.deviceRecords(DEVICE_PAGE)[0], sig);
    assert.strictEqual(d.host, 'Ade-Phone');
    assert.strictEqual(d.ip, '192.168.100.23');
    assert.strictEqual(d.mac, 'AC:12:34:56:78:9A');
    assert.strictEqual(d.online, true);
  });
  check('readable reads the offline TV as offline', () => {
    const sig = dev.deviceSignature(DEVICE_PAGE);
    const d = dev.readable(dev.deviceRecords(DEVICE_PAGE)[1], sig);
    assert.strictEqual(d.host, 'TV-D');
    assert.strictEqual(d.mac, 'B8:27:EB:00:11:22');
    assert.strictEqual(d.online, false);
  });
  check('readable finds host/IP/MAC even with NO layout (by shape)', () => {
    const d = dev.readable(dev.deviceRecords(DEVICE_PAGE)[0], null);
    assert.strictEqual(d.mac, 'AC:12:34:56:78:9A');
    assert.strictEqual(d.ip, '192.168.100.23');
    assert.strictEqual(d.host, 'Ade-Phone');   // guessed, since no HostName label
  });

  /* ---- guessHost only accepts a name-shaped value ---- */
  check('guessHost picks a name, not a domain/IP/MAC/flag', () => {
    const vals = ['InternetGatewayDevice.LANDevice.1', '192.168.100.7',
      'AC:12:34:56:78:9A', 'Online', 'Kemi-Laptop'];
    assert.strictEqual(dev.guessHost(vals), 'Kemi-Laptop');
  });

  /* ---- scrubbing: Wi-Fi key hidden, device facts kept ---- */
  check('scrub hides the Wi-Fi key but keeps MAC / IP / hostname', () => {
    const out = dev.scrub(DEVICE_PAGE);
    assert(!out.includes(WIFI_SECRET), 'Wi-Fi key was NOT scrubbed');
    assert(out.includes('AC:12:34:56:78:9A'), 'a MAC was wrongly scrubbed');
    assert(out.includes('192.168.100.23'), 'an IP was wrongly scrubbed');
    assert(out.includes('Ade-Phone'), 'a hostname was wrongly scrubbed');
  });

  /* ---- Huawei hex-escaped MACs/IPs are decoded before parsing ---- */
  check('decodeEscapes turns \\x3a / \\x2e back into ":" and "."', () => {
    assert.strictEqual(dev.decodeEscapes('aa\\x3abb\\x3acc'), 'aa:bb:cc');
    assert.strictEqual(dev.decodeEscapes('192\\x2e168\\x2e100'), '192.168.100');
  });
  check('deviceRecords finds NOTHING in the escaped page until it is decoded', () => {
    assert.strictEqual(dev.deviceRecords(ESCAPED_PAGE).length, 0, 'escaped MACs should not match raw');
    assert(dev.deviceRecords(dev.decodeEscapes(ESCAPED_PAGE)).length > 0, 'decoded page should have rows');
  });
  check('decode + parse + case-folded dedup yields exactly the 2 real devices', () => {
    const html = dev.decodeEscapes(ESCAPED_PAGE);
    const sig = dev.deviceSignature(html);
    const seen = new Set();
    const devices = [];
    dev.deviceRecords(html).map(r => dev.readable(r, sig)).forEach(d => {
      const key = d.mac ? d.mac.toLowerCase() : d.host;   // mirrors readPage
      if (seen.has(key)) return;
      seen.add(key);
      devices.push(d);
    });
    assert.strictEqual(devices.length, 2, 'expected 2 devices after dedup, got ' + devices.length);
    const byHost = h => devices.find(d => d.host === h);
    assert(byHost('Phone-A'), 'Phone-A missing');
    assert.strictEqual(byHost('Phone-A').ip, '192.168.100.5');
    assert.strictEqual(byHost('Phone-A').mac, 'aa:bb:cc:00:00:01');
    assert.strictEqual(byHost('Phone-A').online, true);
    assert(byHost('Laptop-C'), 'Laptop-C missing');
    assert.strictEqual(byHost('Laptop-C').ip, '192.168.100.81');
  });

  /* ---- the crawl follows a get-page, refuses a set-page ---- */
  check('candidatePages follows GetLanUserDevInfo.asp, refuses the Set page', () => {
    const cands = dev.candidatePages(MENU_PAGE, '/html/bbsp/common/menu.asp');
    assert(cands.some(p => /GetLanUserDevInfo\.asp$/.test(p)), 'did not follow the get page');
    assert(!cands.some(p => /Set/i.test(p)), 'followed a settings-changing page');
  });

  /* ---- verdict is honest when there is nothing to show ---- */
  check("verdict says 'none' for a page read with no device rows", () => {
    const v = dev.verdict([{ page: '/x.asp', method: 'GET', devices: [], candidates: [] }]);
    assert.strictEqual(v, 'none');
  });
  check("verdict says 'no' when nothing answered at all", () => {
    assert.strictEqual(dev.verdict([]), 'no');
  });

  /* ---- end to end against the pretend box (POST fallback + full read) ---- */
  const auth = await probe.login(GOOD_USER, GOOD_PASS);
  check('login to the pretend box succeeds', () => assert(auth.ok, auth.why));

  const results = await dev.run();
  check('run() reaches the device page over the POST fallback', () => {
    const hit = results.find(r => r.page === GET_PAGE);
    assert(hit, 'device page was never read');
    assert.strictEqual(hit.method, 'POST', 'expected the POST fallback, got ' + (hit && hit.method));
  });
  check('run() reads BOTH real devices (escaped, deduped) from the box', () => {
    const hit = results.find(r => r.page === GET_PAGE);
    assert.strictEqual(hit.devices.length, 2, 'expected 2 after dedup, got ' + hit.devices.length);
    const names = hit.devices.map(d => d.host).sort();
    assert.deepStrictEqual(names, ['Laptop-C', 'Phone-A']);
    const iphone = hit.devices.find(d => d.host === 'Phone-A');
    assert.strictEqual(iphone.mac, 'aa:bb:cc:00:00:01', 'MAC not decoded');
    assert.strictEqual(iphone.ip, '192.168.100.5', 'IP not decoded');
  });
  check("verdict on the real read is 'yes'", () => {
    assert.strictEqual(dev.verdict(results), 'yes');
  });
  check('the box taught its own 20-field layout (RealMacAddr/BrandName/OsName)', () => {
    const hit = results.find(r => r.page === GET_PAGE);
    const names = hit.devices[0].labelled.map(x => x.name);
    assert(names.includes('RealMacAddr') && names.includes('OsName'), 'layout not learned off the box');
  });

  /* ---- the box's GET->POST fallback really was exercised ---- */
  check('the device page was tried on GET first, then POST', () => {
    const gets = fake.fetched.filter(f => f === 'GET ' + GET_PAGE);
    const posts = fake.fetched.filter(f => f === 'POST ' + GET_PAGE);
    assert(gets.length >= 1, 'never tried GET first');
    assert(posts.length >= 1, 'never fell back to POST');
  });

  /* ---- no secret ever reaches the saved report ---- */
  check('the report holds neither the Wi-Fi key nor the router password', () => {
    const report = probe.reportLines.concat(dev.reportLines).join('\n');
    assert(!report.includes(WIFI_SECRET), 'Wi-Fi key leaked into the report');
    assert(!report.includes(GOOD_PASS), 'router password leaked into the report');
  });
  check('the report DOES keep device names, IPs and MACs', () => {
    const report = dev.reportLines.join('\n');
    assert(report.includes('Phone-A'), 'hostname missing from report');
    assert(report.includes('aa:bb:cc:00:00:01'), 'decoded MAC missing from report');
  });

  fake.server.close();
  console.log('');
  console.log(passed + ' checks passed.');
  if (process.exitCode) console.log('SOME CHECKS FAILED.');


})();


