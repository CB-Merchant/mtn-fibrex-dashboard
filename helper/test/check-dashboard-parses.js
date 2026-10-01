// Read-only. Extracts every inline <script> from the dashboard and asks Node to
// parse it, so a typo from this session's edits cannot ship silently.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const file = path.join(__dirname, '..', '..', 'mtn-fibrex-dashboard.html');
const html = fs.readFileSync(file, 'utf8');

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
console.log(`inline <script> blocks found: ${blocks.length}`);

let bad = 0;
blocks.forEach((m, i) => {
  const line = html.slice(0, m.index).split('\n').length;
  try {
    new vm.Script(m[1], { filename: `dashboard-script-${i + 1}` });
    console.log(`  ok   block ${i + 1} (starts at line ${line}) parses`);
  } catch (err) {
    bad++;
    console.log(`  FAIL block ${i + 1} (starts at line ${line}): ${err.message}`);
  }
});

const external = [...html.matchAll(/<script[^>]*\bsrc=/gi)];
console.log(`external <script src=...> tags: ${external.length}`);

console.log(bad === 0 && external.length === 0
  ? '\nPASSED — the page parses and loads nothing from the internet.'
  : '\nFAILED');
process.exit(bad === 0 && external.length === 0 ? 0 : 1);
