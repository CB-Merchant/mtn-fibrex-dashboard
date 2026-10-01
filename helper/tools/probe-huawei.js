'use strict';

/* ============================================================================
   Huawei ONT probe — a LOOK-ONLY diagnostic
   ----------------------------------------------------------------------------
   What this is:
     A one-off tool that logs into your Huawei FibreX box (the HG8145X7 at
     192.168.100.1), walks its pages, and reports whether the box tells anyone
     HOW MUCH DATA it has carried — a running byte total.

   Why it exists:
     The dashboard's helper already knows how to read two routers (the ZTE
     FibreX gateway and the ZLT 5G box). Your box is a third model, a Huawei,
     and nobody has taught the helper to read it yet. Before writing that
     reader we have to know one thing: does this box publish a data total at
     all? Every page on it is locked behind the admin password, so the only
     way to find out is to log in and look — which is what this does.

   What it does NOT do:
     - It NEVER writes your password anywhere. You type it into this window,
       it goes straight to the router on your own network, and it is gone when
       the window closes.
     - It only READS pages (plain GET requests) and deliberately skips
       anything whose address looks like it changes a setting.
     - It touches none of your dashboard files. It writes ONE report next to
       itself, so you can read (or share) what it found.

   Please read before running:
     - Your router locks logins for a minute after 3 wrong tries. This tool
       makes ONE attempt at a time and tells you where you stand.
     - Huawei boxes allow only ONE admin session at a time, so logging in
       here may sign your browser out of the router page (and vice-versa).
       Harmless — just log back in if you need to.
   ========================================================================== */

const https = require('https');
const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const HOST = process.env.ROUTER_IP || '192.168.100.1';
const PORT = Number(process.env.ROUTER_PORT || 80);   // this box serves HTTPS on port 80
// Your box speaks HTTPS (even on port 80). The override exists only so the
// self-test can point this tool at a pretend router without certificates.
const SCHEME = (process.env.ROUTER_SCHEME || 'https').toLowerCase();
const transport = SCHEME === 'http' ? http : https;
const REPORT = path.join(__dirname, 'huawei-probe-report.txt');
const MAX_PAGES = 70;          // keep the crawl polite and quick
const TIMEOUT_MS = 12000;

/* Words that would appear on a page carrying a real data total. "octet" is the
   networking world's word for "byte", so it counts too. ("byte" already covers
   "bytes", so it is not listed twice.) */
const COUNTER_WORDS = [
  'byte', 'octet', 'statistic', 'traffic', 'throughput',
  'rxbytes', 'txbytes', 'recvbytes', 'sendbytes', 'totalrecv', 'totalsend',
  'received', 'transmitted', 'datausage', 'flow'
];

/* Pages worth trying even if the menu never links to them, gathered from how
   Huawei ONT firmware is usually laid out. The crawl adds whatever it finds. */
const SEEDS = [
  '/', '/html/index.asp', '/html/ssmp/common/frame.asp',
  '/html/ssmp/deviceinfo/deviceinfo.asp', '/html/ssmp/common/statusdeviceinfo.asp',
  '/html/amp/wan/wan.asp', '/html/bbsp/wan/wan.asp', '/html/ssmp/wan/wan.asp',
  '/html/status/status_wan.asp', '/html/status/wandetail.asp', '/html/network/wan.asp',
  '/html/ssmp/statistic/statistic.asp', '/html/ssmp/traffic/traffic.asp',
  '/html/ssmp/ethinfo/ethinfo.asp', '/html/ssmp/opticinfo/opticinfo.asp',
  '/html/ssmp/lanuser/lanuser.asp', '/html/ssmp/userdevinfo/userdevinfo.asp',
  '/html/ssmp/wlanbasic/wlanbasic.asp', '/html/ssmp/lanportinfo/lanportinfo.asp'
];

/* Never fetch an address that looks like it CHANGES something. Reading is safe;
   we are not here to touch settings. */
const DANGEROUS = /(set|del|add|reset|reboot|restore|save|upgrade|update|backup|factory|logout|restart|commit)/i;

const lines = [];
function say(s) { console.log(s); lines.push(s); }
function quiet(s) { lines.push(s); }          // report only, keeps the window readable

/* ---------------------------------------------------------------- HTTP bits */

const cookies = {};
function cookieHeader() {
  const jar = Object.keys(cookies).map(k => k + '=' + cookies[k]);
  // The login page also plants this one by hand before submitting.
  jar.unshift('Cookie=body:Language:english:id=-1');
  return jar.join('; ');
}
function rememberCookies(res) {
  (res.headers['set-cookie'] || []).forEach(c => {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
}

function request(method, urlPath, body) {
  return new Promise(resolve => {
    const opts = {
      host: HOST, port: PORT, path: urlPath, method,
      headers: { 'Cookie': cookieHeader(), 'User-Agent': 'Mozilla/5.0' }
    };
    if (transport === https) opts.rejectUnauthorized = false;  // the box uses its own self-signed certificate
    if (body != null) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = transport.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        rememberCookies(res);
        resolve({
          status: res.statusCode,
          location: res.headers.location || '',
          body: Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
        });
      });
    });
    req.on('error', e => resolve({ status: 0, location: '', body: '', error: e.code || String(e) }));
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve({ status: 0, location: '', body: '', error: 'timeout' }); });
    if (body != null) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------- asking for details */

function ask(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res((a || '').trim() || fallback); }));
}

/* Typed password shows as dots, so nobody reading over your shoulder sees it. */
function askSecret(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    let out = '';
    const onData = chunk => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          if (stdin.setRawMode) stdin.setRawMode(!!wasRaw);
          stdin.pause();
          process.stdout.write('\n');
          return resolve(out);
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1); }  // Ctrl+C
        if (ch === '\u0008' || ch === '\u007f') {              // Backspace / Delete
          if (out) { out = out.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue;
        out += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/* --------------------------------------------------------------- logging in */

/* Exactly what the router's own login page does, copied from its code:
   ask for a one-time token, then post the username, the password wrapped in
   base64, the language, and that token. */
async function login(username, password) {
  const tok = await request('POST', '/asp/GetRandCount.asp');
  if (tok.status !== 200 || !tok.body.trim()) {
    return { ok: false, why: 'The router did not hand out a login token (got ' + (tok.error || tok.status) + ').' };
  }
  const token = tok.body.trim();
  const form = 'UserName=' + encodeURIComponent(username)
    + '&PassWord=' + encodeURIComponent(Buffer.from(password, 'utf8').toString('base64'))
    + '&Language=english'
    + '&x.X_HW_Token=' + encodeURIComponent(token);

  const res = await request('POST', '/login.cgi', form);
  if (res.status === 0) return { ok: false, why: 'Could not reach the router (' + res.error + ').' };

  // The honest test of "am I in?" is simply: can I now read a locked page?
  const check = await request('GET', '/html/ssmp/deviceinfo/deviceinfo.asp');
  const looksLoggedIn = check.status === 200 && !/txt_Password|GetRandCount/i.test(check.body);
  if (looksLoggedIn) return { ok: true };

  const hint = /errcode|failed|invalid|locked/i.test(res.body + res.location)
    ? 'The router refused that username or password.'
    : 'The router answered but still will not show its pages — usually a wrong username or password.';
  return { ok: false, why: hint };
}

/* ----------------------------------------------------------- looking around */

function linksIn(html, fromPath) {
  const found = new Set();
  const add = p => {
    if (!p) return;
    p = p.trim().replace(/^["']|["']$/g, '');
    if (/^(https?:|javascript:|mailto:|#)/i.test(p)) return;
    if (!/\.(asp|html?)($|\?)/i.test(p)) return;
    if (p[0] !== '/') {                                  // make relative links absolute
      const base = fromPath.replace(/[^/]*$/, '');
      p = base + p;
    }
    p = p.split('?')[0].split('#')[0];
    if (DANGEROUS.test(p)) return;
    found.add(p);
  };
  let m;
  const re = /(?:href|src|action)\s*=\s*["']([^"']+)["']/gi;
  while ((m = re.exec(html))) add(m[1]);
  const re2 = /["']([^"']*\.asp)["']/gi;                 // pages named inside the page's own code
  while ((m = re2.exec(html))) add(m[1]);
  return [...found];
}

/* Does this page look like it is reporting a running data total? We want a
   counter word sitting RIGHT NEXT TO a big number — a real byte total on a line
   that has been up for days is a long number. Insisting the two be close
   together matters: otherwise a menu link reading "WAN statistics" pairs up
   with an unrelated serial number further down the page and we cry wolf. */
function scanForCounters(html) {
  const flat = html.replace(/\s+/g, ' ');
  const hits = [];
  COUNTER_WORDS.forEach(w => {
    const re = new RegExp(w, 'gi');
    let m, seen = 0;
    while ((m = re.exec(flat)) && seen < 3) {
      const snip = flat.slice(Math.max(0, m.index - 90), m.index + w.length + 110).trim();
      // A label and its value sit side by side, so only look just around the word.
      const near = flat.slice(Math.max(0, m.index - 25), m.index + w.length + 45);
      const big = near.match(/\d{6,}/);                  // 6+ digits = plausible byte total
      hits.push({ word: w, big: big ? big[0] : null, snip });
      seen++;
    }
  });
  return hits;
}

/* Walk every page we can now read and note which ones mention data totals.
   GET only, and the DANGEROUS filter keeps us clear of anything that could
   change a setting. */
async function crawl() {
  const queue = [...SEEDS];
  const seen = new Set();
  const readable = [];
  const counterPages = [];

  while (queue.length && seen.size < MAX_PAGES) {
    const p = queue.shift();
    if (!p || seen.has(p) || DANGEROUS.test(p)) continue;
    seen.add(p);

    const res = await request('GET', p);
    if (res.status !== 200 || !res.body) { quiet('  ' + String(res.status).padEnd(4) + p); continue; }
    readable.push(p);
    quiet('  200  ' + p + '  (' + res.body.length + ' bytes of page)');

    const hits = scanForCounters(res.body);
    const strong = hits.filter(h => h.big);
    if (hits.length) {
      counterPages.push({ page: p, hits, strong: strong.length });
      say('  * ' + p + ' — ' + hits.length + ' counter-ish mention(s)'
        + (strong.length ? ', ' + strong.length + ' WITH a big number' : ''));
    }
    linksIn(res.body, p).forEach(l => { if (!seen.has(l)) queue.push(l); });
  }
  return { readable, counterPages };
}

/* Turn what we found into a plain-English answer to the only question that
   matters: can this box give the dashboard real usage numbers? */
function verdict({ readable, counterPages }) {
  const withBigNumbers = counterPages.filter(c => c.strong > 0);

  say('');
  say('=========================================================');
  say('  WHAT WE FOUND');
  say('=========================================================');
  say('Pages the router let us read: ' + readable.length);
  say('Pages mentioning bytes/traffic/statistics: ' + counterPages.length);
  say('...of those, pages with an actual big number: ' + withBigNumbers.length);
  say('');

  let answer;
  if (withBigNumbers.length) {
    answer = 'yes';
    say('GOOD NEWS. This box does appear to publish running data totals.');
    say('That is the ingredient the dashboard needs: read the total twice,');
    say('subtract, and you have real daily usage.');
    say('');
    say('The promising pages:');
    withBigNumbers.forEach(c => {
      say('  ' + c.page);
      c.hits.filter(h => h.big).slice(0, 4).forEach(h => {
        say('      "' + h.word + '" near ' + h.big + ' -> ' + h.snip.slice(0, 150));
      });
    });
  } else if (counterPages.length) {
    answer = 'maybe';
    say('MIXED. Pages mention traffic or statistics, but none showed a big');
    say('running total. That often means the numbers arrive separately after');
    say('the page opens, so a reader would need a closer look.');
    say('');
    counterPages.slice(0, 8).forEach(c => {
      say('  ' + c.page);
      c.hits.slice(0, 2).forEach(h => say('      "' + h.word + '" -> ' + h.snip.slice(0, 140)));
    });
  } else {
    answer = 'no';
    say('NOT PROMISING. We read ' + readable.length + ' pages and none of them');
    say('mentioned bytes, traffic or statistics at all. If that holds, this box');
    say('simply does not report how much data it has carried, and the');
    say('dashboard cannot get real usage from it.');
  }

  say('');
  say('Every page we could read:');
  readable.forEach(p => say('  ' + p));
  return answer;
}

/* --------------------------------------------------------------------- main */

async function main() {
  say('');
  say('=========================================================');
  say('  Huawei FibreX box — can it tell us your data usage?');
  say('=========================================================');
  say('');
  say('Router: https://' + HOST + ':' + PORT + '  (your box serves its page here)');
  say('');
  console.log('Two things before we start:');
  console.log('  1. Your router locks logins for about a minute after 3 wrong');
  console.log('     tries. This tool tries ONCE, then tells you what happened.');
  console.log('  2. The box allows one admin session, so this may sign your');
  console.log('     browser out of the router page. Nothing breaks.');
  console.log('');
  console.log('The password is your ROUTER box\'s password — usually printed on');
  console.log('the sticker underneath it. It is NOT your bank or MyMTN password.');
  console.log('It stays on this computer and is never written down anywhere.');
  console.log('');

  const username = await ask('Router username [press Enter for "root"]: ', 'root');
  const password = await askSecret('Router password (shows as ****): ');
  if (!password) { console.log('\nNo password typed — nothing done. Closing.'); return; }

  say('Signing in as "' + username + '" ...');
  const auth = await login(username, password);
  if (!auth.ok) {
    say('');
    say('COULD NOT SIGN IN. ' + auth.why);
    say('');
    console.log('What to try:');
    console.log('  - The username is often "root", sometimes "admin" or');
    console.log('    "telecomadmin". Check the sticker on the box.');
    console.log('  - That was ONE attempt. The router allows 3 before it locks');
    console.log('    for a minute, so you can run this again — but wait a minute');
    console.log('    if you have already missed twice.');
    console.log('  - Easiest check: open https://' + HOST + ' in your browser and');
    console.log('    see which username/password actually works there first.');
    fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
    return;
  }
  say('Signed in. Reading pages (this only looks, it changes nothing) ...');
  say('');

  verdict(await crawl());

  // Be a good guest: hand the single admin session back.
  await request('GET', '/logout.cgi?RequestFile=html/logout.html');
  say('');
  say('Signed out of the router again.');

  fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
  console.log('');
  console.log('Full report saved next to this tool:');
  console.log('  ' + REPORT);
  console.log('');
  console.log('It lists page addresses and any numbers found (it may include');
  console.log('things like your box\'s serial or WAN address, so glance through');
  console.log('it before sharing). Your password is NOT in it.');
  console.log('');
}

if (require.main === module) {
  main().catch(e => {
    console.log('');
    console.log('The tool hit an unexpected problem: ' + (e && e.message ? e.message : e));
    console.log('Nothing was changed on your router.');
  });
}

/* Exported so the self-test can drive the same code against a pretend Huawei,
   with no prompts and no real router involved. The deep-read follow-up tool
   (probe-huawei-stats.js) reuses the login and the prompts from here. */
module.exports = { request, login, crawl, verdict, scanForCounters, linksIn, ask, askSecret, reportLines: lines };
