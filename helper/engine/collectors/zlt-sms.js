'use strict';

const crypto = require('crypto');
const { parseMtnUsageSms } = require('./sms');
const { cleanRouterIp } = require('./zte-f6600p');

const DEFAULT_TIMEOUT_MS = 10000;

function createTimeoutFetch(fetchImpl, timeoutMs) {
  return (url, options = {}, customTimeout = timeoutMs) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), customTimeout);
    return fetchImpl(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timeout));
  };
}

function sourceFor(routerIp, model = null) {
  const normalizedModel = /X28/i.test(model || '')
    ? 'MTN 5G ODU • ZLT X28'
    : /X17U|ODU/i.test(model || '') || routerIp === '192.168.0.1'
      ? 'MTN 5G ODU • ZLT X17U'
      : (model || 'MTN Broadband Gateway');

  return {
    id: 'zlt-sms',
    label: normalizedModel,
    kind: 'router-sms',
    model: model || normalizedModel,
    routerIp,
    capabilities: {
      historical: true,
      dailyRecords: true,
      cumulativeCounters: false
    }
  };
}

function createZltSmsCollector({ fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required for the ZLT collector.');
  const fetchWithTimeout = createTimeoutFetch(fetchImpl, timeoutMs);

  async function request(cleanIp, body) {
    return fetchWithTimeout(`http://${cleanIp}/cgi-bin/http.cgi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  /* ==========================================================================
     Adapted for this dashboard (still the WiFiWatch engine, MIT © Sagenoya):
     read the router's LIVE signal + current throughput and the connected-device
     list. Rule: any value the router does not actually return is left as `null`
     so the dashboard keeps that number labelled "Sample" — we never invent a
     figure and show it as "Live".
     ========================================================================== */
  const toNum = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  async function getCmdJson(cleanIp, cmd, sessionId, token, timeout = 6000) {
    const res = await fetchWithTimeout(`http://${cleanIp}/cgi-bin/http.cgi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, method: 'GET', sessionId, token })
    }, timeout);
    const txt = await res.text();
    if (!txt || txt.trim().startsWith('<')) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  // Current 5G signal + instantaneous throughput. Returns null if the router
  // exposed nothing usable (so the panel stays Sample instead of showing fakes).
  async function readDiagnostics(cleanIp, sessionId, token) {
    let n = null, s = null, t = null;
    try { n = await getCmdJson(cleanIp, 113, sessionId, token); } catch (e) {}
    try { s = await getCmdJson(cleanIp, 205, sessionId, token); } catch (e) {}
    try { t = await getCmdJson(cleanIp, 133, sessionId, token); } catch (e) {}
    n = n || {}; s = s || {}; t = t || {};

    // netWanRxRate/netWanTxRate are bytes/sec on this firmware family → Mbps.
    const rxRate = toNum(t.netWanRxRate);
    const txRate = toNum(t.netWanTxRate);
    const rxMbps = rxRate != null ? +((rxRate * 8) / 1e6).toFixed(2) : null;
    const txMbps = txRate != null ? +((txRate * 8) / 1e6).toFixed(2) : null;

    const netType = (n.network_type_str || n.network_type || s.network_type_str || null) || null;
    const signalLevel = toNum(n.signal_lvl != null ? n.signal_lvl : s.signal_lvl);
    const rsrp = toNum(s.RSRP);
    const rsrp5g = toNum(s.RSRP_5G);
    const rsrq = toNum(s.RSRQ);
    const sinr = toNum(s.SINR);
    const band = (s.FREQ != null && String(s.FREQ).trim()) ? String(s.FREQ).trim() : null;
    const cellId = (s.CELL_ID != null && String(s.CELL_ID).trim()) ? String(s.CELL_ID).trim() : null;
    const enodebId = (s.ENODEBID != null && String(s.ENODEBID).trim()) ? String(s.ENODEBID).trim() : null;

    const hasAny = [rxMbps, txMbps, netType, signalLevel, rsrp, rsrp5g, rsrq, sinr, band].some(v => v != null);
    if (!hasAny) return null;
    return { networkType: netType, signalLevel, rxMbps, txMbps, rsrp, rsrp5g, rsrq, sinr, band, cellId, enodebId };
  }

  /* ---- connected devices --------------------------------------------------
     cmd 223 ("getAllDevice") is the DHCP-client list on MTN's ZLT 5G firmware:
     it returns an array under `dhcp_list_info`, each entry carrying `hostname`,
     `mac`, `ip` (and a `flow` byte-counter the firmware usually leaves at 0, so
     we ignore it — no per-device GB). This was cross-checked against an
     independent open-source MTN/ZLT tool (github.com/ologunB/mtn-data-usage-tracker),
     which confirms both cmd 223 → dhcp_list_info AND the identical 232→100
     sha256(token+password) login this collector already uses.
     We keep 224/225 (the 2.4G/5G Wi-Fi client tables) and a few older guesses as
     a fallback sweep for firmware variants, and record which cmd actually
     returned data in `cmd` — so if a particular box differs, the real number is
     visible rather than assumed. If nothing returns device-shaped data we return
     null and the panel stays Sample (never a faked list). */
  const MAC_RE = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;
  const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  const DEVICE_CMDS = [223, 224, 225, 20, 65, 66, 106, 300];
  const DEVICE_LIST_KEYS = [
    'dhcp_list_info', 'wlan24g_wifi_info', 'wlan5g_wifi_info',
    'station_list', 'sta_list', 'stationinfo', 'sta_info', 'dev_list', 'device_list',
    'host_list', 'lan_station_list', 'lan_host_list', 'client_list', 'hosts', 'dhcp_list', 'online_list'
  ];

  function parseDeviceObject(o) {
    if (!o || typeof o !== 'object') return null;
    const entries = Object.entries(o);
    let mac = null, ip = null, name = null;
    for (const [k, v] of entries) {
      const val = v == null ? '' : String(v);
      if (mac == null && /mac/i.test(k) && MAC_RE.test(val)) mac = (val.match(MAC_RE) || [])[0];
      else if (ip == null && /ip/i.test(k) && IP_RE.test(val)) ip = (val.match(IP_RE) || [])[0];
      else if (name == null && /(host|name|dev|alias|user)/i.test(k) && val && !MAC_RE.test(val) && !IP_RE.test(val)) name = val.trim();
    }
    if (mac == null || ip == null) {
      for (const [, v] of entries) {
        const val = v == null ? '' : String(v);
        if (mac == null && MAC_RE.test(val)) mac = (val.match(MAC_RE) || [])[0];
        if (ip == null && IP_RE.test(val)) ip = (val.match(IP_RE) || [])[0];
      }
    }
    if (!mac && !ip && !name) return null;
    return { name: name || null, mac: mac || null, ip: ip || null };
  }

  function parseDeviceString(str) {
    const parts = String(str).split(/[|,;]/).map(x => x.trim()).filter(Boolean);
    let mac = null, ip = null, name = null;
    parts.forEach(p => {
      if (mac == null && MAC_RE.test(p)) mac = (p.match(MAC_RE) || [])[0];
      else if (ip == null && IP_RE.test(p)) ip = (p.match(IP_RE) || [])[0];
      else if (name == null && !/^\d+$/.test(p)) name = p;
    });
    if (!mac && !ip) return null;
    return { name: name || null, mac: mac || null, ip: ip || null };
  }

  function extractDeviceList(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const candidates = [];
    for (const key of DEVICE_LIST_KEYS) if (obj[key] != null) candidates.push(obj[key]);
    for (const [, v] of Object.entries(obj)) if (Array.isArray(v)) candidates.push(v);
    for (const c of candidates) {
      let arr = null;
      if (Array.isArray(c)) arr = c;
      else if (typeof c === 'string' && MAC_RE.test(c)) arr = c.split(/\n/).filter(Boolean);
      if (!arr) continue;
      const devs = arr
        .map(item => (typeof item === 'string' ? parseDeviceString(item) : parseDeviceObject(item)))
        .filter(Boolean);
      if (devs.length) return devs.slice(0, 64);
    }
    return null;
  }

  function extractDeviceCount(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
      if (/(sta|station|dev|host|client|online).*(num|count|cnt)/i.test(k)) {
        const num = toNum(v);
        if (num != null) return num;
      }
    }
    return null;
  }

  async function readDevices(cleanIp, sessionId, token) {
    let list = null, count = null, cmdUsed = null;
    for (const cmd of DEVICE_CMDS) {
      let data = null;
      try { data = await getCmdJson(cleanIp, cmd, sessionId, token, 3500); } catch (e) { data = null; }
      if (!data) continue;
      if (count == null) count = extractDeviceCount(data);
      const devs = extractDeviceList(data);
      if (devs && devs.length) { list = devs; cmdUsed = cmd; if (count == null) count = devs.length; break; }
    }
    if (count == null && list) count = list.length;
    if (list == null && count == null) return null;
    return { count, list: list || [], cmd: cmdUsed };
  }

  /* Log in and return { sessionId, token } for reuse. Factored out of collect()
     so the fast live-poll (below) can reuse ONE login across many quick reads
     instead of re-authenticating every few seconds. Handshake is unchanged:
     cmd 232 → token · sha256(token+password) · cmd 100 → sessionId · cmd 233
     refresh (optional). */
  async function login(cleanIp, password) {
    const tokenResponse = await request(cleanIp, { cmd: 232, method: 'GET', sessionId: '' });
    const tokenText = await tokenResponse.text();
    if (tokenText.trim().startsWith('<')) throw new Error(`Device at ${cleanIp} did not expose the ZLT API.`);
    let tokenData;
    try { tokenData = JSON.parse(tokenText); }
    catch (error) { throw new Error(`Invalid token response from ZLT device at ${cleanIp}.`); }
    const token = tokenData?.token || tokenData?.data?.token;
    if (!token) throw new Error(`Could not retrieve a security token from ${cleanIp}.`);

    const passwordHash = crypto.createHash('sha256').update(token + password).digest('hex');
    const sessionSeed = crypto.createHash('md5').update(Math.random().toString()).digest('hex');
    const loginResponse = await request(cleanIp, {
      cmd: 100, method: 'POST', username: 'admin', passwd: passwordHash,
      sessionId: sessionSeed, isAutoUpgrade: '1', isCheckPasswd: '1'
    });
    const loginText = await loginResponse.text();
    if (loginText.trim().startsWith('<')) throw new Error('ZLT login endpoint returned HTML.');
    const loginData = JSON.parse(loginText);
    if (loginData.login_fail === 'fail') throw new Error('ZLT router password incorrect.');
    const activeSessionId = loginData.sessionId || sessionSeed;

    let activeToken = token;
    try {
      const refreshResponse = await request(cleanIp, { cmd: 233, method: 'GET', sessionId: activeSessionId });
      const refreshed = await refreshResponse.json();
      if (refreshed?.token) activeToken = refreshed.token;
    } catch (error) { /* some firmware has no refresh command */ }

    return { sessionId: activeSessionId, token: activeToken };
  }

  /* How long we trust a cached login before forcing a fresh one. */
  const LIVE_SESSION_MAX_MS = 3 * 60 * 1000;

  /* Fast, lightweight read of JUST the live signal + connected-device list,
     reusing a cached login when we can. This is what the helper's short "live"
     loop calls every few seconds so the dashboard's device count changes within
     seconds of a device joining/leaving — WITHOUT re-reading the SMS inbox
     (that stays on the slower full-sync). All local traffic: costs no MTN data. */
  async function collectLive({ routerIp, password, session = null }) {
    const cleanIp = cleanRouterIp(routerIp);
    if (!cleanIp) throw new Error('A router IP address is required for the ZLT collector.');
    if (!password) throw new Error('A router admin password is required for the ZLT collector.');

    let sess = session;
    const reusable = sess && sess.sessionId && sess.token &&
      typeof sess.at === 'number' && (Date.now() - sess.at < LIVE_SESSION_MAX_MS);
    if (!reusable) {
      const l = await login(cleanIp, password);
      sess = { sessionId: l.sessionId, token: l.token, at: Date.now() };
    }

    let diagnostics = await readDiagnostics(cleanIp, sess.sessionId, sess.token);
    let devices = await readDevices(cleanIp, sess.sessionId, sess.token);

    // If we reused a session and the router returned nothing, the session has
    // probably expired — log in once more and try again.
    if (reusable && diagnostics == null && devices == null) {
      const l = await login(cleanIp, password);
      sess = { sessionId: l.sessionId, token: l.token, at: Date.now() };
      diagnostics = await readDiagnostics(cleanIp, sess.sessionId, sess.token);
      devices = await readDevices(cleanIp, sess.sessionId, sess.token);
    }

    return { diagnostics, devices, session: sess };
  }

  return {
    id: 'zlt-sms',
    label: 'MTN 5G ODU / ZLT SMS',
    kind: 'router-sms',
    capabilities: {
      historical: true,
      dailyRecords: true,
      cumulativeCounters: false
    },

    async probe({ routerIp }) {
      const cleanIp = cleanRouterIp(routerIp);
      if (!cleanIp) return { matched: false };
      try {
        const response = await request(cleanIp, { cmd: 232, method: 'GET', sessionId: '' });
        const body = await response.text();
        if (body.trim().startsWith('<')) return { matched: false };
        const tokenData = JSON.parse(body);
        return {
          matched: Boolean(tokenData?.token || tokenData?.data?.token),
          model: 'ZLT gateway'
        };
      } catch (error) {
        return { matched: false, error: error.message };
      }
    },

    async collect({ routerIp, password }) {
      const cleanIp = cleanRouterIp(routerIp);
      if (!cleanIp) throw new Error('A router IP address is required for the ZLT collector.');
      if (!password) throw new Error('A router admin password is required for the ZLT collector.');
      const httpUrl = `http://${cleanIp}/cgi-bin/http.cgi`;

      const { sessionId: activeSessionId, token: activeToken } = await login(cleanIp, password);

      let model = null;
      try {
        const deviceResponse = await request(cleanIp, {
          cmd: 1005,
          method: 'GET',
          sessionId: activeSessionId,
          token: activeToken
        });
        const deviceData = await deviceResponse.json();
        model = deviceData?.board_type || deviceData?.model_name || deviceData?.product_name || deviceData?.model || null;
      } catch (error) {
        // Model metadata is optional; the SMS usage data is still useful.
      }

      let combinedText = '';
      for (let page = 1; page <= 3; page += 1) {
        try {
          const smsResponse = await request(cleanIp, {
            cmd: 12,
            method: 'GET',
            page_num: page,
            subcmd: 0,
            sessionId: activeSessionId,
            token: activeToken
          });
          const smsData = await smsResponse.json();
          const rawList = typeof smsData?.sms_list === 'string'
            ? smsData.sms_list.split(',')
            : (smsData?.sms_list || []);

          rawList.forEach(item => {
            try {
              combinedText += `\n${Buffer.from(String(item).trim(), 'base64').toString('utf8')}`;
            } catch (error) {
              if (typeof item === 'string') combinedText += `\n${item}`;
            }
          });
        } catch (error) {
          // Some firmware versions expose fewer than three SMS pages.
        }
      }

      // LIVE signal + current throughput, and the connected-device list.
      // Both are honest: any value the router doesn't return stays null, so the
      // dashboard keeps that number labelled "Sample" rather than faking it.
      const diagnostics = await readDiagnostics(cleanIp, activeSessionId, activeToken);
      const devices = await readDevices(cleanIp, activeSessionId, activeToken);

      const source = sourceFor(cleanIp, model);
      const records = parseMtnUsageSms(combinedText, source);
      return {
        source,
        records,
        snapshots: [],
        diagnostics,
        devices,
        counterStatus: 'historical'
      };
    },

    collectLive
  };
}

module.exports = {
  createZltSmsCollector,
  sourceFor
};
