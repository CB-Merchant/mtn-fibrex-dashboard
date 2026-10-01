// Read-only. Second pass: record shapes, coverage, wrap maths.
const fs = require('fs');
const path = require('path');
const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data_history.json'), 'utf8'));

console.log('=== sources array ===');
console.log(JSON.stringify(s.sources, null, 1).slice(0, 900));

console.log('\n=== one provider-reported record ===');
console.log(JSON.stringify((s.records || []).find(r => r.confidence === 'provider-reported'), null, 1));

console.log('\n=== every observed record (Huawei) ===');
for (const r of (s.records || []).filter(r => r.confidence !== 'provider-reported')) {
  console.log(JSON.stringify(r));
}

console.log('\n=== events on the accounting entry ===');
const a = s.accounting['huawei-hg8145x7'] || {};
console.log('keys:', Object.keys(a));
console.log('lastObservation:', JSON.stringify(a.lastObservation, null, 1));

console.log('\n=== wrap arithmetic for THIS line ===');
const WRAP = 4294967296;
const speeds = (s.settings.speedTests || []).filter(t => t.downMbps != null).map(t => t.downMbps);
const avgDown = speeds.reduce((x, y) => x + y, 0) / speeds.length;
const maxDown = Math.max(...speeds);
console.log('measured download Mbps: avg', avgDown.toFixed(1), 'max', maxDown.toFixed(1));
console.log('minutes to fill 4.29 GB at max speed :', (WRAP * 8 / (maxDown * 1e6) / 60).toFixed(1));
console.log('minutes to fill 4.29 GB at avg speed :', (WRAP * 8 / (avgDown * 1e6) / 60).toFixed(1));
const gbPerDay = 30;
console.log('wraps per day at', gbPerDay, 'GB/day :', (gbPerDay * 1024 ** 3 / WRAP).toFixed(1));
console.log('safe polling gap at max speed (min)  :', (WRAP * 8 / (maxDown * 1e6) / 60).toFixed(1),
  '  <-- helper polls every 3 min, so SAFE while running');

console.log('\n=== the 1185-minute gap, re-examined ===');
const gapMin = 1185;
const prev = 3355755865, cur = 821945681;
const creditedSingle = (WRAP - prev) + cur;
console.log('credited as ONE wrap        :', creditedSingle, `(${(creditedSingle / 1024 ** 3).toFixed(2)} GB)`);
console.log('that implies avg speed Mbps :', (creditedSingle * 8 / (gapMin * 60) / 1e6).toFixed(2));
for (const n of [2, 3, 4]) {
  const c = creditedSingle + (n - 1) * WRAP;
  console.log(`if it wrapped ${n}x          :`, c, `(${(c / 1024 ** 3).toFixed(2)} GB)`,
    '=> avg', (c * 8 / (gapMin * 60) / 1e6).toFixed(2), 'Mbps');
}
console.log('NOTE: nothing on the wire can tell us which of these happened.');
