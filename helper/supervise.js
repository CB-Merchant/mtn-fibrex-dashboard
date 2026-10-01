'use strict';

/* ============================================================================
   MTN FibreX helper — SUPERVISOR (keep-it-running wrapper)
   ----------------------------------------------------------------------------
   Runs the helper (server.js) and keeps it alive so you don't have to babysit
   a terminal:

     • If the helper ever crashes, this restarts it automatically (with a short
       back-off so a broken start doesn't spin forever).
     • If we CHANGE the helper's code (server.js or anything under engine/), it
       restarts the helper on its own so the update is picked up — no manual
       restart needed.

   What this does NOT change:
     • The dashboard page (mtn-fibrex-dashboard.html) is already served fresh on
       every visit, so editing the page never needed a restart — just refresh.
     • Your router password lives in memory only and is NEVER saved. So any
       restart (a crash-restart OR a code-update restart) forgets it, and the
       page will show "Helper ready" until you press Sync once more. Speed tests
       keep running on their own (they don't use the router password).

   Zero dependencies (built-in Node only). Start it with start-helper.cmd, or:
       node supervise.js
   Stop everything with Ctrl+C.
   ========================================================================== */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const HELPER_DIR = __dirname;
const SERVER = path.join(HELPER_DIR, 'server.js');

let child = null;
let restarting = false;     // true while we're intentionally cycling the child
let stopping = false;       // true once the user asked us to quit
let crashCount = 0;         // consecutive crashes (reset by a change or a clean run)
let debounceTimer = null;
let lastStart = 0;

function log(msg) { console.log(`[supervisor] ${msg}`); }

/* Which files, when edited, should trigger a helper restart. We only care about
   the helper's own code — not data files, backups, tests, or the dashboard. */
function isCodeFile(file) {
  if (!file) return false;
  const f = file.replace(/\\/g, '/');
  if (!f.endsWith('.js')) return false;            // only JavaScript
  if (f.includes('/data/')) return false;          // saved usage/settings
  if (f.includes('/test/')) return false;          // test harnesses + throwaways
  if (f.includes('node_modules/')) return false;
  return true;
}

function startChild() {
  lastStart = Date.now();
  child = spawn(process.execPath, [SERVER], { stdio: 'inherit', env: process.env });

  child.on('exit', (code, signal) => {
    const wasIntentional = restarting;
    child = null;
    if (stopping) return;

    if (wasIntentional) {
      restarting = false;
      startChild(); // we killed it on purpose (code change) — bring it back now
      return;
    }

    // Unplanned exit = a crash. Restart with a back-off, and if it keeps dying
    // right after starting, slow down and print a hint instead of hammering.
    const ranFor = Date.now() - lastStart;
    if (ranFor < 4000) crashCount++; else crashCount = 0;
    const waitMs = Math.min(30000, 1000 * Math.pow(2, Math.min(crashCount, 5))); // 1s,2s,4s… cap 30s
    log(`helper stopped (code ${code}${signal ? ', ' + signal : ''}). Restarting in ${Math.round(waitMs / 1000)}s…`);
    if (crashCount >= 4) {
      log('It keeps stopping right after starting. Common cause: port 8947 is already');
      log('in use by another helper window — close the other one. This will keep trying.');
    }
    setTimeout(() => { if (!stopping) startChild(); }, waitMs);
  });

  child.on('error', err => log(`could not start helper: ${err.message}`));
}

/* Kill the current child and let its 'exit' handler respawn a fresh one. Waiting
   for the real exit (rather than spawning immediately) lets the TCP port be
   released, so the new helper doesn't hit "port in use". */
function restart(reason) {
  if (stopping || restarting) return;
  crashCount = 0;
  log(`${reason} — restarting the helper so the update takes effect…`);
  if (child) {
    restarting = true;
    const kid = child;
    child.kill();
    // Safety net: if it doesn't exit promptly, force it (Windows-friendly).
    setTimeout(() => {
      if (kid && !kid.killed) { try { kid.kill('SIGKILL'); } catch { /* already gone */ } }
    }, 3000);
  } else {
    startChild();
  }
}

function watchCode() {
  // Recursive watch works on Windows (the target platform for this helper).
  try {
    fs.watch(HELPER_DIR, { recursive: true }, (_event, filename) => {
      if (!isCodeFile(filename)) return;
      clearTimeout(debounceTimer); // editors fire several events per save — debounce
      debounceTimer = setTimeout(() => restart(`code change (${filename})`), 400);
    });
    log(`watching helper code for changes — edits to server.js / engine will reload automatically.`);
  } catch (err) {
    log(`live code-reload unavailable on this system (${err.message}). Crash-restart still works.`);
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  log('stopping the helper and exiting.');
  if (child) { try { child.kill(); } catch { /* already gone */ } }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('starting the MTN FibreX helper and keeping it alive (Ctrl+C to stop).');
startChild();
watchCode();
