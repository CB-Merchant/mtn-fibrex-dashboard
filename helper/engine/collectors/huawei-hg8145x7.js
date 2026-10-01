'use strict';

/* ============================================================================
   MTN FibreX ONT — Huawei HG8145X7 reader
   ----------------------------------------------------------------------------
   What this does, in plain terms:
     Your Huawei box keeps a running total of every byte it has carried to and
     from the internet — like a car's odometer. This file logs into the box,
     reads that odometer, and hands the two numbers (uploaded, downloaded) to
     the rest of the helper. The helper works out your USAGE by comparing two
     readings: odometer now, minus odometer last time.

   Why the odometer idea matters:
     The box keeps counting whether or not this helper is running. So if the PC
     is switched off for two days, the next reading still contains those two
     days — nothing is lost. Splitting that catch-up across the right days is
     done by engine/domain/counter-accounting.js, not here.

   How the numbers are found (this was worked out by probing the real box on
   2026-09-16; see CLAUDE.md "Step 2b" for the full story):
     1. /html/bbsp/common/wan_list_info.asp declares the record layout once:
          function WaninfoStats(domain, BytesSent, BytesReceived, ...)
     2. /html/bbsp/common/get_wan_list_pppwanstat.asp returns the live values
        as a bare, UNNAMED list: "896319260","1689502191","2636353",...
     3. Zip the two together by position and the numbers get their names back.
   Neither page is linked from a menu; both were found by reading the router's
   own code. Guessing Huawei page names does not work.

   Two honest limits, both handled downstream:
     - The box declares 14 fields but only sends 10. The "BytesSentHigh/Low"
       halves that would give a true 64-bit total are NOT on the wire, so there
       is one plain number per direction and nothing to add to it.
     - That plain number may therefore roll over at about 4 GB (TR-098 types it
       as a 32-bit value). We have not yet caught it doing so. The accounting
       layer is told to expect it via capabilities.counterWrapBytes and copes.
   ========================================================================== */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 12000;

/* The box serves HTTPS on port 80 with its own self-signed certificate. */
const DEFAULT_PORT = 80;

const LAYOUT_PAGE = '/html/bbsp/common/wan_list_info.asp';
const PPP_STATS_PAGE = '/html/bbsp/common/get_wan_list_pppwanstat.asp';
const IP_STATS_PAGE = '/html/bbsp/common/get_wan_list_ipwanstat.asp';
const CACHE_PAGE = '/html/bbsp/common/wan_list_cache_wan.asp';
/* The connected-device list. Confirmed live on the real HG8145X7 (2026-09-23):
   a 7008-char page answered on GET, listing each attached device by name, IP,
   MAC and Online/Offline. There is NO per-device byte figure on this box, so we
   can only ever report who is connected — never how much each one used. */
const DEVICE_PAGE = '/html/bbsp/common/GetLanUserDevInfo.asp';
const LOCKED_PAGE = '/html/ssmp/deviceinfo/deviceinfo.asp';
const TOKEN_PAGE = '/asp/GetRandCount.asp';
const LOGIN_PAGE = '/login.cgi';

/* The two shapes that mark a value as belonging to a real attached device. */
const MAC_RE = /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

/* The layout as the real HG8145X7 (V5R024C00S106) states it. Only used if the
   box's own declaration cannot be read this time — reading it live is always
   preferred, because a firmware update could reorder the fields. */
const FALLBACK_LAYOUT = [
  'domain',
  'BytesSent', 'BytesReceived', 'PacketsSent', 'PacketsReceived',
  'UnicastSent', 'UnicastReceived', 'MulticastSent', 'MulticastReceived',
  'BroadcastSent', 'BroadcastReceived',
  'BytesSentHigh', 'BytesSentLow', 'BytesReceivedHigh', 'BytesReceivedLow'
];

const HUAWEI_SOURCE = {
  id: 'huawei-hg8145x7',
  label: 'MTN FibreX • Huawei HG8145X7',
  kind: 'router-counter',
  model: 'Huawei HG8145X7',
  capabilities: {
    historical: false,
    liveSnapshot: true,
    cumulativeCounters: true,
    resetDetection: true,
    dailyRecords: true,
    counterScope: 'wan',
    accessCounters: false,
    /* The box will name who is connected (device name + IP + MAC + online), but
       carries NO per-device byte figure — so the devices panel can go Live for
       names/online only, never for per-device usage. */
    deviceList: true,
    /* Whole-WAN totals, so Wi-Fi traffic is included (unlike the per-LAN-port
       counters found on the related HG8145X6). */
    wholeWanCounters: true,
    /* The box sends one plain 32-bit-typed field per direction and none of the
       High/Low halves, so the total can roll over at 2^32 bytes. Declaring the
       roll-over point lets the accounting layer repair a single wrap instead of
       throwing the reading away.

       CONFIRMED on the real box (2026-09-20) from the user's own history: over
       weeks of readings no value ever reached 2^32 (the highest ever seen was
       4,228,720,449 — 98.5% of the range) and the counter was then watched
       dropping back to near zero and climbing again. It is a 32-bit field.

       The practical consequence is worth stating plainly: at this line's
       measured speed the field fills in roughly 15 minutes of flat-out use, so
       readings minutes apart are exact, but a gap of hours can hide extra laps
       that nothing on the wire records. counter-accounting.js works that out
       from the gap length and labels such a day a MINIMUM. */
    counterWrapBytes: 4294967296,
    counterWrapConfirmed: true
  }
};

/* ------------------------------------------------------------- address bits */

function splitRouterAddress(routerIp) {
  const raw = String(routerIp || '').trim();
  // If someone types the scheme in full, believe them rather than guessing.
  const stated = /^(https?):\/\//i.exec(raw);
  const bare = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  if (!bare) return null;
  const [host, port] = bare.split(':');
  if (!host) return null;
  return {
    host,
    port: Number(port) || DEFAULT_PORT,
    scheme: stated ? stated[1].toLowerCase() : null
  };
}

/* The real box speaks HTTPS even on port 80; the pretend box in the self-test
   speaks plain HTTP. Rather than making the user choose, we try HTTPS first and
   fall back to HTTP, then remember which one answered. */
const schemeMemory = new Map();
function schemeKey(address) { return `${address.host}:${address.port}`; }

function looksLikePlainHttp(error) {
  const code = (error && (error.code || error.message)) || '';
  return /EPROTO|ERR_SSL|WRONG_VERSION_NUMBER|SSL routines|ECONNRESET|socket hang up/i.test(String(code));
}

/* ------------------------------------------------------------- HTTP plumbing */

function rawRequest({ scheme, host, port, method, path: urlPath, body, headers, timeoutMs }) {
  const transport = scheme === 'http' ? http : https;
  return new Promise((resolve, reject) => {
    const options = {
      host, port, path: urlPath, method,
      headers: { 'User-Agent': 'MTN-FibreX-helper/1.0', ...(headers || {}) }
    };
    // The box presents a certificate it signed itself. On a home network,
    // talking to a fixed private address, refusing it would simply mean never
    // reading the router at all.
    if (transport === https) options.rejectUnauthorized = false;
    if (body != null) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const request = transport.request(options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        // The login token arrives with a byte-order mark; strip it everywhere.
        body: Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '')
      }));
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(new Error(`The Huawei router at ${host} did not answer in time.`));
    });
    if (body != null) request.write(body);
    request.end();
  });
}

function cookieHeader(jar) {
  // The router's own login page plants this one by hand before submitting.
  const parts = ['Cookie=body:Language:english:id=-1'];
  Object.keys(jar).forEach(name => parts.push(`${name}=${jar[name]}`));
  return parts.join('; ');
}

function rememberCookies(response, jar) {
  (response.headers['set-cookie'] || []).forEach(cookie => {
    const pair = cookie.split(';')[0];
    const separator = pair.indexOf('=');
    if (separator > 0) jar[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  });
}

/* --------------------------------------------------------- reading the pages */

/* Learn the field names from the box's own declaration of the record. */
function parseStatsLayout(html) {
  const match = String(html || '')
    .match(/function\s+[A-Za-z_$][\w$]*[Ss]tats?\s*\(\s*domain\s*,([^)]{0,900})\)/);
  if (!match) return null;
  const names = match[1].split(',').map(name => name.trim()).filter(Boolean);
  return names.length >= 4 ? ['domain', ...names] : null;
}

/* Pull every "InternetGatewayDevice...", "v1", "v2", ... record out of a reply,
   remembering WHICH constructor built it. Records built by anything other than
   the statistics constructor have a completely different field order, so the
   caller must not put byte names on them. */
function parseStatRecords(html) {
  const text = String(html || '');
  const records = [];
  ['"', "'"].forEach(quote => {
    const pattern = new RegExp(
      '(?:([A-Za-z_$][\\w$]*)\\s*\\(\\s*)?'
      + quote + '(InternetGatewayDevice[^' + quote + ']*)' + quote
      + '((?:\\s*,\\s*' + quote + '[^' + quote + ']*' + quote + '){3,})',
      'g'
    );
    let match;
    while ((match = pattern.exec(text)) && records.length < 16) {
      const values = [];
      const valuePattern = new RegExp(quote + '([^' + quote + ']*)' + quote, 'g');
      let value;
      while ((value = valuePattern.exec(match[3]))) values.push(value[1]);
      records.push({ via: match[1] || '', domain: match[2], values });
    }
  });
  return records;
}

function asByteCount(value) {
  if (!/^\d+$/.test(String(value || ''))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/* Zip the layout onto one record's values. Stops at whatever actually arrived:
   this box declares 14 fields and sends 10, and inventing the missing four
   would be the difference between reporting and guessing. */
function nameTheValues(record, layout) {
  const named = {};
  record.values.forEach((value, index) => {
    const name = layout && layout[index + 1];
    if (name) named[name] = value;
  });
  return named;
}

/* One connection's totals. Uses the 64-bit halves when a box sends them, and
   the plain field when it does not (which is what the HG8145X7 does). */
function connectionTotals(named) {
  const combine = (high, low) => {
    const hi = asByteCount(named[high]);
    const lo = asByteCount(named[low]);
    return hi === null || lo === null ? null : hi * 4294967296 + lo;
  };
  const sent = combine('BytesSentHigh', 'BytesSentLow') ?? asByteCount(named.BytesSent);
  const received = combine('BytesReceivedHigh', 'BytesReceivedLow') ?? asByteCount(named.BytesReceived);
  if (sent === null || received === null) return null;
  return {
    uploadBytes: sent,
    downloadBytes: received,
    usedHighLowHalves: combine('BytesSentHigh', 'BytesSentLow') !== null
  };
}

/* Turn a stats reply into whole-WAN totals. Several WAN connections can be
   listed (internet, voice, IPTV); their traffic is summed, because the plan's
   allowance is spent by all of them together. */
function readCounters(statsHtml, layout) {
  const connections = [];
  let fieldsReceived = 0;
  parseStatRecords(statsHtml).forEach(record => {
    if (!/stat/i.test(record.via)) return;           // not a statistics record
    const totals = connectionTotals(nameTheValues(record, layout));
    if (!totals) return;
    fieldsReceived = Math.max(fieldsReceived, record.values.length);
    connections.push({ domain: record.domain, ...totals });
  });
  if (connections.length === 0) return null;
  return {
    downloadBytes: connections.reduce((sum, c) => sum + c.downloadBytes, 0),
    uploadBytes: connections.reduce((sum, c) => sum + c.uploadBytes, 0),
    fieldsReceived,
    connections
  };
}

/* The cache page carries the PPPoE connection's state as a plain word. We only
   use it as a hint (it is positional and undocumented), never as the basis for
   a number. */
function readConnectionStatus(html) {
  const text = String(html || '');
  if (!/Wan(PPP|IP)\s*\(/.test(text)) return 'Unknown';
  if (/"Connected"|'Connected'/.test(text)) return 'Connected';
  if (/"Disconnected"|'Disconnected'/.test(text)) return 'Disconnected';
  return 'Unknown';
}

function looksLoggedOut(response) {
  return response.status === 403
    || /txt_Password|GetRandCount|login\.cgi/i.test(response.body || '');
}

/* ============================================ reading the connected devices */

/* Huawei firmware writes a device's MAC and IP with JavaScript hex escapes:
   a MAC arrives as "da\x3a96\x3a65\x3a9d\x3a10\x3ab1" (\x3a is ":") and an IP
   as "192\x2e168\x2e100\x2e5" (\x2e is "."). Left as-is, no MAC or IP pattern
   ever matches and the page reads as empty — which is exactly why the real box
   first came back "0 devices". Turn the escapes back into real characters
   before anything else looks at the page. */
function decodeEscapes(text) {
  return String(text || '')
    .replace(/\\x([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

/* Learn the device-record layout off the box's own "function USERDevice(Domain,
   IpAddr, MacAddr, ...)" declaration when it ships one. Recognised by a MAC
   field plus an address-or-host field among the parameters, so an unrelated
   function is never mistaken for the device layout. The real box's order
   differs from other Huawei models', which is exactly why we read it here
   rather than assume it. */
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

/* Split one row's argument list, honouring quotes. Real rows MIX quoted text
   ("iPhone") with BARE numbers (1, 0, 86400, a UTC timestamp), so we must not
   insist every value be quoted — an earlier all-quoted parser read ZERO rows
   off the real box. */
function splitDeviceArgs(raw) {
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

/* Pull device rows out of the page. A device row is a constructor call whose
   arguments CONTAIN A MAC — the surest sign it describes a real attached
   device, whatever the constructor is named. [^()]* stops cleanly at the row's
   own closing bracket, stepping over the outer "new Array( ... )" wrapper. */
function parseDeviceRecords(html) {
  const out = [];
  const re = /(?:new\s+)?([A-Za-z_$][\w$]*)?\s*\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 400) {
    const raw = m[2];
    if (!MAC_RE.test(raw)) continue;               // no MAC -> not a device
    const values = splitDeviceArgs(raw);
    if (values.length < 4) continue;               // too few fields to be a row
    out.push({ via: m[1] || '', values });
  }
  return out;
}

/* A value that could be a hostname: has a letter, is short, and is not the
   TR-069 domain path, an IP, a MAC, a bare number or an obvious flag word. */
function guessDeviceHost(values) {
  return values.find(v =>
    v && /[A-Za-z]/.test(v) && v.length <= 40
    && !/InternetGatewayDevice/i.test(v)
    && !MAC_RE.test(v) && !IP_RE.test(v)
    && !/^\d+$/.test(v)
    && !/^(ipv4|ipv6|lan\d*|ssid\d*|wifi|dhcp|static|ethernet|online|offline|true|false|enable|disable)$/i.test(v)
  ) || null;
}

/* Boil one raw record down to the four things a human cares about. MAC, IP and
   status are read BY SHAPE (a MAC looks like a MAC wherever it sits), so a
   slightly different field order on a real box still yields a sensible answer;
   the name prefers the learned HostName field, falling back to a name-shaped
   value. The box's "--" placeholder for an empty field is treated as blank. */
function readableDevice(record, signature) {
  const layout = signature || [];
  const byName = n => {
    const i = layout.findIndex(x => String(x).toLowerCase() === n.toLowerCase());
    return i >= 0 ? record.values[i] : null;
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
  const host = byName('HostName') || guessDeviceHost(record.values);
  return {
    name: host && host !== '--' ? host : null,
    ip: ip && ip !== '--' ? ip : null,
    mac,
    online
  };
}

/* Turn a whole device page into a clean, de-duplicated list. The real box lists
   each device up to THREE times: the array is defined twice (an if/else on
   ProductType) and a separate WifiWorkingModes array repeats every MAC in UPPER
   case. Folding the dedup key to lower case collapses all three to one; the
   rich USERDevice rows come first, so the fullest row wins. Best-effort: any
   failure here returns an empty list rather than throwing. */
function readDeviceList(html) {
  try {
    const text = decodeEscapes(html);
    const signature = deviceSignature(text);
    const seen = new Set();
    const devices = [];
    parseDeviceRecords(text).forEach(record => {
      const device = readableDevice(record, signature);
      const key = device.mac ? device.mac.toLowerCase() : device.name;
      if (!key || seen.has(key)) return;
      seen.add(key);
      devices.push(device);
    });
    return devices;
  } catch {
    return [];
  }
}

function looksLikeHuaweiOnt(body) {
  return /HG8145X|HG814\dX|GetRandCount|x\.X_HW_Token|Huawei Technologies/i.test(body || '');
}

/* ================================================================ collector */

function createHuaweiHg8145x7Collector({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  /* One admin session at a time is all the box allows, so we hold on to the
     session we have instead of logging in again every few minutes. Re-logging
     in constantly would also sign the user out of the router's own page over
     and over, and edge closer to the 3-wrong-tries lockout. */
  const sessions = new Map();   // "host:port" -> { jar, at }

  async function send(address, method, urlPath, { body, jar } = {}) {
    const key = schemeKey(address);
    const remembered = address.scheme || schemeMemory.get(key);
    const order = remembered ? [remembered] : ['https', 'http'];
    let lastError = null;

    for (const scheme of order) {
      try {
        const response = await rawRequest({
          scheme,
          host: address.host,
          port: address.port,
          method,
          path: urlPath,
          body,
          headers: jar ? { Cookie: cookieHeader(jar) } : undefined,
          timeoutMs
        });
        schemeMemory.set(key, scheme);
        if (jar) rememberCookies(response, jar);
        return response;
      } catch (error) {
        lastError = error;
        if (remembered || !looksLikePlainHttp(error)) throw error;
        // else: fall through and try plain HTTP
      }
    }
    throw lastError || new Error('The Huawei router could not be reached.');
  }

  /* Exactly what the router's own login page does when CfgMode is 'MTN':
     ask for a one-time token, then post the username, the password wrapped in
     base64, the language and that token. (The SHA-256 path in the firmware is
     for a different operator build and is not used here.) */
  async function logIn(address, password) {
    const jar = {};
    const token = await send(address, 'POST', TOKEN_PAGE, { jar });
    const tokenValue = (token.body || '').trim();
    if (token.status !== 200 || !tokenValue) {
      throw new Error(`The Huawei router at ${address.host} did not hand out a login token.`);
    }

    const form = 'UserName=root'
      + '&PassWord=' + encodeURIComponent(Buffer.from(password, 'utf8').toString('base64'))
      + '&Language=english'
      + '&x.X_HW_Token=' + encodeURIComponent(tokenValue);
    await send(address, 'POST', LOGIN_PAGE, { body: form, jar });

    // The honest test of "am I in?" is simply: can I now read a locked page?
    const check = await send(address, 'GET', LOCKED_PAGE, { jar });
    if (looksLoggedOut(check)) {
      throw new Error(
        'The Huawei router refused that admin password. '
        + 'It locks logins for about a minute after 3 wrong tries.'
      );
    }
    return jar;
  }

  /* Read a page, logging in again once if the session has expired. */
  async function readPage(address, password, urlPath) {
    const key = schemeKey(address);
    /* The kept session is tied to the exact password it was opened with. Without
       this, a second attempt with the WRONG password would quietly ride on the
       first one's session and appear to succeed — so a typo would be stored as
       if it worked. Only a fingerprint is held, never the password itself. */
    const fingerprint = crypto.createHash('sha256').update(String(password)).digest('hex');
    let session = sessions.get(key);
    if (!session || session.fingerprint !== fingerprint) {
      session = { jar: await logIn(address, password), fingerprint, at: Date.now() };
      sessions.set(key, session);
    }

    let response = await send(address, 'GET', urlPath, { jar: session.jar });
    if (looksLoggedOut(response)) {
      sessions.delete(key);
      session = { jar: await logIn(address, password), fingerprint, at: Date.now() };
      sessions.set(key, session);
      response = await send(address, 'GET', urlPath, { jar: session.jar });
    }
    return response;
  }

  return {
    id: HUAWEI_SOURCE.id,
    label: HUAWEI_SOURCE.label,
    kind: HUAWEI_SOURCE.kind,
    model: HUAWEI_SOURCE.model,
    capabilities: HUAWEI_SOURCE.capabilities,

    async probe({ routerIp }) {
      const address = splitRouterAddress(routerIp);
      if (!address) return { matched: false };
      try {
        const response = await send(address, 'GET', '/');
        const matched = looksLikeHuaweiOnt(response.body);
        return { matched, model: matched ? HUAWEI_SOURCE.model : null };
      } catch (error) {
        return { matched: false, error: error.message };
      }
    },

    async collect({ routerIp, password }) {
      const address = splitRouterAddress(routerIp);
      if (!address) throw new Error('A router IP address is required for the Huawei collector.');
      if (!password) throw new Error('A router admin password is required for the Huawei collector.');

      // 1. Learn the field order from the box itself.
      let layout = FALLBACK_LAYOUT;
      let layoutSource = 'built-in fallback';
      try {
        const layoutPage = await readPage(address, password, LAYOUT_PAGE);
        const learned = parseStatsLayout(layoutPage.body);
        if (learned) { layout = learned; layoutSource = LAYOUT_PAGE; }
      } catch (error) {
        if (/password|login|token/i.test(error.message)) throw error;
        // A missing layout page is survivable; the known layout still applies.
      }

      // 2. Read the live totals. This line is PPPoE; the IPoE page is the same
      //    shape and is tried second so a re-provisioned line still works.
      let counters = null;
      let countersPage = null;
      for (const page of [PPP_STATS_PAGE, IP_STATS_PAGE]) {
        const response = await readPage(address, password, page);
        const parsed = readCounters(response.body, layout);
        if (parsed) { counters = parsed; countersPage = page; break; }
      }
      if (!counters) {
        throw new Error(
          `The Huawei router at ${address.host} did not return any WAN data counters. `
          + 'Its statistics page was reachable but empty.'
        );
      }

      // 3. A connection-state hint, best effort only.
      let connectionStatus = 'Unknown';
      try {
        const cache = await readPage(address, password, CACHE_PAGE);
        connectionStatus = readConnectionStatus(cache.body);
      } catch { /* a hint, not a requirement */ }

      // 4. The connected-device list, best effort only. The box names who is
      //    attached (name + IP + MAC + online) but carries NO per-device byte
      //    figure, so this can never say how much each device used. A failure
      //    here must NEVER sink the usage sync — devices are a bonus.
      let devices = null;
      try {
        const devPage = await readPage(address, password, DEVICE_PAGE);
        const list = readDeviceList(devPage.body);
        devices = {
          count: list.filter(d => d.online !== false).length,
          list
        };
      } catch { /* who is connected is a bonus, not a requirement */ }

      const source = { ...HUAWEI_SOURCE, routerIp: address.host };
      const observedAt = new Date().toISOString();
      return {
        source,
        records: [],
        devices,
        snapshots: [{
          sourceId: source.id,
          sourceType: source.kind,
          sourceLabel: source.label,
          model: source.model,
          routerIp: address.host,
          observedAt,
          rxBytes: counters.downloadBytes,
          txBytes: counters.uploadBytes,
          downloadBytes: counters.downloadBytes,
          uploadBytes: counters.uploadBytes,
          totalBytes: counters.downloadBytes + counters.uploadBytes,
          // The box publishes no connection age we have been able to identify,
          // so this stays null rather than being guessed at.
          uptimeSeconds: null,
          connectionStatus,
          counterScope: 'wan',
          counterDetails: {
            scope: 'wan',
            statsPage: countersPage,
            layoutSource,
            fieldsDeclared: layout.length - 1,
            fieldsReceived: counters.fieldsReceived,
            usedHighLowHalves: counters.connections.some(c => c.usedHighLowHalves),
            connections: counters.connections.map(c => ({
              domain: c.domain,
              downloadBytes: c.downloadBytes,
              uploadBytes: c.uploadBytes
            }))
          }
        }],
        counterStatus: 'snapshot'
      };
    },

    /* Used by the self-test so a pretend box can be read twice without the
       first session being reused after it is deliberately expired. */
    _forgetSessions() { sessions.clear(); }
  };
}

module.exports = {
  HUAWEI_SOURCE,
  FALLBACK_LAYOUT,
  createHuaweiHg8145x7Collector,
  connectionTotals,
  looksLikeHuaweiOnt,
  nameTheValues,
  parseStatRecords,
  parseStatsLayout,
  readConnectionStatus,
  readCounters,
  splitRouterAddress,
  decodeEscapes,
  deviceSignature,
  parseDeviceRecords,
  readableDevice,
  readDeviceList
};
