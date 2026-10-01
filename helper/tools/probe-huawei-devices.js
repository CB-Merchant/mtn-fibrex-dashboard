'use strict';

/* ============================================================================
   Huawei ONT — read the list of CONNECTED DEVICES  (LOOK-ONLY)
   ----------------------------------------------------------------------------
   Why this exists:
     The dashboard's "Connected devices" panel is stuck on Sample data, because
     nobody has taught the helper how to ask this box who is connected. A
     working open-source client for the Huawei EG8145V5 (chickenzord/
     go-huawei-client) — the same web-UI family as your HG8145X7 — reads its
     device list from ONE page:  /html/bbsp/common/GetLanUserDevInfo.asp
     and each row carries a hostname, IP, MAC and online/offline status.

     That page sits in the very same /html/bbsp/common/ folder where we already
     proved your box serves its data-usage numbers, so there is a strong chance
     it answers here too. The only way to know for sure is to log in and ask —
     which is what this does.

   Same promises as the other Huawei tools:
     - It only READS (plain GET, or an empty POST for the get_*.asp pages that
       need it) and refuses any address whose name looks like it CHANGES a
       setting.
     - Your password is typed into this window only. It is never saved.
     - The report it writes is SCRUBBED: Wi-Fi keys, passwords and session
       tokens are replaced with ***hidden*** before anything is written down.
       Device names, IPs and MACs are kept, so glance through before sharing.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const probe = require(path.join(__dirname, 'probe-huawei.js'));

const REPORT = path.join(__dirname, 'huawei-devices-report.txt');

/* The order a device record's values arrive in, taken from the working
   EG8145V5 client's own struct. Used only as a FALLBACK: if the box ships its
   own layout function we learn the order from THAT instead — guessing a
   vendor's exact spelling has burned this project four times already. */
const KNOWN_LAYOUT = ['Domain', 'IpAddr', 'MacAddr', 'Port', 'PortID', 'DevStatus',
  'IpType', 'Time', 'HostName', 'IPv4Enabled', 'IPv6Enabled', 'DeviceType',
  'UserDevAlias', 'UserSpecifiedDeviceType', 'LeaseTimeRemaining'];

/* Pages that may carry the connected-device list. GetLanUserDevInfo.asp is the
   one the EG8145V5 client actually uses; the rest are the usual Huawei ONT
   spots — cheap to try, harmless if absent. The crawl also follows any .asp
   named beside a device word on a page we can read. */
const DEVICE_PAGES = [
  '/html/bbsp/common/GetLanUserDevInfo.asp',
  '/html/bbsp/common/GetLanUserDevInfos.asp',
  '/html/bbsp/common/lanUserDevInfo.asp',
  '/html/ssmp/userdevinfo/userdevinfo.asp',
  '/html/ssmp/lanuser/lanuser.asp',
  '/html/amp/userdevinfo/userdevinfo.asp',
  '/html/amp/lanmgnt/lanUserDevInfo.asp'
];

/* Never fetch an address that looks like it CHANGES something. */
const DANGEROUS = /(set|del|add|reset|reboot|restore|save|upgrade|update|backup|factory|logout|restart|commit)/i;

/* The two shapes that mark a value as belonging to a real device. */
const MAC_RE = /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

const lines = [];
function say(s) { console.log(s); lines.push(s); }
function quiet(s) { lines.push(s); }

/* -------------------------------------------------------------- scrubbing */

/* Same rules as the counter probe: blank anything password/key/token-like and
   any long hex code before it is written down. Device names, IPs and MACs are
   ordinary text/numbers, so they survive untouched. */
function scrub(text) {
  return String(text)
    .replace(
      /((?:pass|pwd|psk|passwd|password|secret|token|authkey|privkey|privatekey|sharedkey|wpakey)[\w$]*\s*[=:]\s*)(["'])([^"']+)\2/gi,
      (m, head, q) => head + q + '***hidden***' + q)
    .replace(/\b[0-9a-f]{32,}\b/gi, '***hidden-long-code***');
}

/* ---------------------------------------------------------------- parsing */

/* Huawei firmware writes the interesting values with JavaScript hex escapes:
   a MAC arrives as "da\x3a96\x3a65\x3a9d\x3a10\x3ab1" (\x3a is ":") and an IP
   as "192\x2e168\x2e100\x2e5" (\x2e is "."). Left as-is, no MAC or IP pattern
   ever matches and every row reads as empty — which is exactly why the real
   box first came back "0 devices". Turn those escapes back into the real
   characters before anything else looks at the page. */
function decodeEscapes(text) {
  return String(text)
    .replace(/\\x([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

/* Learn the record layout off a "function Foo(Domain, IpAddr, MacAddr, ...)"
   definition, IF the box ships one. Recognised by the tell-tale presence of a
   MAC field plus an address or host field among the parameters — so we never
   mistake some unrelated function for the device layout. */
function deviceSignature(html) {
  const re = /function\s+[A-Za-z_$][\w$]*\s*\(([^)]{0,700})\)/g;
  let m;
  while ((m = re.exec(html))) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const lower = names.map(n => n.toLowerCase());
    const hasMac = lower.some(n => /mac/.test(n));
    const hasIp = lower.some(n => /ipaddr|ip_addr|^ip$|ipadd/.test(n));
    const hasHost = lower.some(n => /host/.test(n));
    if (names.length >= 4 && hasMac && (hasIp || hasHost)) return names;
  }
  return null;
}

/* Pull device rows out of the page. A device row is a constructor call (or a
   bare parenthesised list) whose arguments CONTAIN A MAC ADDRESS — the surest
   sign a row is about a real attached device, whatever the constructor is
   named. Real Huawei rows MIX quoted text ("Ade-PC") with bare numbers (1,
   86400, a UTC timestamp), so we do NOT insist every value be quoted — we grab
   the whole argument list up to its ')' and split it ourselves, honouring
   quotes. (An earlier version required every field quoted and so read ZERO rows
   off the real box, whose rows carry bare booleans and lease seconds.) */
function splitArgs(raw) {
  const values = [];
  let cur = '', q = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) { if (c === q) q = null; else cur += c; }
    else if (c === '"' || c === "'") q = c;      // quote opens/closes; not kept
    else if (c === ',') { values.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  values.push(cur.trim());
  return values;
}

function deviceRecords(html) {
  const out = [];
  // A call with NO nested parens in its argument list — device values never
  // contain parens, so [^()]* stops cleanly at the row's own closing bracket
  // and steps over an outer new Array( ... ) wrapper.
  const re = /(?:new\s+)?([A-Za-z_$][\w$]*)?\s*\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 400) {
    const raw = m[2];
    if (!MAC_RE.test(raw)) continue;               // no MAC -> not a device
    const values = splitArgs(raw);
    if (values.length < 4) continue;               // too few fields to be a row
    out.push({ via: m[1] || '', values });
  }
  return out;
}


/* Give each value its name. Prefer a layout learned off the box; fall back to
   the known EG8145V5 order. Anything past the end is numbered, not named. */
function labelDevice(record, signature) {
  const layout = signature || KNOWN_LAYOUT;
  return record.values.map((v, i) => ({
    name: layout[i] || ('value ' + (i + 1)),
    value: v
  }));
}

/* A value that could be a hostname: has a letter, is not the TR-069 domain
   path, not an IP, not a MAC, not a bare number or an obvious flag word. */
function guessHost(values) {
  return values.find(v =>
    v && /[A-Za-z]/.test(v) && v.length <= 40
    && !/InternetGatewayDevice/i.test(v)
    && !MAC_RE.test(v) && !IP_RE.test(v)
    && !/^\d+$/.test(v)
    && !/^(ipv4|ipv6|lan\d*|ssid\d*|online|offline|true|false|enable|disable)$/i.test(v)
  ) || null;
}

/* Boil one raw record down to the four things a human cares about. The
   hostname/IP/MAC/status are read BY SHAPE (a MAC looks like a MAC wherever it
   sits), not purely by trusting the layout — so a slightly different field
   order on a real box still yields a sensible answer. */
function readable(record, signature) {
  const labelled = labelDevice(record, signature);
  const byName = n => {
    const f = labelled.find(x => String(x.name).toLowerCase() === n.toLowerCase());
    return f ? f.value : null;
  };
  const macRaw = record.values.find(v => MAC_RE.test(v));
  const mac = macRaw ? macRaw.match(MAC_RE)[0] : null;
  let ip = byName('IpAddr');
  if (!ip || !IP_RE.test(ip)) {
    ip = record.values
      .filter(v => IP_RE.test(v) && !/InternetGatewayDevice/i.test(v))
      .map(v => v.match(IP_RE)[0])[0] || null;
  }
  const statusVal = record.values.find(v => /^(online|offline|connected|disconnected|up|down)$/i.test(v))
    || byName('DevStatus');
  const online = statusVal ? /online|connected|up/i.test(statusVal) : null;
  const host = byName('HostName') || guessHost(record.values);
  return { host: host || null, ip, mac, statusText: statusVal || null, online, labelled };
}

/* Any .asp/.cgi page named right beside a device word — a likely data source
   to follow, the same trick that found the counter pages. */
function candidatePages(html, fromPath) {
  const found = new Set();
  const re = /(userdev|user_dev|lanuser|lan_user|hostinfo|host_info|devinfo|dev_info|attachdev|dhcphost|dhcp_host|dhcpclient|dhcp_client)/gi;
  let m;
  while ((m = re.exec(html))) {
    const win = html.slice(Math.max(0, m.index - 700), m.index + 700);
    let a;
    const asp = /["']([\w./-]+\.(?:asp|cgi))["']/g;
    while ((a = asp.exec(win))) {
      let p = a[1];
      if (p[0] !== '/') p = fromPath.replace(/[^/]*$/, '') + p.replace(/^\.\//, '');
      if (!DANGEROUS.test(p)) found.add(p);
    }
  }
  return [...found];
}

/* ------------------------------------------------------------------ reading */

/* Learned once from the first page that defines it, then reused. */
let learnedLayout = null;

/* Read one page. Try GET first; if that comes back empty or 404, try an EMPTY
   POST — the get_*.asp pages on this firmware answer to POST, which is how the
   EG8145V5 client fetches them. Still look-only: an empty POST sends nothing
   and the DANGEROUS filter has already cleared the address. */
async function readPage(p) {
  let res = await probe.request('GET', p);
  let method = 'GET';
  if (res.status !== 200 || !res.body) {
    const alt = await probe.request('POST', p, '');
    if (alt.status === 200 && alt.body) { res = alt; method = 'POST'; }
  }
  if (res.status !== 200 || !res.body) {
    quiet('  ' + String(res.status || res.error).padEnd(5) + p);
    return null;
  }
  let html = decodeEscapes(res.body);

  /* The page answered but carried no device row. On some firmware the list is
     only filled in on POST, even though GET returns the surrounding page — so
     try an empty POST too (still look-only) and prefer it if IT has rows. */
  if (method === 'GET' && !deviceRecords(html).length) {
    const alt = await probe.request('POST', p, '');
    if (alt.status === 200 && alt.body && deviceRecords(decodeEscapes(alt.body)).length) {
      html = decodeEscapes(alt.body); method = 'POST';
    }
  }

  if (!learnedLayout) {
    learnedLayout = deviceSignature(html);
    if (learnedLayout) say('  layout learned from ' + p + ': ' + learnedLayout.join(', '));
  }

  const recs = deviceRecords(html);
  const seen = new Set();
  const devices = [];
  recs.map(r => readable(r, learnedLayout)).forEach(d => {
    const key = (d.mac ? d.mac.toLowerCase() : (d.host || JSON.stringify(d.labelled.map(x => x.value))));
    if (seen.has(key)) return;
    seen.add(key);
    devices.push(d);
  });

  say('  read  ' + method + ' ' + p + '  (' + html.length + ' characters)   device rows: ' + devices.length);
  quiet('');
  quiet('  ---- ' + method + ' ' + p + ' ----');

  /* The device page is short enough to keep whole; write it all down
     (scrubbed) so no pattern of mine can quietly hide part of the answer —
     and so a page that yielded no rows can still be read back and diagnosed. */
  if (html.length <= 40000) {
    quiet('  Whole page, exactly as it came back:');
    quiet('    ' + scrub(html.replace(/\s+/g, ' ').trim()));
  }
  if (devices.length) {
    quiet('  Devices read from this page:');
    devices.forEach((d, i) => quiet('    [' + (i + 1) + '] '
      + (d.host || '(no name)') + '   ' + (d.ip || '(no IP)') + '   '
      + (d.mac || '(no MAC)') + '   '
      + (d.online === null ? '(status?)' : (d.online ? 'online' : 'offline'))));
    quiet('  Full fields, layout applied:');
    devices.forEach((d, i) => {
      quiet('    device ' + (i + 1) + ':');
      d.labelled.forEach(f => quiet('      ' + f.name + ' = '
        + (f.value === '' ? '(empty)' : scrub(String(f.value)).slice(0, 80))));
    });
  }

  return { page: p, method, devices, candidates: candidatePages(html, p) };
}

/* ------------------------------------------------------------------ verdict */

function verdict(results) {
  const withDevices = results.filter(r => r.devices && r.devices.length);

  say('');
  say('=========================================================');
  say('  THE ANSWER');
  say('=========================================================');

  if (withDevices.length) {
    const all = [];
    const seen = new Set();
    withDevices.forEach(r => r.devices.forEach(d => {
      const key = (d.mac ? d.mac.toLowerCase() : d.host);
      if (seen.has(key)) return;
      seen.add(key);
      all.push(d);
    }));
    say('YES. Your box lists the devices connected to it.');
    say('');
    say('Found ' + all.length + ' device' + (all.length === 1 ? '' : 's') + ':');
    say('');
    all.forEach((d, i) => say('  ' + (i + 1) + '. ' + (d.host || '(unnamed)')
      + '  —  ' + (d.ip || 'no IP') + '  —  ' + (d.mac || 'no MAC')
      + '  —  ' + (d.online === null ? 'status unknown' : (d.online ? 'online' : 'offline'))));
    say('');
    say('That is enough to make the Connected-devices panel Live (names +');
    say('online/offline). NOTE: these rows carry no per-device data figure, so');
    say('"how much each device used" still cannot come from this box.');
    say('');
    say('The page that answered: ' + withDevices.map(r => r.method + ' ' + r.page).join(', '));
    return 'yes';
  }

  const read = results.filter(r => r.method);
  if (read.length) {
    say('NO DEVICE LIST SEEN. We reached ' + read.length + ' page(s) but none');
    say('carried a device row (a line with a MAC address in it). Either nothing');
    say('was connected at that moment, or the list is fetched from a page we');
    say('have not found yet.');
    const cands = [...new Set(results.reduce((a, r) => a.concat(r.candidates || []), []))];
    if (cands.length) {
      say('');
      say('Pages named beside device words — worth trying next:');
      cands.slice(0, 15).forEach(c => say('  ' + c));
    }
    return 'none';
  }

  say('NOT FOUND. None of the device pages answered at all. The saved report');
  say('lists exactly what was tried.');
  return 'no';
}

/* --------------------------------------------------------------------- run */

async function run() {
  const tried = new Set();
  const results = [];

  for (const p of DEVICE_PAGES) {
    if (tried.has(p) || DANGEROUS.test(p)) continue;
    tried.add(p);
    const r = await readPage(p);
    if (r) results.push(r);
  }

  /* Follow anything named beside a device word that we have not tried. */
  const extra = [...new Set(results.reduce((a, r) => a.concat(r.candidates), []))]
    .filter(p => !tried.has(p) && !DANGEROUS.test(p))
    .slice(0, 15);
  if (extra.length) {
    say('');
    say('Following ' + extra.length + ' page(s) named beside device words ...');
    for (const p of extra) {
      tried.add(p);
      const r = await readPage(p);
      if (r) results.push(r);
    }
  }

  return results;
}

/* --------------------------------------------------------------------- main */

async function main() {
  say('');
  say('=========================================================');
  say('  Huawei FibreX box — who is connected to it?');
  say('=========================================================');
  say('');
  console.log('This checks whether your box will tell us the list of connected');
  console.log('devices (names, IPs, online/offline), so the dashboard\'s');
  console.log('"Connected devices" panel can show real data instead of samples.');
  console.log('');
  console.log('Same as the other checks: it only LOOKS, your password is never');
  console.log('saved, and the report is scrubbed of Wi-Fi keys and passwords');
  console.log('before saving.');
  console.log('');
  console.log('Reminder: 3 wrong tries locks logins for about a minute, and this');
  console.log('may sign your browser out of the router page. Both harmless.');
  console.log('');

  const username = await probe.ask('Router username [press Enter for "root"]: ', 'root');
  const password = await probe.askSecret('Router password (shows as ****): ');
  if (!password) { console.log('\nNo password typed — nothing done. Closing.'); return; }

  say('Signing in as "' + username + '" ...');
  const auth = await probe.login(username, password);
  if (!auth.ok) {
    say('');
    say('COULD NOT SIGN IN. ' + auth.why);
    console.log('');
    console.log('That was ONE attempt. If you have missed twice already, wait a');
    console.log('minute before trying again. Easiest check: open');
    console.log('https://192.168.100.1 in your browser and see what works there.');
    fs.writeFileSync(REPORT, scrub(lines.join('\n')) + '\n', 'utf8');
    return;
  }
  say('Signed in. Looking for the connected-device list (this only reads) ...');
  say('');

  verdict(await run());

  await probe.request('GET', '/logout.cgi?RequestFile=html/logout.html');
  say('');
  say('Signed out of the router again.');

  fs.writeFileSync(REPORT, scrub(lines.join('\n')) + '\n', 'utf8');
  console.log('');
  console.log('Full detail saved next to this tool:');
  console.log('  ' + REPORT);
  console.log('');
  console.log('Wi-Fi keys and passwords were replaced with ***hidden*** before');
  console.log('saving. It DOES list device names, IPs and MAC addresses, so');
  console.log('glance through it before sharing.');
  console.log('');
}

if (require.main === module) {
  main().catch(e => {
    console.log('');
    console.log('The tool hit an unexpected problem: ' + (e && e.message ? e.message : e));
    console.log('Nothing was changed on your router.');
  });
}

/* Exported so the self-test can drive this against a pretend Huawei. */
module.exports = {
  run, verdict, deviceSignature, deviceRecords, labelDevice, readable,
  guessHost, candidatePages, scrub, decodeEscapes, KNOWN_LAYOUT, reportLines: lines
};





