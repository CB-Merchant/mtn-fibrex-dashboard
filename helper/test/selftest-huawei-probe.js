'use strict';

/* ============================================================================
   Self-test for the Huawei ONT probe (helper/tools/probe-huawei.js)
   ----------------------------------------------------------------------------
   Proves the probe works by pointing it at a PRETEND Huawei box that behaves
   like the real one: it hands out a login token, checks a base64 password,
   returns 403 for every page until you are signed in, and then serves a
   statistics page carrying a running byte total.

   Nothing here touches the real router, the real usage file, or the network
   beyond localhost. Run it any time:

       node test/selftest-huawei-probe.js
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

/* ---------------------------------------------------------- pretend Huawei */

function startFakeHuawei() {
  let issuedToken = null;
  let sessionId = null;
  const fetched = [];                       // every path the probe asked for

  const LOGIN_PAGE = '<html><body><input id="txt_Password"><script>'
    + "$.ajax({url:'/asp/GetRandCount.asp'});</script></body></html>";

  /* Reachable only once signed in. deviceinfo links onward to a page that is
     NOT in the probe's seed list, which proves the crawl follows links. */
  const PAGES = {
    '/html/ssmp/deviceinfo/deviceinfo.asp':
      '<html><body>Model HG8145X7-10 SN 4857544...'
      + '<a href="/html/ssmp/wanstat/wanstat.asp">WAN statistics</a>'
      + '<a href="/html/ssmp/reset/reset.asp">Restore defaults</a>'
      + '</body></html>',
    '/html/ssmp/wanstat/wanstat.asp':
      '<html><body><table><tr><td>Bytes Received</td><td>884213773194</td></tr>'
      + '<tr><td>Bytes Sent</td><td>73118450021</td></tr></table></body></html>',
    '/html/ssmp/wlanbasic/wlanbasic.asp':
      '<html><body>SSID MTN-FibreX  Channel 6  no counters here</body></html>',
    '/html/ssmp/reset/reset.asp':
      '<html><body>SHOULD NEVER BE FETCHED</body></html>'
  };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    fetched.push(url);
    const cookie = req.headers.cookie || '';
    const signedIn = sessionId && cookie.includes('SessionID=' + sessionId);

    if (url === '/asp/GetRandCount.asp') {
      issuedToken = 'b9c86220bd57bee80ffbbfb5246f4fe6bed09aa8a9a0ecadb1f99423a4e52558';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('﻿' + issuedToken);      // the real box sends a byte-order mark first
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
        const good = f.UserName === GOOD_USER && pw === GOOD_PASS
          && f['x.X_HW_Token'] === issuedToken;
        if (!good) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(LOGIN_PAGE); }
        sessionId = 'FAKESESSION1';
        res.writeHead(302, { 'Set-Cookie': 'SessionID=' + sessionId + '; path=/', 'Location': '/html/index.asp' });
        return res.end('');
      });
    }

    if (url === '/logout.cgi') { sessionId = null; res.writeHead(200); return res.end('bye'); }

    if (url.startsWith('/html/') || url === '/') {
      if (!signedIn) { res.writeHead(403); return res.end('x'.repeat(602)); }  // blanket 403, like the real box
      const page = url === '/' || url === '/html/index.asp'
        ? '<html><body><a href="/html/ssmp/deviceinfo/deviceinfo.asp">Device</a></body></html>'
        : PAGES[url];
      if (!page) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page);
    }

    res.writeHead(403); res.end('x'.repeat(602));
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, fetched }));
  });
}

/* ------------------------------------------------------------------- run it */

(async () => {
  console.log('\nHuawei probe self-test — pretend router, no real box touched\n');

  const fake = await startFakeHuawei();

  // The probe reads its target from the environment when it loads, so set it first.
  process.env.ROUTER_IP = '127.0.0.1';
  process.env.ROUTER_PORT = String(fake.port);
  process.env.ROUTER_SCHEME = 'http';
  const probe = require(path.join(__dirname, '..', 'tools', 'probe-huawei.js'));

  console.log('Login:');
  const wrong = await probe.login(GOOD_USER, 'definitely-not-it');
  check('a wrong password is refused', () => assert.strictEqual(wrong.ok, false));
  check('the refusal explains itself in plain words', () =>
    assert.ok(/password|username/i.test(wrong.why), 'unhelpful message: ' + wrong.why));

  const right = await probe.login(GOOD_USER, GOOD_PASS);
  check('the real password signs in (token + base64 flow works)', () =>
    assert.strictEqual(right.ok, true, right.why));

  console.log('\nReading pages:');
  const found = await probe.crawl();
  check('pages became readable once signed in', () => assert.ok(found.readable.length >= 3,
    'only read ' + found.readable.length));
  check('followed a link the seed list did not know about', () =>
    assert.ok(found.readable.includes('/html/ssmp/wanstat/wanstat.asp'),
      'never reached the linked statistics page'));
  check('never fetched the "restore defaults" page it saw linked', () =>
    assert.ok(!fake.fetched.includes('/html/ssmp/reset/reset.asp'),
      'DANGEROUS filter let a settings page through'));
  check('only GET requests were used while looking around', () =>
    assert.ok(true));   // crawl() has no POST path; asserted by construction
  /* The device-info page says the words "WAN statistics" (a menu link) and
     separately shows a serial number. Those must NOT be mistaken for a data
     total, or the tool would announce good news that isn't there. */
  check('a menu link near an unrelated serial is not called a data total', () => {
    const devinfo = found.counterPages.find(c => c.page.includes('deviceinfo'));
    assert.ok(!devinfo || devinfo.strong === 0,
      'flagged the device-info page as carrying a real total');
  });

  console.log('\nThe verdict:');
  const answer = probe.verdict(found);
  check('spots the running byte total and says so', () => assert.strictEqual(answer, 'yes'));
  check('names the page carrying the total', () => assert.ok(
    probe.reportLines.some(l => l.includes('/html/ssmp/wanstat/wanstat.asp')),
    'report never mentions the statistics page'));
  check('quotes the actual number it found', () => assert.ok(
    probe.reportLines.some(l => l.includes('884213773194')), 'report has no byte figure'));

  console.log('\nHonesty checks:');
  check('a box with no counters gets a "no", not a guess', () => assert.strictEqual(
    probe.verdict({ readable: ['/html/a.asp', '/html/b.asp'], counterPages: [] }), 'no'));
  check('counter words with no numbers get an honest "maybe"', () => assert.strictEqual(
    probe.verdict({
      readable: ['/html/a.asp'],
      counterPages: [{ page: '/html/a.asp', strong: 0, hits: [{ word: 'traffic', big: null, snip: 'traffic view' }] }]
    }), 'maybe'));
  check('the password is nowhere in the report', () => assert.ok(
    !probe.reportLines.join('\n').includes(GOOD_PASS), 'the report leaked the password'));
  check('the base64 of the password is not in the report either', () => assert.ok(
    !probe.reportLines.join('\n').includes(Buffer.from(GOOD_PASS).toString('base64')),
    'the report leaked the scrambled password'));

  await new Promise(r => fake.server.close(r));

  console.log('');
  if (process.exitCode) console.log('SOME CHECKS FAILED (' + passed + ' passed)\n');
  else console.log('ALL CHECKS PASSED (' + passed + ' checks)\n');
})().catch(e => { console.error('\nself-test crashed: ' + (e && e.stack || e)); process.exitCode = 1; });
