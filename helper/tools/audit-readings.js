// Read-only audit of the REAL data file. Writes nothing. No secrets printed.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'data_history.json');
const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const now = new Date();
const ageMin = iso => iso ? Math.round((now - new Date(iso)) / 60000) : null;

console.log('=== NOW ===', now.toISOString());

console.log('\n=== DEVICES PANEL SOURCE ===');
const d = s.settings && s.settings.devices;
console.log('count     :', d && d.count);
console.log('observedAt:', d && d.observedAt, '=> age', ageMin(d && d.observedAt), 'min');
console.log('cmd       :', d && d.cmd);
console.log('first ip  :', d && d.list && d.list[0] && d.list[0].ip);

console.log('\n=== SIGNAL PANEL SOURCE ===');
const g = s.settings && s.settings.signal;
console.log('networkType:', g && g.networkType, '| rsrp', g && g.rsrp, '| band', g && g.band);
console.log('observedAt :', g && g.observedAt, '=> age', ageMin(g && g.observedAt), 'min');

console.log('\n=== SOURCES ===');
for (const [id, v] of Object.entries(s.sources || {})) {
  console.log(id, '| lastCollectedAt', v.lastCollectedAt, '=> age', ageMin(v.lastCollectedAt), 'min');
}

console.log('\n=== ACCOUNTING ===');
for (const [id, a] of Object.entries(s.accounting || {})) {
  const lo = a.lastObservation || {};
  console.log(id, '| lastSeenAt', a.lastSeenAt, '=> age', ageMin(a.lastSeenAt), 'min');
  console.log('   last counters dl', lo.downloadBytes, 'ul', lo.uploadBytes, 'at', lo.observedAt);
  const days = Object.entries(a.dailyTotals || {}).slice(-6);
  for (const [day, t] of days) {
    const gb = ((t.downloadBytes || 0) + (t.uploadBytes || 0)) / 1024 ** 3;
    console.log('   ', day, gb.toFixed(2), 'GB');
  }
}

console.log('\n=== RECORDS BY SOURCE ===');
const bySrc = {};
for (const r of s.records || []) {
  const k = `${r.source} / ${r.confidence}`;
  bySrc[k] = bySrc[k] || { n: 0, gb: 0, first: r.date, last: r.date };
  bySrc[k].n++; bySrc[k].gb += Number(r.usageGB || 0);
  if (r.date < bySrc[k].first) bySrc[k].first = r.date;
  if (r.date > bySrc[k].last) bySrc[k].last = r.date;
}
for (const [k, v] of Object.entries(bySrc)) {
  console.log(k.padEnd(34), String(v.n).padStart(3), 'days', v.gb.toFixed(1).padStart(8), 'GB  ', v.first, '->', v.last);
}

console.log('\n=== THIS CYCLE (what the hero number sums) ===');
const cycleStartDay = (s.settings && s.settings.cycleStartDay) || 1;
const startISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(cycleStartDay).padStart(2, '0')}`;
const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const inCycle = (s.records || []).filter(r => r.date >= startISO && r.date <= todayISO);
let total = 0;
for (const r of inCycle) total += Number(r.usageGB || 0);
console.log('window', startISO, '->', todayISO, '| records', inCycle.length, '| total', total.toFixed(2), 'GB');
const perSrc = {};
for (const r of inCycle) {
  perSrc[r.source] = (perSrc[r.source] || 0) + Number(r.usageGB || 0);
}
console.log('  by source:', perSrc);
console.log('  dates    :', inCycle.map(r => r.date).join(' '));

console.log('\n=== GAPS IN THE DATE SERIES ===');
const dates = [...new Set((s.records || []).map(r => r.date))].sort();
for (let i = 1; i < dates.length; i++) {
  const a = new Date(dates[i - 1] + 'T00:00:00');
  const b = new Date(dates[i] + 'T00:00:00');
  const diff = Math.round((b - a) / 86400000);
  if (diff > 1) console.log('  hole:', dates[i - 1], '->', dates[i], `(${diff - 1} missing day(s))`);
}

console.log('\n=== SPEED TESTS ===');
const st = (s.settings && s.settings.speedTests) || [];
console.log('entries', st.length, '| null downMbps:', st.filter(t => t.downMbps == null).length);
console.log('latest 3:', st.slice(-3).map(t => `${t.at} ${t.downMbps}/${t.upMbps}`).join(' | '));

console.log('\n=== RELIABILITY ===');
const rel = (s.settings && s.settings.reliability) || {};
console.log('monitoring', rel.monitoring, '| windowStart', rel.windowStart,
  '| observedSeconds', rel.observedSeconds, `(${(rel.observedSeconds / 86400).toFixed(2)} days)`,
  '| uptimePct', rel.uptimePct, '| outages', (rel.outages || []).length);
console.log('lastObservedAt', rel.lastObservedAt, '=> age', ageMin(rel.lastObservedAt), 'min');

console.log('\n=== PLAN SETTINGS ===');
console.log('monthlyLimitGB', s.settings.monthlyLimitGB, '| isUnlimited', s.settings.isUnlimited,
  '| cycleStartDay', s.settings.cycleStartDay);
