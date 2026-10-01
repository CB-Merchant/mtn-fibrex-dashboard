'use strict';

/* ============================================================================
   Self-test for the deep counter read (helper/tools/probe-huawei-stats.js)
   ----------------------------------------------------------------------------
   The pretend router here copies the SHAPE of the real HG8145X7 pages, as seen
   in the first probe's report: a blank template page whose byte fields are
   empty strings, and a live page that defines a WanStats list carrying the real
   totals as positional values. It also carries a PPPoE password, so we can
   prove the report scrubs it.

   Nothing here touches the real router or the real usage file.

       node test/selftest-huawei-stats.js
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
const PPPOE_SECRET = 'my-pppoe-secret-9931';
const SENT = '73118450021';
const RECEIVED = '884213773194';

/* ---------------------------------------------------------- pretend Huawei */

/* The template page: field names present, values blank — exactly what the real
   box's wan_list_info.asp looked like. It also names the little page the live
   numbers come from, which the tool should notice and follow. */
const TEMPLATE_PAGE = '<html><body><script>'
  + 'function stWanList(){ this.X_HW_IPoEPassword= ""; this.IPv4EnableMulticast= "1";'
  + ' this.BytesSent = ""; this.BytesReceived = ""; this.PacketsSent = ""; }'
  + ' function loadStats(){ $.ajax({url:"get_wan_list_wanstats.asp"});'
  + ' $.ajax({url:"setwanthing.cgi"}); }'    // must be skipped: name says "set"
  + '</script></body></html>';

/* The live page: WanStats carries the real totals as positional values, then a
   loop copies them onto the connection list. No field is named with a number
   beside it, which is the case that nearly fooled the first tool. */
const LIVE_PAGE = '<html><body><script>'
  + 'function stWanStats(domain, BytesSent, BytesReceived, PacketsSent, PacketsReceived){'
  + ' this.domain = domain; this.BytesSent = BytesSent; this.BytesReceived = BytesReceived; }'
  + ' var WanStats = new Array( new stWanStats('
  + "'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1',"
  + "'" + SENT + "','" + RECEIVED + "','5123340','9912345') );"
  + ' var X_HW_PPPoEPassword = "' + PPPOE_SECRET + '";'
  + ' for (var i=0;i<WanStats.length;i++){ for (var j=0;j<WanList.length;j++){'
  + ' if (WanStats[i].domain.indexOf(WanList[j].domain) < 0){ continue; }'
  + ' WanList[j].BytesSent = WanStats[i].BytesSent;'
  + ' WanList[j].BytesReceived = WanStats[i].BytesReceived; } }'
  + '</script></body></html>';

function startFakeHuawei(pages) {
  let issuedToken = null, sessionId = null;
  const fetched = [];

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    fetched.push(url);
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
        sessionId = 'FAKESESSION2';
        res.writeHead(302, { 'Set-Cookie': 'SessionID=' + sessionId + '; path=/', Location: '/' });
        return res.end('');
      });
    }
    if (url === '/logout.cgi') { sessionId = null; res.writeHead(200); return res.end('bye'); }

    if (!signedIn) { res.writeHead(403); return res.end('x'.repeat(602)); }
    if (url === '/html/ssmp/deviceinfo/deviceinfo.asp') {
      res.writeHead(200); return res.end('<html>Model HG8145X7-10</html>');
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
  console.log('\nHuawei counter-read self-test — pretend router, no real box touched\n');

  /* Case A: the live numbers arrive on the page the tool follows to. */
  const fake = await startFakeHuawei({
    '/html/bbsp/common/wan_list_info.asp': TEMPLATE_PAGE,
    '/html/bbsp/common/get_wan_list_wanstats.asp': LIVE_PAGE
  });

  process.env.ROUTER_IP = '127.0.0.1';
  process.env.ROUTER_PORT = String(fake.port);
  process.env.ROUTER_SCHEME = 'http';
  const probe = require(path.join(__dirname, '..', 'tools', 'probe-huawei.js'));
  const stats = require(path.join(__dirname, '..', 'tools', 'probe-huawei-stats.js'));

  console.log('Reading the parts:');
  const tf = stats.byteFields(TEMPLATE_PAGE);
  check('sees the byte fields on a blank template page', () =>
    assert.ok(tf.length >= 2, 'only found ' + tf.length));
  check('does not mistake an empty template field for a real total', () =>
    assert.strictEqual(tf.filter(f => f.isNumber && f.value.length >= 6).length, 0));

  const blocks = stats.statsBlocks(LIVE_PAGE);
  const nums = stats.numbersInBlocks(blocks);
  check('finds the totals even when they are unlabelled list values', () => {
    const found = nums.map(n => n.n);
    assert.ok(found.includes(RECEIVED), 'missed the received total');
    assert.ok(found.includes(SENT), 'missed the sent total');
  });

  const cands = stats.candidatePages(TEMPLATE_PAGE, '/html/bbsp/common/wan_list_info.asp');
  check('spots the page the live numbers come from', () =>
    assert.ok(cands.includes('/html/bbsp/common/get_wan_list_wanstats.asp'),
      'candidates were: ' + cands.join(', ')));
  check('refuses to follow an address whose name changes a setting', () =>
    assert.ok(!cands.some(c => /setwanthing/.test(c)), 'let a "set" address through'));

  console.log('\nScrubbing:');
  check('a PPPoE password is hidden before anything is written down', () =>
    assert.ok(!stats.scrub(LIVE_PAGE).includes(PPPOE_SECRET), 'the secret survived scrubbing'));
  check('scrubbing leaves the byte totals alone', () => {
    const s = stats.scrub(LIVE_PAGE);
    assert.ok(s.includes(RECEIVED) && s.includes(SENT), 'scrubbing destroyed the numbers');
  });
  check('gigabytes are shown beside the raw byte figure', () =>
    assert.ok(/823\.\d\d GB/.test(stats.asGB(RECEIVED)), 'got: ' + stats.asGB(RECEIVED)));

  console.log('\nThe real HG8145X7 shapes, copied from its own report:');

  /* Verbatim from the real box (tools/huawei-counters-report.txt, wan_list_info.asp).
     Note the name: WaninfoStats, NOT stWanStats. An earlier version of the tool
     looked for a name starting "st" and therefore threw away every value on the
     page, then printed a falsely cautious "ALMOST". */
  const REAL_LAYOUT = 'function WaninfoStats(domain, BytesSent, BytesReceived, PacketsSent,'
    + ' PacketsReceived,UnicastSent,UnicastReceived,MulticastSent,MulticastReceived,'
    + 'BroadcastSent,BroadcastReceived,BytesSentHigh,BytesSentLow,BytesReceivedHigh,'
    + 'BytesReceivedLow) { this.domain = domain; this.BytesSent = BytesSent; }';

  /* The first six values are the real ones the box returned. The High/Low halves
     are INVENTED here — see the real reply further down, which does not carry
     them at all. They are kept only to prove the arithmetic works, in case a
     different firmware ever does send them. */
  const REAL_STATS_PAGE = 'var WanEthPPStats = new Array(new WaninfoStats('
    + '"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Stats",'
    + '"858601123","1672972618","2563783","12088542","2563781","11979700",'
    + '"0","0","0","0","9","858601123","121","1672972618"));';

  const layout = stats.statsSignature(REAL_LAYOUT);
  check('reads the record layout off the real WaninfoStats definition', () => {
    assert.ok(layout, 'no layout found at all');
    assert.strictEqual(layout[0], 'domain');
    assert.strictEqual(layout[1], 'BytesSent');
    assert.strictEqual(layout[2], 'BytesReceived');
    assert.strictEqual(layout[13], 'BytesReceivedHigh');
    assert.strictEqual(layout[14], 'BytesReceivedLow');
  });

  check('a constructor named WaninfoStats is no longer skipped', () => {
    const found = stats.numbersInBlocks(stats.statsBlocks(REAL_STATS_PAGE)).map(n => n.n);
    assert.ok(found.includes('1672972618'), 'missed it again; found: ' + found.join(', '));
  });

  const realRecs = stats.statRecords(REAL_STATS_PAGE);
  check('pulls one whole record off the real stats page', () => {
    assert.strictEqual(realRecs.length, 1, 'got ' + realRecs.length + ' records');
    assert.ok(/WANPPPConnection\.1\.Stats$/.test(realRecs[0].domain), realRecs[0].domain);
    assert.strictEqual(realRecs[0].values.length, 14);
  });

  const realLabelled = stats.labelRecord(realRecs[0], layout);
  check('gives the bare numbers their names back', () => {
    const by = n => (realLabelled.find(f => f.name === n) || {}).value;
    assert.strictEqual(by('BytesSent'), '858601123');
    assert.strictEqual(by('BytesReceived'), '1672972618');
    assert.strictEqual(by('PacketsReceived'), '12088542');
  });

  check('can rebuild a 64-bit total IF a box ever sends the halves', () => {
    const t = stats.combine64(realLabelled);
    assert.strictEqual(t.sent, 9 * 4294967296 + 858601123);
    assert.strictEqual(t.received, 121 * 4294967296 + 1672972618);
    assert.ok(/485\.\d\d GB/.test(stats.asGB(t.received)), 'got: ' + stats.asGB(t.received));
  });

  check('a page with no layout to learn from says so instead of guessing', () =>
    assert.strictEqual(stats.statsSignature('<html>nothing useful here</html>'), null));

  /* ---------------------------------------------------------------------- */
  /* What the box ACTUALLY sends. The page above invents the High/Low halves;
     this is the real 231-character reply, copied character for character from
     tools/huawei-counters-report.txt. It carries only TEN values where the
     layout declares fourteen — the four High/Low halves are simply absent. */
  const REAL_REPLY = 'function() { return new Array(new WaninfoStats('
    + '"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Stats",'
    + '"896319260","1689502191","2636353","12140647","2636351","12030504","0","0","2",'
    + '"110143"),null); }';

  const liveRecs = stats.statRecords(REAL_REPLY);
  check('reads the real reply exactly as the box sends it', () => {
    assert.strictEqual(liveRecs.length, 1, 'got ' + liveRecs.length + ' records');
    assert.strictEqual(liveRecs[0].via, 'WaninfoStats', 'via was: ' + liveRecs[0].via);
    assert.strictEqual(liveRecs[0].values.length, 10,
      'the box sent ' + liveRecs[0].values.length + ' values, not 10');
  });

  const liveLabelled = stats.labelRecord(liveRecs[0], layout);
  check('names the ten values the box really sends', () => {
    const by = n => (liveLabelled.find(f => f.name === n) || {}).value;
    assert.strictEqual(by('BytesSent'), '896319260');
    assert.strictEqual(by('BytesReceived'), '1689502191');
    assert.strictEqual(by('BroadcastReceived'), '110143');
  });

  check('does NOT pretend the 32-bit halves arrived when they did not', () => {
    const names = liveLabelled.map(f => f.name);
    ['BytesSentHigh', 'BytesSentLow', 'BytesReceivedHigh', 'BytesReceivedLow']
      .forEach(n => assert.ok(!names.includes(n), 'invented a ' + n));
    assert.deepStrictEqual(stats.combine64(liveLabelled), {},
      'claimed a 64-bit total from halves that were never sent');
  });

  /* A record from a DIFFERENT constructor. The cache page builds these with
     WanPPP(), whose field order has nothing to do with the stats layout, so
     borrowing the byte names would print "PacketsSent = AlwaysOn". */
  const OTHER_RECORD = 'var wan = new WanPPP('
    + '"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1",'
    + '"1","Connected","AlwaysOn","1492","4C:D0:DD:0A:1E:60");';
  const otherRecs = stats.statRecords(OTHER_RECORD);
  check('spots which constructor a record came from', () => {
    assert.strictEqual(otherRecs.length, 1);
    assert.strictEqual(otherRecs[0].via, 'WanPPP');
  });
  check('refuses to put byte names on a record that is not statistics', () => {
    const names = stats.labelRecord(otherRecs[0], null).map(f => f.name);
    assert.ok(!names.some(n => /Bytes|Packets/.test(n)), 'named it ' + names.join(', '));
    assert.ok(names.every(n => /^value \d+$/.test(n)), 'named it ' + names.join(', '));
  });

  console.log('\nEnd to end, against the pretend box:');
  const auth = await probe.login(GOOD_USER, GOOD_PASS);
  check('signs in first', () => assert.strictEqual(auth.ok, true, auth.why));

  const results = await stats.run();
  check('followed the template page through to the live numbers', () =>
    assert.ok(fake.fetched.includes('/html/bbsp/common/get_wan_list_wanstats.asp'),
      'never fetched the page named beside the counters'));
  check('never fetched the settings-changing address it saw', () =>
    assert.ok(!fake.fetched.some(u => /setwanthing/.test(u)), 'fetched a "set" address'));

  const answer = stats.verdict(results);
  check('says YES when real totals are present', () => assert.strictEqual(answer, 'yes'));
  check('quotes the actual totals it found', () => {
    const text = stats.reportLines.join('\n');
    assert.ok(text.includes(RECEIVED), 'the report never states the received total');
  });
  check('the router password is nowhere in the report', () => assert.ok(
    !stats.reportLines.join('\n').includes(GOOD_PASS), 'leaked the router password'));
  check('the PPPoE password is nowhere in the report', () => assert.ok(
    !stats.reportLines.join('\n').includes(PPPOE_SECRET), 'leaked the PPPoE password'));

  await new Promise(r => fake.server.close(r));

  console.log('\nHonesty checks:');
  check('empty fields alone get an honest "almost", not a yes', () => assert.strictEqual(
    stats.verdict([{ page: '/a.asp', fields: [{ name: 'BytesSent', value: '', isNumber: false }],
      numeric: [], blockNums: [], candidates: [] }]), 'almost'));
  check('no counters at all gets a plain "not found"', () => assert.strictEqual(
    stats.verdict([{ page: '/a.asp', fields: [], numeric: [], blockNums: [], candidates: [] }]), 'no'));

  console.log('');
  if (process.exitCode) console.log('SOME CHECKS FAILED (' + passed + ' passed)\n');
  else console.log('ALL CHECKS PASSED (' + passed + ' checks)\n');
})().catch(e => { console.error('\nself-test crashed: ' + (e && e.stack || e)); process.exitCode = 1; });
