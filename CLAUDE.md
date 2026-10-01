# MTN FibreX Usage Dashboard — Project Brief & Handoff

*A plain-language summary of everything done so far and everything planned, so I can continue this project in Claude Code. Written for a first-time builder.*

---

## How to use this file

- This file is the memory of the project. It explains the goal, what already exists, the decisions made, and the plan.
- **In Claude Code:** keep this file named `CLAUDE.md` in the project folder. Claude Code reads it automatically at the start of every session, so I don't have to re-explain anything — I can just say what I want to do next.
- Everything here is written to be understood **without any coding knowledge**.
- A good opening message to Claude Code is at the very bottom of this file ("First prompt to paste").

---

## 1. The goal — what I'm building

A personal web **dashboard** (a single web page) that shows all the useful statistics from my **MTN FibreX** home broadband — and shows *more* than MTN's own portal or the router's page, because both of those show less than I want.

The dashboard should include:

- **Data left this cycle** and a **run-out prediction** ("at this pace you'll run out in ~X days").
- **Daily usage trend** (how much data used each day).
- **Monthly history** (how much used in each past month).
- **Speed vs my plan** (download / upload over time).
- **Reliability** (uptime % and a list of outages).
- **Connected devices** and how much each used.
- **My plan & wallet** (plan name, price, renewal, wallet balance).

It should look and feel like a polished MTN product, not a generic template.

---

## 2. About me (the builder)

I'm a **complete beginner** — this is the first thing I've ever tried to build. Please:

- Explain everything **from scratch**, in simple terms.
- **Avoid jargon**, or explain it plainly the first time (e.g. "an API is a way for programs to talk to each other").
- Go **step by step**, and tell me exactly what to click or type.
- I'm in **Nigeria**, an **MTN FibreX** customer.

---

## 3. The one hard rule (please always follow)

**Build the dashboard as a SINGLE self-contained HTML file.** That means:

- All the styling and all the code live **inside the one `.html` file**.
- **Charts are drawn by hand using SVG** (built into the page) — do **NOT** load a chart library (like Chart.js) or anything else **from the internet** (a "CDN").

**Why:** we first tried loading a chart library from the internet, and on my side it didn't load, so the charts showed up **blank**. Drawing them inside the page fixed it and means the page **works even with no internet**.

- A Google Fonts link is acceptable (if it's blocked, the page just falls back to normal system fonts and still works).
- **Before sharing any new version, check there are no `<script src="...">` tags or CDN links** in the file.

---

## 4. What's already built

There is a **working prototype** file: **`mtn-fibrex-dashboard.html`** (I've seen it and approved the look).

- Dark theme + **MTN yellow**, with an animated **"fibre-light"** streak effect in the hero header (evokes light travelling through fibre).
- Right now it runs on **sample (made-up) numbers**, clearly marked with a **"Sample data"** badge.
- **All charts are drawn by the page itself in SVG** — no internet needed. ✅ (This already follows the hard rule above.)

**Sections currently on the page (top to bottom):**

1. Top bar — MTN logo, "FibreX · Dashboard", "Sample data" badge, account chip.
2. Hero — big "Data left this cycle" number, run-out prediction sentence, usage progress bar, and a "This cycle" side panel (cycle day, daily average, busiest day, projected total).
3. KPI row — three cards: **Uptime (month)**, **Devices online**, **Used today**.
4. **Daily data usage** — bar per day + a white 7-day trend line.
5. **Speed vs your plan** — download line (yellow) + upload line (grey) + plan line (green dashed), with current down/up readouts.
6. **Monthly consumption** — one bar per month + red dashed "cap" line + a month picker.
7. **Reliability** — a circular uptime ring (%) + a list of recent outages.
8. **Connected devices** — each device and its data use this cycle.
9. **Your plan & wallet** — plan name, renews-in, monthly price, wallet balance.
10. Footer — notes that it's a prototype with sample numbers and self-drawn charts.

### Where the numbers live (for whoever edits the file)

Near the top of the `<script>` section there is one object called **`const DATA = { ... }`** — this is the **single place** to change numbers. Its fields:

- `cap` (GB allowance), `used` (GB used so far), `dailyAvg` (GB/day)
- `cycleDaysTotal`, `cycleDayNow` (billing-cycle position)
- `ratedSpeed` (plan Mbps), `downNow`, `upNow` (current speeds)
- `usage[30]` — last 30 days of daily GB (oldest first)
- `down[30]`, `up[30]` — last 30 days of download / upload Mbps
- `months[]` — `{m, full, gb}` per month
- `devices[]` — `{name, kind, icon, gb}` per device

### Design tokens (keep these consistent)

- **Colours:** near-black `#09090B`; panels `#141417` and `#1C1C21`; **MTN yellow `#FFCC00`**; amber `#FF9E1B`; green `#34D399`; red `#FB6A6A`; text `#FAFAF7`; muted grey `#A1A1AA`.
- **Fonts:** *Space Grotesk* (big numbers / headings), *IBM Plex Sans* (body text), *IBM Plex Mono* (small labels and units).
- **Signature element:** the animated fibre-light streaks in the hero. Keep this as the one memorable flourish; keep everything else calm.

---

## 5. The big question: can it update automatically?

I originally wanted the data to **fill itself in automatically**. Here is the honest reality we established:

- **There is NO official MTN "data feed" (API)** that a home customer can use to read their own FibreX usage, plan, or wallet.
  - *(I found an official "MTN Retailer Productivity" API document. It turned out to be for MTN shops/agents to track their **sales** — SIM registrations, airtime/data selling, Mobile Money sign-ups — and it needs a partner key. Nothing about home internet usage. **Not usable for this project.**)*
- **A web page, on its own, is not allowed to log into the router or MTN and read data** — web browsers block that on purpose, for safety.
- **Therefore:**
  - **Account/billing info** (plan, price, wallet, renewal) → I **type it in myself**. It only changes about **once a month**, so this is quick.
  - **Things that can calculate themselves** (days-to-renewal countdown, run-out prediction) → these **already update on their own** each time I open the page.
  - **Daily-changing info** (data used, uptime) → **can be automated**, but only with a small **"helper" program** that runs on a computer that stays switched on, reads the router on my home network, and updates the dashboard.

### Two important facts about MY setup

- **I do NOT receive MTN daily-usage SMS texts.** (Some trackers work by reading a daily "your usage is X GB" text — that route will **not** work for me.)
- So my automatic usage must come from **reading the router's built-in data counters directly**.
- **My exact router model is not yet identified** — this needs to be checked before the helper can be built (see plan step 2).

---

## 6. The tool we're building on: WiFiWatch

I found a free, open-source tool called **WiFiWatch** and its code is included in this project at **`wifiwatch-engine-reference/`**.

- Source: `github.com/sagenoya/mtn-data-tracker` — MIT licence, by "Sagenoya". (Please credit / respect the licence if reusing code.)
- It's a **working MTN broadband usage tracker** for MTN 5G ODU (ZLT routers) **and MTN FibreX**.
- **Why it's valuable:** it already knows how to log into the common MTN FibreX router (**ZTE F6600P**, admin page at `192.168.1.1`) and read its **data counters** (download/upload bytes, uptime). That is exactly the **"engine"** we need. See **`wifiwatch-engine-reference/src/collectors/zte-f6600p.js`**.

### My decision: COMBINE (its engine + my dashboard)

- **Reuse WiFiWatch's data-collecting engine** (the router-reading part).
- **Keep MY self-contained, MTN-branded dashboard** as the display — because WiFiWatch's own dashboard loads a chart library from the internet (could show blank charts, the exact problem I hit) and looks generic.
- **What WiFiWatch does NOT give us** (so these stay manual or limited): plan / price / wallet, true speed-over-time for FibreX, and a named per-device breakdown.

### Useful files inside `wifiwatch-engine-reference/`

- `src/collectors/zte-f6600p.js` — logs into the FibreX (ZTE) router and reads usage counters + uptime. **The key file.**
- `src/collectors/zlt-sms.js` — the 5G-ODU path (reads the router's SMS inbox). *Less relevant since I don't get usage SMS.*
- `src/collectors/sms.js` — parses "Y'ello, your data usage for … is X GB" texts.
- `src/domain/counter-accounting.js` — turns raw counter readings into tidy **daily usage** (handles counter resets).
- `public/app.js`, `public/index.html`, `public/style.css` — WiFiWatch's own dashboard (reference only; we're not using its look).
- `server.js` — how it runs locally as a small server.

---

## 7. The plan from here (in order)

**Step 1 — Add an on-page "Settings" panel to the dashboard.** *(This is the current step, and it's what I asked to start.)*
A panel where **I type my own details**, which are then **remembered in my browser** (so they survive closing/reopening the page):

- Plan name, monthly price, data cap (or "unlimited"), cycle start / renewal date, wallet balance, auto-renew on/off.
- Router address (default `192.168.1.1`) and router model.
- A simple **"add today's usage"** box (date + GB) so I can log **real** usage now, even before automation exists.
- *Reason I want this:* it keeps the dashboard **general** (not hard-coded to me) and lets me enter details on the page instead of editing code. It's also safer — my details live only in my own copy.
- **Must stay self-contained** (no internet needed to view), per the hard rule.
- Clearly label each panel as **Live** (auto), **Manual** (typed), or **Sample**.

**Step 2 — Identify my router. ✅ DONE — and the answer changed twice.**
Find the address with **`ipconfig`** (the **"Default Gateway"** number), not by guessing.

- **Earlier (5G line):** MTN **5G ODU · ZLT X17U** at **`192.168.0.1`** — fully supported, gave real Live usage via its SMS inbox.
- **Now (fibre line, confirmed 2026-09-15):** MTN **FibreX ONT · Huawei HG8145X7** at **`192.168.100.1`** (this PC's default gateway; its admin page reports `ProductName = 'HG8145X7-10'`, `CfgMode = 'MTN'`). The old ZLT address no longer answers.
- **Not** the **ZTE F6600P** that this brief originally assumed, so `192.168.1.1` is wrong for me.
- **Consequence:** ~~the helper has readers for the ZTE F6600P and ZLT X17U only~~ — **resolved 2026-09-18:** a **Huawei HG8145X7 reader now exists** (Step 2c), so the fibre line reports **Live** usage. The **uptime/outage monitor** was never affected (it doesn't read the router).

**Step 2b — Can the Huawei box be read at all? ✅ ANSWERED 2026-09-16: YES.**
The box **does publish running byte totals**, so a real Live usage reader for the fibre line is possible. Findings, so nobody re-treads them:

- **The live endpoint:** `GET /html/bbsp/common/get_wan_list_pppwanstat.asp` — a 231-character reply carrying the actual numbers. Its sibling `get_wan_list_ipwanstat.asp` came back empty (42 characters) because this line is **PPPoE**, not IPoE. Neither is linked from a menu; both were found by reading `WanStatsLoader()` inside `wan_list.asp` and following its own `$.ajax` URLs. **All 9 guessed page names returned 404** — guessing Huawei page names does not work, follow the box's own links.
- **How to read it:** the reply is a bare list of quoted values with **no field names**. The names come from `/html/bbsp/common/wan_list_info.asp`, which states the layout exactly once:
  `function WaninfoStats(domain, BytesSent, BytesReceived, PacketsSent, PacketsReceived, UnicastSent, UnicastReceived, MulticastSent, MulticastReceived, BroadcastSent, BroadcastReceived, BytesSentHigh, BytesSentLow, BytesReceivedHigh, BytesReceivedLow)`
  So: read that page first, then zip those names onto the values by position. **Zip only as far as the values actually go** — the box sends fewer values than the layout declares (see the correction below), and only records built by *this* constructor may use these names; other pages build look-alike records with `WanPPP(...)` and `stDeviceInfo(...)` in a completely different order.
- **Observed on the real box, twice.** Run 1: `BytesSent = 858601123`, `BytesReceived = 1672972618`. Run 2, minutes later: `BytesSent = 896319260` (≈0.83 GB up), `BytesReceived = 1689502191` (≈1.57 GB down), `PacketsSent = 2636353`, `PacketsReceived = 12140647`, `BroadcastReceived = 110143`. Connection domain `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Stats`. **The totals rose between the two runs (+37,718,137 sent, +16,529,573 received) — that monotonic rise IS the proof the read/wait/subtract mechanism works.**
- **⚠️ CORRECTION — the 64-bit halves are NOT available.** An earlier note here said a collector *must* compute `high × 4294967296 + low`. **That was wrong and is retracted.** The `WaninfoStats` layout *declares* 14 values, but the box only ever *sends* **10**: the reply stops at `BroadcastReceived`, and `BytesSentHigh/Low` + `BytesReceivedHigh/Low` are simply absent from the wire. (The `4294967295` values seen earlier were also misread — they sit inside `WanPPP(...)` beside `AlwaysOn` and beside `X_HW_MultiCastVLAN`, i.e. "unlimited / unset" sentinels, **not** evidence of counter width.) So a collector gets one plain field per direction and **must be reset- and wrap-tolerant instead**: if the number ever drops, treat it as a new baseline rather than negative usage. Useful trick available for free — the helper's **always-on uptime/outage monitor** can tell the two cases apart: no outage seen around the drop → a 4 GB wrap (add 2³²); an outage seen → a genuine PPPoE reconnect (take the new value as the new zero). `engine/domain/counter-accounting.js` already does the reset half of this.
- **Open question, not a blocker.** The absolute figures look small for a line using ~520 GB/cycle. Most likely the counters were reset by a recent PPPoE reconnect. No uptime/connection-age field has been positively identified yet, so this is unconfirmed — it does not affect usability, since usage is measured by *differences*, not by the absolute value.
- **Logging in: SOLVED, coded, confirmed.** The box reports `CfgMode = 'MTN'`, which takes the simple login path (not the SHA-256 one): `POST /asp/GetRandCount.asp` → 64-hex token (arrives with a byte-order mark), plant cookie `Cookie=body:Language:english:id=-1`, then `POST /login.cgi` with `UserName`, `PassWord` = **plain base64** of the password, `Language=english`, `x.X_HW_Token` = token. Username `root`, worked first try. Zero extra software needed.
- **It serves HTTPS on port 80** (`SSLPort='80'`) with a self-signed certificate → base URL `https://192.168.100.1:80`, needs certificate checking switched off.
- **The admin password is unavoidable.** Of 17 unauthenticated addresses tried, only the login token returns 200; everything else 403. **Important:** those 403s prove only that pages are *locked*, **not** that any given page exists.
- **The web UI is the only door.** Port 80 open; 22/23 filtered; 443/161/7547/37215/8080/8443 closed; SNMPv2c silent on `public` and `admin`. No SSH, no Telnet, no SNMP, no TR-069.
- **Caution flag RETIRED.** The nearby HG8145X6 project only ever found per-**LAN-port** counters (which would miss Wi-Fi). Not the case here: these are **whole-WAN totals**, so Wi-Fi traffic is included.
- **Security note:** the WAN pages carry `X_HW_IPoEPassword` (the broadband password) and session tokens. Any tool that writes a report **must scrub secrets first** — both probe tools do, and their self-tests prove it.
- **The tools:** `helper/tools/check-huawei-router.cmd` (first sweep, wraps `probe-huawei.js`) and `helper/tools/check-huawei-data-counters.cmd` (deep read, wraps `probe-huawei-stats.js`). Both are look-only — GET only, refuse any address matching set/del/reset/reboot/… — ask for the password **in the user's own console window** so it never enters chat, disclose the 3-try ≈1-minute lockout and the single-admin-session side effect, and write scrubbed reports beside themselves. Self-tests: `selftest-huawei-probe.js` **15/15**, `selftest-huawei-stats.js` **28/28**.
- **Lesson learned four times — worth keeping.** Every wrong answer here came from assuming a vendor's exact spelling or over-matching: one tool required at least one character before `Bytes`, so a field named exactly `BytesSent` slipped past; another expected a constructor called `stWanStats` when the real one is `WaninfoStats`, so it printed a falsely cautious "ALMOST"; a third pattern swallowed the whole of `new Array(new WaninfoStats(...))` and stepped straight over the inner constructor — stop at the opening bracket instead. The fourth: applying the statistics layout to records from *other* constructors, which printed confident nonsense like `PacketsSent = AlwaysOn`. **Match broadly, filter by meaning, check which constructor a record came from, and dump short pages verbatim.**
- **✅ APPROVED AND BUILT (2026-09-18).** The user approved it: *"yes build the huawei collector."* The reader now exists — see **Step 2c** below. (The old line here said "do NOT build without asking"; that is spent.)

**Step 2c — The Huawei reader, and catching up after the PC was off. ✅ DONE 2026-09-18.**
The fibre line now reports **Live** usage instead of Sample. Two pieces:

- **The reader:** `helper/engine/collectors/huawei-hg8145x7.js`, registered **first** in `helper/engine/collectors/registry.js` so auto-detect tries it before the ZTE/ZLT readers. The dashboard already sends `collectorId: 'auto'`, so **no dashboard change was needed**. It signs in the `CfgMode='MTN'` way decoded in Step 2b, reads `wan_list_info.asp` for the field layout, then `get_wan_list_pppwanstat.asp` (falling back to the IPoE sibling) for the values, and zips the two together. `BytesReceived` → download, `BytesSent` → upload. Tries **HTTPS first, then plain HTTP**, and remembers which worked per box. It keeps one signed-in session (the box allows a single admin at a time and locks out for ~1 minute after 3 bad tries) — that session is **tied to a fingerprint of the password**, so a later wrong password can never ride on an earlier good one. `uptimeSeconds` is reported as **null**, not guessed, because no uptime field has been identified on this box.
- **Catching up while the helper was off — the user's explicit requirement:** *"if the helper is off and the router is on, when the router comes back on I want it to read everything that happened while it was off and then update it."* The router counts all the time, so the difference between the last stored reading and the new one **is** the usage for the whole gap, however long. `helper/engine/domain/counter-accounting.js` shares that difference out across **every day in between** in proportion to how much of the period fell on each day, so a three-day gap fills in three days — not one giant spike on the day you switched the PC back on. The last reading survives a restart because the whole state is saved to disk, and the helper takes a reading **immediately on launch**.
  - **Backwards counters no longer bin the gap.** Previously any drop threw the whole period away. Now `accountDirection()` decides between two honest stories: **rolled over** (the 4.29 GB field filled up — credited as room-left-at-the-top + the new reading; only ever accepted when the reader declares `counterWrapBytes`, only one direction moved backwards, and the old value sat in the **top quarter** of the range) or **restarted** (the meter genuinely began again — credits the new reading and marks that day a **MINIMUM**, with the record's `confidence` set to `observed-minimum` and a plain-words "AT LEAST this much…" note). A multiple roll-over is never invented. ZTE/ZLT declare no `counterWrapBytes`, so they can never wrap-repair — but they too now credit a restart instead of discarding it.
  - **⚠️ CORRECTED 2026-09-21 — a roll-over is only exact if the gap was short.** The code above credited one lap and called the figure exact no matter how long the helper had been off. On this line the 4.29 GB field fills in **about 15 minutes** of flat-out use, so over a gap of hours it can go round many times and nothing the router sends says how many. Certainty is now settled by arithmetic, not assumption: `fastestPlausibleBytesPerSecond()` takes the fastest speed this line has **ever actually been measured at** (from `settings.speedTests`), doubles it for headroom, and multiplies by the length of the gap. If even that cannot fill the counter a second time, one lap is the only possibility and the figure is **exact**. Also corrected: `counterWrapConfirmed` on the Huawei is now **`true`** — the highest value ever seen on the real box is 4,228,720,449 (98.5% of 2³²), nothing ever reached 2³², and a wrap was then observed.
  - **✨ BEST ESTIMATE for long PC-off gaps (2026-09-21, user asked for it directly).** When a gap is long enough that the meter could have gone round more than once, crediting only the single provable lap badly *undercounts* (one lap ≈ 4.29 GB, but a real day is ~30 GB ≈ 7 laps). So the helper now **estimates the most likely number of laps** from how much this line *normally* moves in a day: `typicalBytesPerSecond(state, direction)` averages the **confidently-measured** days only (`confidence === 'observed'` — never other estimates or minimums, so a guess never feeds on a guess), per direction, since download and upload wrap independently. `estimateBytesAcrossWraps()` picks the whole number of extra laps whose total lands closest to *typical rate × gap*, capped by what the link could physically have carried. That day is labelled **`observed-estimate`** (a new confidence level, distinct from `observed-minimum`) with an "ESTIMATE:" note, and the **provable one-lap floor is kept alongside** it in the event as `minimumDownloadBytes` / `minimumUploadBytes`. **Crucial honesty guard:** if there is **no** confident history to lean on, it does NOT invent a number — it falls back to the bare one-lap **minimum**. And while the PC is *on*, the counter is read every 3 minutes vs a ~15-minute fill, so wraps are caught exactly and no estimation happens at all. The dashboard draws estimate days as a **hollow dashed bar with a `~`**, minimum days with a **dashed cap**, and unmeasured days as **hatched gaps** — three visibly different things.
  - **Honest caveat:** catch-up runs on its own at launch **only if "Remember my password on this PC" is ticked** (opt-in, off by default). Otherwise it happens the moment you click **Sync** once.
- **Tested:** `helper/test/selftest.js` **PHASE H** runs the reader against a pretend Huawei box (`startFakeHuawei` in `helper/test/fake-router.js`) and checks: auto-detect, direction not swapped, 10-of-14 fields with no invented halves, baseline, a **3-day gap filled across 4 days totalling the full 8 GB**, a **short-gap** roll-over repaired as an exact figure, a **long-gap** roll-over credited but labelled a minimum, a genuine restart labelled a minimum, a wrong password rejected, session reuse, and the ZTE reader unchanged. Whole suite: **66/66**.

**Step 2d — Audit of everything the dashboard reads. ✅ DONE 2026-09-21.**
Prompted by: *"you are reading the device connected wrongly and if you are reading that wrongly, check every other thing you are reading wrongly."* Nine defects were confirmed against the real data file and fixed. The common root cause: **the helper remembers the last-known device list and signal, and the page never checked how old they were or which router produced them** — so readings from the retired ZLT box kept rendering with a green "Live" badge, breaking the hard rule in §8 about labelling Live / Manual / Sample.

- **Server:** `liveTick` in `helper/server.js` now stamps devices/signal with `sourceId`, `routerIp` and `observedAt`.
- **Page:** `freshFromActiveRouter()` requires a reading to be **under 15 minutes old** AND to come from the router in use now; `whyNotLive()` explains the fallback in plain words. Applied to the devices panel and the 5G signal strip.
- **Daily chart:** `series.slice(-30)` took the last 30 **records**, not the last 30 **days**, so an 11-day hole in the history was drawn as if two distant days were neighbours. It is now a real calendar window, with **hatched bars** for days nobody measured and the trend line **broken** across them instead of drawn through them.
- **"Used today":** showed a green Live **0 GB** when the router simply had not been read yet today. Now shows **—** and says when the last reading was.
- **New caveat block** under the run-out prediction: how many days of the cycle were never measured, which days are minimums, and — importantly — that the cycle total currently **adds up two different connections** (the old 5G line and the new fibre line), because the router changed part-way through the month.
- **Checked and found correct:** speed tests already discard failed download measurements; reliability only claims Live after real observation, and uptime % is over **observed** time only.
- **Rule worth keeping:** a remembered "last known" value is not a live reading. Anything shown as Live must prove both **freshness** and **which box it came from**.

**Step 2e — Connected-devices panel goes Live. ✅ DONE 2026-09-23.**
The fibre box **does** list who is attached, so the "Connected devices" panel now shows **real devices** instead of sample ones — but **names + IP + MAC + online/offline ONLY**. The box carries **NO per-device byte figure**, so "how much each device used" can never come from it (the panel says so in plain words, and still shows per-device bars only in Sample mode).

- **The endpoint:** `GET /html/bbsp/common/GetLanUserDevInfo.asp` — a ~7 KB page listing each attached device. Confirmed live on the real box (3 devices). Three real-box quirks the reader handles: (a) MACs/IPs are written with JavaScript hex escapes (`\x3a`=":", `\x2e`=".", `\x2d`="-") and must be decoded before any pattern matches — undecoded, the page reads "0 devices"; (b) rows mix quoted text with bare unquoted numbers; (c) each device is listed up to **three times** (the array is defined twice in an `if/else`, and a separate `WifiWorkingModes` array repeats every MAC in upper case) — deduped by `mac.toLowerCase()`.
- **The reader:** the device-parsing logic lives in `helper/engine/collectors/huawei-hg8145x7.js`. `collect()` reads the device page **best-effort as a final step** — if it fails, the usage sync is completely unaffected (devices are a bonus, never a requirement). `sync-service.js` stamps the stored device list with **which router produced it** (`sourceId` + `routerIp`) and **when** (`observedAt`), so the dashboard's freshness+source gate from Step 2d lets it through only when it is fresh (≤15 min) AND from the router in use now — a stale list from the retired ZLT box can never show as Live.
- **No dashboard change was needed** — the page already knew how to render a Live device list (name + IP + MAC + count, with the "no per-device GB" note). **No fast poll was added** — devices refresh on a full Sync/refresh, not every few seconds, because the box allows only one admin session at a time and rapid polling would lock the user out of the router's own page.
- **Tested:** `helper/test/selftest.js` PHASE H now also reads the device list off the pretend box (which serves the exact real-shape escaped, triple-listed page): decodes the escapes, dedups to 3 devices, counts 2 online (one TV offline), confirms the source/time stamp, and confirms no per-device usage is invented. Whole suite: **72/72**.

**Step 3 — Build the small "helper" program.**
Adapt WiFiWatch's ZTE reader into a helper that runs on my **always-on computer**, logs into the router, reads the data counters, works out **daily usage + uptime**, and **writes those numbers into the dashboard file** — so opening the dashboard shows current stats. Keep the dashboard self-contained (no internet needed to view it).

**Step 4 — Schedule + guide.**
Make the helper run **on a schedule** (e.g. a few times a day) and write a **plain-language setup guide**: what to install, how to run it, and how to stay safe with the router password.

---

## 8. Honest constraints & gotchas to remember

- The helper only updates **while its computer is on** (otherwise there are harmless gaps in the data).
- Real **speed-test** numbers **cost data** to measure; the router's **"rated" speed** is free but only theoretical. Choose based on preference.
- Reading the router needs its **admin password** — that's the **router box's own password** (often printed on the sticker, sometimes just `admin`). It is **NOT** my bank or MyMTN password. Keep it local; **never hard-code a password into a file that might be shared.**
- Always keep labelling which panels are **Live vs Manual vs Sample**, so I never mistake sample numbers for real ones.

---

## 9. Files in this project

- **`mtn-fibrex-dashboard.html`** — the dashboard. Open it by double-clicking; it works offline.
- **`wifiwatch-engine-reference/`** — the open-source WiFiWatch code we're borrowing the router-reading engine from (MIT, credit Sagenoya). Reference material.
- **`CLAUDE.md`** — this file.

---

## 10. Mini-glossary (plain terms)

- **HTML file:** the web page itself — a document a browser opens.
- **SVG:** a way to draw shapes (bars, lines, circles) directly inside a web page, so charts need nothing from the internet.
- **CDN / "loading from the internet":** fetching code from an outside website while the page opens. We avoid this so nothing can fail to load.
- **API:** an official way for one program to request data from another. MTN has **no** usable one for home usage.
- **Router:** the MTN box in my home. It has its own settings page at an address like `192.168.1.1`.
- **Helper / collector:** a small background program on my always-on computer that reads the router and updates the dashboard.
- **localStorage:** a small memory built into the browser where the page can save my typed settings so they're remembered next time.

---

## First prompt to paste into Claude Code

> Read `CLAUDE.md`. I'm a complete beginner — explain things simply and go step by step.
> Let's do **Step 1**: add a **Settings panel** to `mtn-fibrex-dashboard.html` where I can enter my plan name, monthly price, data cap (or unlimited), renewal date, wallet balance, router address and model, and log daily usage — all **saved in my browser** so it's remembered.
> Keep the file **fully self-contained** (charts drawn in SVG, nothing loaded from the internet), and clearly label each panel as **Live / Manual / Sample**. Tell me in plain terms what you changed.
