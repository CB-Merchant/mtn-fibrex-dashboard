'use strict';

/* ============================================================================
   Huawei ONT — deep read of the data counters  (LOOK-ONLY, second pass)
   ----------------------------------------------------------------------------
   Why this exists:
     The first check (probe-huawei.js) found that your box's WAN pages talk
     about "BytesSent" and "BytesReceived" — the exact running data totals the
     dashboard needs. But that first tool only peeks at the first few mentions
     on each page, and on a 74,000-character page the real numbers sit further
     down. So it honestly said "MIXED" when the answer may well be "yes".

     This tool goes back to those few specific pages and reads them properly:
     every byte-counter field, its value, and enough of the surrounding code to
     see where the numbers come from.

   Same promises as before:
     - It only READS. Plain page requests, and it refuses any address whose
       name suggests it changes a setting.
     - Your password is typed into this window only. It is never saved.
     - The report it writes is SCRUBBED: anything that looks like a password,
       Wi-Fi key or session token is replaced with ***hidden*** before it is
       written down, because your broadband pages do carry such things.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const probe = require(path.join(__dirname, 'probe-huawei.js'));

const REPORT = path.join(__dirname, 'huawei-counters-report.txt');

/* The pages that matter, in the order they must be read. wan_list_info.asp goes
   FIRST because it defines the record layout — the parameter names of its
   WaninfoStats function are the field names — and the little stat pages that
   follow send only bare values in that same order. Read the layout first and the
   values get their names back. */
const DEEP = [
  '/html/bbsp/common/wan_list_info.asp',
  '/html/bbsp/common/get_wan_list_pppwanstat.asp',
  '/html/bbsp/common/get_wan_list_ipwanstat.asp',
  '/html/bbsp/common/wan_list.asp',
  '/html/bbsp/common/wan_list_cache_wan.asp',
  '/html/bbsp/common/wan_check.asp',
  '/html/bbsp/wan/wan.asp',
  '/html/ssmp/deviceinfo/deviceinfo.asp'
];

/* If the numbers live in a separate little page, it is usually named something
   like these on Huawei ONT firmware. Cheap to try, harmless if absent. */
const GUESSES = [
  '/html/bbsp/common/get_wan_list_wanstats.asp',
  '/html/bbsp/common/get_wan_list_stats.asp',
  '/html/bbsp/common/wan_list_stats.asp',
  '/html/bbsp/common/wan_list_cache_wanstats.asp',
  '/html/bbsp/common/wanstats.asp',
  '/html/bbsp/common/wan_stats.asp',
  '/html/bbsp/common/get_wan_statistics.asp',
  '/html/bbsp/common/get_wanstats.asp',
  '/html/ssmp/wanstat/wanstat.asp'
];

const DANGEROUS = /(set|del|add|reset|reboot|restore|save|upgrade|update|backup|factory|logout|restart|commit)/i;

const lines = [];
function say(s) { console.log(s); lines.push(s); }
function quiet(s) { lines.push(s); }

/* -------------------------------------------------------------- scrubbing */

/* Broadband pages carry the PPPoE password and the Wi-Fi key. Those must never
   reach a file you might send to someone, so blank them before anything is
   written down. Byte totals are plain numbers, so they survive untouched. */
function scrub(text) {
  return String(text)
    .replace(
      /((?:pass|pwd|psk|passwd|password|secret|token|authkey|privkey|privatekey|sharedkey|wpakey)[\w$]*\s*[=:]\s*)(["'])([^"']+)\2/gi,
      (m, head, q) => head + q + '***hidden***' + q)
    .replace(/\b[0-9a-f]{32,}\b/gi, '***hidden-long-code***');
}

/* ---------------------------------------------------------------- scanning */

/* Every field whose NAME mentions bytes or octets, with whatever it is set to.
   This is the direct answer: "BytesReceived = 884213773194" is what we want,
   "BytesReceived = ''" means the page is only a blank template.

   Written as "match any assignment, then keep the byte-ish ones" on purpose. A
   single clever pattern is easy to get subtly wrong — an earlier version needed
   at least one character before the word "Bytes", so a field named exactly
   BytesSent (which is what this router actually uses) slipped straight past. */
function byteFields(html) {
  const out = [];
  const re = /([A-Za-z_$][\w$]*)\s*[=:]\s*(?:(["'])([^"']*)\2|([A-Za-z_$][\w$.[\]]*)|(\d+))/g;
  let m;
  while ((m = re.exec(html)) && out.length < 200) {
    if (!/bytes|octets/i.test(m[1])) continue;
    const value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
    out.push({
      name: m[1],
      value: value,
      isNumber: /^\d+$/.test(value || ''),
      quoted: m[3] !== undefined
    });
  }
  return out;
}

/* Arguments handed to the box's own statistics constructor. When the firmware
   prints the live values into the page, they often land here as a bare list —
   'domain','73118450021','884213773194' — with no field names attached, so this
   has to be checked as well as the named fields.

   Match ANY function call, then keep the ones whose name mentions "stat". The
   earlier version demanded a name like stWanStats, and this router's real
   constructor is called WaninfoStats — no leading "st" — so every value it
   carried was skipped. Same class of mistake as the BytesSent one below: never
   guess a vendor's exact spelling, match broadly and filter by meaning.

   The pattern deliberately stops at the opening bracket rather than consuming
   the whole call. These lists arrive nested — new Array(new WaninfoStats(...)) —
   and a pattern that swallowed the outer Array( ... ) would step straight over
   the inner constructor and find nothing. */
function statsBlocks(html) {
  const out = [];
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(html)) && out.length < 40) {
    if (!/stat/i.test(m[1])) continue;
    const start = m.index + m[0].length;
    const end = html.indexOf(')', start);
    if (end < 0 || end - start > 900) continue;
    out.push(html.slice(start, end).replace(/\s+/g, ' ').trim());
  }
  return out;
}

/* The long numbers sitting inside those constructor lists. A byte total that
   has been running for days is at least six digits, so that is the floor. */
function numbersInBlocks(blocks) {
  const out = [];
  blocks.forEach(b => {
    const found = b.match(/\d{6,}/g) || [];
    found.forEach(n => out.push({ n: n, from: b.slice(0, 120) }));
  });
  return out;
}

/* The box states its record layout exactly once, as a function whose PARAMETER
   NAMES are the field names:

     function WaninfoStats(domain, BytesSent, BytesReceived, PacketsSent, ...)

   The little stat pages then send only the values, in that same order and with
   no names at all. Learn the layout from the definition and the bare numbers
   can be given their names back — which is the difference between "there are
   some big numbers here" and "download so far is 1672972618 bytes". */
function statsSignature(html) {
  const m = html.match(/function\s+[A-Za-z_$][\w$]*[Ss]tats?\s*\(\s*domain\s*,([^)]{0,900})\)/);
  if (!m) return null;
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
  return names.length >= 4 ? ['domain'].concat(names) : null;
}

/* One record as it arrives on the wire: the connection's long TR-069 name
   followed by its values, all quoted. Four or more values in a row after that
   name is the shape. Both quote styles appear in Huawei firmware.

   The constructor's name is captured too (`via`), because several pages build
   records with a DIFFERENT constructor and a different field order. Labelling
   those with byte names would print confident nonsense — "PacketsSent =
   AlwaysOn" — so the caller checks `via` before applying a layout. */
function statRecords(html) {
  const out = [];
  ['"', "'"].forEach(q => {
    const re = new RegExp('(?:([A-Za-z_$][\\w$]*)\\s*\\(\\s*)?'
      + q + '(InternetGatewayDevice[^' + q + ']*)' + q
      + '((?:\\s*,\\s*' + q + '[^' + q + ']*' + q + '){3,})', 'g');
    let m;
    while ((m = re.exec(html)) && out.length < 8) {
      const vre = new RegExp(q + '([^' + q + ']*)' + q, 'g');
      const values = [];
      let v;
      while ((v = vre.exec(m[3]))) values.push(v[1]);
      out.push({ via: m[1] || '', domain: m[2], values: values });
    }
  });
  return out;
}

/* signature[0] is 'domain', so the record's first value belongs to
   signature[1], and so on. Anything past the end of the layout is still
   reported, just numbered rather than named. */
function labelRecord(record, signature) {
  return record.values.map((v, i) => ({
    name: signature && signature[i + 1] ? signature[i + 1] : 'value ' + (i + 2),
    value: v,
    isNumber: /^\d+$/.test(v)
  }));
}

/* Why the High/Low pair exists: the plain BytesSent field is a 32-bit counter,
   so it wraps back to zero every 4294967295 bytes — about 4 GB, which on a
   fibre line can be minutes. Huawei therefore also publishes the true total
   split into two halves. Put them back together: high * 4294967296 + low. */
function combine64(labelled) {
  const value = name => {
    const f = labelled.find(x => x.name === name);
    return f && f.isNumber ? Number(f.value) : null;
  };
  const out = {};
  [['sent', 'BytesSentHigh', 'BytesSentLow'],
   ['received', 'BytesReceivedHigh', 'BytesReceivedLow']].forEach(pair => {
    const hi = value(pair[1]), lo = value(pair[2]);
    if (hi === null || lo === null) return;
    out[pair[0]] = hi * 4294967296 + lo;
  });
  return out;
}

/* Long numbers, with the words just before them, so a human can tell a data
   total from a serial number or a date. */
function bigNumbers(html) {
  const flat = html.replace(/\s+/g, ' ');
  const out = [];
  const re = /\d{8,}/g;
  let m;
  while ((m = re.exec(flat)) && out.length < 40) {
    out.push({ n: m[0], before: flat.slice(Math.max(0, m.index - 80), m.index) });
  }
  return out;
}

/* Chunks of the page around each mention of the counters, so the shape of the
   data is visible — enough to write a reader from, nothing more. */
function contextAround(html, maxChunks) {
  const flat = html.replace(/\s+/g, ' ');
  const re = /(WanStats|BytesSent|BytesReceived|TotalBytes|X_HW_.{0,12}Bytes)/g;
  const out = [];
  let m, lastEnd = -1;
  while ((m = re.exec(flat)) && out.length < maxChunks) {
    if (m.index < lastEnd) continue;                 // don't repeat overlapping windows
    const from = Math.max(0, m.index - 260);
    const to = m.index + 420;
    out.push(flat.slice(from, to));
    lastEnd = to - 120;
  }
  return out;
}

/* Any other page named right next to the counters — a likely data source. */
function candidatePages(html, fromPath) {
  const found = new Set();
  const re = /(WanStats|BytesSent|BytesReceived)/g;
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

/* Learned from the first page that defines it, then used for every later page.
   The stat pages themselves never repeat the layout. */
let learnedLayout = null;

async function readPage(p) {
  const res = await probe.request('GET', p);
  if (res.status !== 200 || !res.body) {
    quiet('  ' + String(res.status || res.error).padEnd(5) + p);
    return null;
  }
  const html = res.body;
  if (!learnedLayout) {
    learnedLayout = statsSignature(html);
    if (learnedLayout) {
      say('  layout learned from ' + p + ': ' + learnedLayout.join(', '));
    }
  }
  const fields = byteFields(html);
  const numeric = fields.filter(f => f.isNumber && f.value.length >= 6);
  const blocks = statsBlocks(html);
  const blockNums = numbersInBlocks(blocks);
  const bigs = bigNumbers(html);
  const records = statRecords(html).map(r => {
    /* Only put the statistics layout onto a record that actually came from the
       statistics constructor. The cache and device-info pages carry records
       built by WanPPP() and stDeviceInfo() — same shape, completely different
       field order — and naming their values "BytesSent" would be a lie. */
    const layout = /stat/i.test(r.via) ? learnedLayout : null;
    const labelled = labelRecord(r, layout);
    return {
      domain: r.domain, via: r.via, values: r.values,
      labelled: labelled, totals: combine64(labelled)
    };
  });

  say('  read  ' + p + '  (' + html.length + ' characters)');
  say('        byte-named fields: ' + fields.length
    + '   real numbers found: ' + (numeric.length + blockNums.length)
    + '   full records: ' + records.length);

  quiet('');
  quiet('  ---- ' + p + ' ----');

  /* These little get_*.asp pages are the payload itself and only a couple of
     hundred characters long, so write the whole thing down. No regex can then
     hide part of the answer — the way one just did. */
  if (html.length <= 4000) {
    quiet('  Whole page, exactly as it came back:');
    quiet('    ' + scrub(html.replace(/\s+/g, ' ').trim()));
  }
  if (records.length) {
    quiet('  Records, with the layout applied so each value has its name:');
    records.forEach(r => {
      quiet('    connection: ' + r.domain);
      r.labelled.forEach(f => quiet('      ' + f.name + ' = '
        + (f.value === '' ? '(empty)' : scrub(String(f.value)).slice(0, 60))
        + (/Bytes/.test(f.name) ? asGB(f.value) : '')));
    });
  }
  if (fields.length) {
    quiet('  Every byte/octet field on the page:');
    fields.slice(0, 60).forEach(f => quiet('    ' + f.name + ' = '
      + (f.value === '' ? '(empty)' : scrub(String(f.value)).slice(0, 60))));
  }
  if (blocks.length) {
    quiet('  Values handed to the box\'s own statistics constructor:');
    blocks.forEach(b => quiet('    (' + scrub(b).slice(0, 400) + ')'));
  }
  if (bigs.length) {
    quiet('  Long numbers found, with the words just before them:');
    bigs.forEach(b => quiet('    ' + b.n + '   <-- ...' + scrub(b.before).slice(-70)));
  }
  contextAround(html, 6).forEach((c, i) => {
    quiet('  Context ' + (i + 1) + ': ' + scrub(c));
  });

  return { page: p, fields, numeric, blocks, blockNums, bigs, records, candidates: candidatePages(html, p) };
}

/* ------------------------------------------------------------------ verdict */

/* Bytes mean nothing to a human, so show gigabytes alongside. */
function asGB(value) {
  const gb = Number(value) / 1024 / 1024 / 1024;
  return isFinite(gb) && gb >= 0.01 ? '   (about ' + gb.toFixed(2) + ' GB)' : '';
}

/* A named byte total with a real number in it — the thing we actually came for. */
function statedTotals(r) {
  const out = [];
  (r.records || []).forEach(rec => {
    rec.labelled.forEach(f => {
      if (/^Bytes(Sent|Received)$/.test(f.name) && /^\d{6,}$/.test(f.value)) out.push(f);
    });
  });
  return out;
}

function verdict(results) {
  const withRecords = results.filter(r => statedTotals(r).length > 0);
  const withNumbers = results.filter(r => r.numeric.length > 0 || (r.blockNums || []).length > 0);
  const mentionOnly = results.filter(r => r.numeric.length === 0
    && (r.blockNums || []).length === 0 && statedTotals(r).length === 0 && r.fields.length > 0);

  say('');
  say('=========================================================');
  say('  THE ANSWER');
  say('=========================================================');

  if (withRecords.length) {
    say('YES. Your box publishes running data totals, with names attached.');
    say('');
    say('That is everything the dashboard needs: read the total now, read it');
    say('again later, subtract, and you have real usage — no guessing.');
    say('');
    withRecords.forEach(r => {
      say('  On ' + r.page + ':');
      r.records.forEach(rec => {
        say('    connection ' + rec.domain);
        rec.labelled.filter(f => /Bytes|Packets/.test(f.name)).forEach(f =>
          say('      ' + f.name + ' = ' + f.value + (/Bytes/.test(f.name) ? asGB(f.value) : '')));
        if (rec.totals.sent !== undefined || rec.totals.received !== undefined) {
          say('      -- the two-part (64-bit) totals, put back together:');
          if (rec.totals.sent !== undefined) {
            say('         uploaded so far   = ' + rec.totals.sent + asGB(rec.totals.sent));
          }
          if (rec.totals.received !== undefined) {
            say('         downloaded so far = ' + rec.totals.received + asGB(rec.totals.received));
          }
        }
      });
    });
    return 'yes';
  }

  if (withNumbers.length) {
    say('YES. Your box does publish running data totals.');
    say('');
    say('That is everything the dashboard needs: read the total now, read it');
    say('again later, subtract, and you have real usage — no guessing.');
    say('');
    withNumbers.forEach(r => {
      say('  On ' + r.page + ':');
      r.numeric.slice(0, 10).forEach(f => say('     ' + f.name + ' = ' + f.value + asGB(f.value)));
      (r.blockNums || []).slice(0, 10).forEach(b =>
        say('     ' + b.n + asGB(b.n) + '   (in its statistics list)'));
    });
    return 'yes';
  }

  if (mentionOnly.length) {
    say('ALMOST. The counter fields exist on your box, but they came back');
    say('EMPTY, which means the page is a blank form and the live numbers are');
    say('fetched separately a moment after it opens.');
    say('');
    say('Pages holding the empty fields:');
    mentionOnly.forEach(r => say('  ' + r.page + '  (' + r.fields.length + ' fields)'));
    const cands = [...new Set(results.reduce((a, r) => a.concat(r.candidates), []))];
    if (cands.length) {
      say('');
      say('Pages named right beside the counters — likely where the numbers');
      say('actually come from (already tried above; see the saved report):');
      cands.slice(0, 15).forEach(c => say('  ' + c));
    }
    return 'almost';
  }

  say('NOT FOUND. None of the pages we could read carried byte counters at');
  say('all this time. The saved report lists exactly what was read.');
  return 'no';
}

/* --------------------------------------------------------------------- main */

async function run() {
  const tried = new Set();
  const results = [];

  for (const p of DEEP.concat(GUESSES)) {
    if (tried.has(p) || DANGEROUS.test(p)) continue;
    tried.add(p);
    const r = await readPage(p);
    if (r) results.push(r);
  }

  /* Follow anything named next to the counters that we have not tried yet. */
  const extra = [...new Set(results.reduce((a, r) => a.concat(r.candidates), []))]
    .filter(p => !tried.has(p) && !DANGEROUS.test(p))
    .slice(0, 15);
  if (extra.length) {
    say('');
    say('Following ' + extra.length + ' page(s) named beside the counters ...');
    for (const p of extra) {
      tried.add(p);
      const r = await readPage(p);
      if (r) results.push(r);
    }
  }

  return results;
}

async function main() {
  say('');
  say('=========================================================');
  say('  Huawei FibreX box — reading the data counters properly');
  say('=========================================================');
  say('');
  console.log('The first check found that your box talks about "BytesSent" and');
  console.log('"BytesReceived" — running data totals. This goes back to those');
  console.log('pages and reads them in full, to see the actual numbers.');
  console.log('');
  console.log('Same as before: it only LOOKS, your password is never saved, and');
  console.log('the report is scrubbed of anything password-like before saving.');
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
  say('Signed in. Reading the counter pages in full ...');
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
  console.log('Passwords and Wi-Fi keys were replaced with ***hidden*** before');
  console.log('saving. It may still show your connection name and IP address,');
  console.log('so glance through it before sharing.');
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
  run, verdict, byteFields, statsBlocks, numbersInBlocks, bigNumbers, contextAround,
  candidatePages, scrub, asGB, statsSignature, statRecords, labelRecord, combine64,
  reportLines: lines
};
