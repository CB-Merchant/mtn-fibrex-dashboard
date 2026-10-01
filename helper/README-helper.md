# The Helper — plain-language setup & safety guide

This little program is the **"hands"** of your dashboard. A web page is not allowed to
log into your router by itself (web browsers block that on purpose, for safety). So this
helper does that part **on your own computer**: it logs into your MTN router, reads the
usage counters, works out your daily usage, and hands the numbers to the dashboard.

You only need it for **Live** data. The dashboard still opens and works without it — it
just shows **Sample** numbers and anything you typed in **Settings** (**Manual**).

---

## What you need (one time)

1. **Node.js** — a free program that runs the helper. You already installed it. If you
   ever move to a new computer, get it from **https://nodejs.org** (click the big **LTS**
   button), install it, then **restart the computer once** so Windows notices it.

That's it. **There is nothing to download or "npm install".** The helper uses only the
parts that come built into Node, so it works offline too.

---

## How to start it

1. Open the **`helper`** folder.
2. **Double-click `start-helper.cmd`.**
3. A black window opens and says *"local helper is now running"*. **Leave this window
   open** while you use the dashboard. (Closing it, or pressing **Ctrl+C**, stops the
   helper — that's how you turn it off.)

If Windows ever asks about firewall access, **Allow** is safe — the helper only listens
on *this* computer (`localhost`), not the wider internet.

---

## How to use it (the dashboard)

You can open the dashboard **either way** — both work:

- **Easiest:** in your web browser, go to **http://localhost:8947** (this is the dashboard
  *served by the helper*, so they're already connected).
- **Or** just double-click **`mtn-fibrex-dashboard.html`** as before. It will find the
  helper automatically if it's running.

Then:

1. Click **🔌 Sync router** at the top (or open **Settings** → the **Router** panel).
2. **Choose your router:**
   - **192.168.100.1** — MTN **FibreX ONT** (Huawei) ← common on FibreX fibre lines
   - **192.168.1.1** — MTN **FibreX** / Indoor Gateway (ZTE)
   - **192.168.0.1** — MTN **5G ODU** (ZLT)
   - **Other** — type your own address if none of the above is yours

   **Not sure?** Open **Command Prompt** and type **`ipconfig`**. The number beside
   **"Default Gateway"** is your router's address — that's always the right answer.
3. Type your **router admin password** (see safety note below — often **`admin`**).
4. Click **Sync Router.**

The panel turns **green**, shows your **detected router model**, and the usage numbers
start going **Live**.

---

## What's Live vs what you still type

| Shown as | What | Where it comes from |
|---|---|---|
| 🟢 **Live** | Daily usage, "used today", data left this cycle, run-out prediction; **connected devices**; **current 5G signal & speed**; **download/upload speed history**; **uptime % & the outage list** | Read from your router by the helper (speed history comes from the scheduled speed tests below; uptime comes from the always-on connection monitor below) |
| 🔵 **Manual** | Plan name, price, wallet, data cap, renewal date | You type these in **Settings** |
| 🟡 **Sample** | Monthly history (until real months build up), and anything your particular router doesn't report | Demo numbers, shown only until real data exists |

The dashboard is **honest**: a panel only turns 🟢 Live if your router actually gives that
number. If it doesn't, the panel stays 🟡 Sample rather than show a made-up figure. (For
example, the **5G signal** panel is Live on the **5G ODU (ZLT)** box; on some gateways it
may not be available, and then it simply stays Sample.)

**🟢 Live also means "recent, and from the router you use now".** A panel will *not* claim
to be Live just because the helper once saw that number and wrote it down. Two things have
to be true:

1. the reading is **less than 15 minutes old**, and
2. it came from **the router the helper is talking to now** — not one you've replaced.

If either fails, the panel drops back to 🟡 Sample **and tells you why**, in plain words —
for example *"Last read 14 days ago — too old to show as live"*, or *"Your old router
reported connected devices; MTN FibreX • Huawei HG8145X7 does not."* This matters: a made-up
number labelled Sample is harmless, because you can see it's an example. An **old** number
wearing a green Live badge would fool you, and that's exactly what you must never have to
worry about here.

The same principle applies to days with no reading at all. A day the helper never measured
is **not** counted as "0 GB used" — it's drawn as a **striped gap** on the daily chart, left
out of averages, and counted up for you underneath the run-out prediction ("13 days of this
cycle were never measured"). Empty is not the same as zero.

**The "extra" Live things:**

- **Connected devices** — a live list of what's on your Wi-Fi right now (device name, IP
  and MAC). Note: your router reports *which* devices are connected, **not how much data
  each one used** — so there are no per-device GB figures, and the dashboard says so plainly.
- **Current 5G signal & speed** — for the 5G ODU (ZLT): signal strength (RSRP / RSRQ /
  SINR), the band in use, and the "right now" download/upload rate. A quick health check.
- **Speed history** — real **download/upload speed tests** run on a schedule (see below).
- **Uptime % & outages** — an always-on **connection monitor** quietly checks whether your
  internet is actually reachable and records any real outages, so the **Reliability** panel
  and the **Uptime · month** figure are honest. It has its own section below.

**Important — what's instant vs. what builds up:**

- **Instant on the first sync:** connection confirmed, your **router model**, whether
  you're online, the **connected-device list**, and (on the 5G box) the **current signal**.
- **Builds up over the next hours/days:** the **daily-usage bars**, **"used today"**, the
  **run-out prediction**, and the **speed history**. This is normal: your router only
  reports a *running total* of data, so a real "per day" figure comes from the
  **difference between two readings** over time. **Leave the helper running** and a full
  picture fills in. The dashboard says *"1 day so far…"* until it has more.

The router can't know your **plan, price, wallet or cap** — so those always stay
**Manual** (you type them once a month in Settings).

---

## Automatic refresh

After your first Sync, the helper keeps re-reading the router on its own — **but only
while its window is open** — on two schedules:

- **Connected devices + 5G signal: every few seconds.** These change moment to moment, so
  the helper reads *just* those on a fast loop (reusing one login). The dashboard shows a
  steady **● Live** and the **device count changes within seconds** of something joining or
  leaving your Wi-Fi — no reload, no clicking, and **no "synced N minutes ago"**.
- **Everything else (usage, "used today", etc.): every few minutes.** These only move when
  the router's running totals change, so there's no need to read them as often.

Both are **local reads on your own network — they cost no MTN data.** (Only the scheduled
*speed tests* and the tiny *connection checks* — both described below — use any data.) If
the computer sleeps or the window is closed, readings pause — but **the usage is not lost**;
the next reading fills the whole gap back in (see the next section). To start again you click
**Sync** once — **or**, if you turn on the two "always-on" options below, the helper starts
itself and resumes with **no clicks at all**. You can untick *"Keep refreshing automatically"*
if you'd rather sync by hand — that turns off **both** loops and forgets the password.

---

## If your PC was off while the internet kept running

This is the important one, and it is worth understanding because it is the difference
between a dashboard you can trust and one full of holes.

**Your router counts all the time.** It doesn't care whether your computer is on. It keeps
one big running total — like the odometer in a car, which keeps climbing whether or not
anybody is writing the mileage down.

So the helper doesn't need to have been watching. It only needs **two readings**:

> *"Last time I looked, the odometer said 1,200 GB. Now it says 1,208 GB.
> So 8 GB went through in between — no matter how long 'in between' was."*

**What that means for you, in practice:**

- **Switch the PC off for three days.** Turn it back on, and the very next reading picks up
  all three days of usage. Nothing is missed.
- **It's spread over the right days, not dumped on today.** If 8 GB went through over three
  days, the helper shares it across those three days rather than drawing one giant spike on
  the day you came back. Your daily bars stay sensible and your daily average stays true.
  (It shares it out evenly by time — it has no way to know if Tuesday was busier than
  Wednesday, and it doesn't pretend to.)
- **It remembers across restarts.** The last reading is written to disk
  (`helper/data/data_history.json`), so closing the helper — or restarting Windows — doesn't
  lose your place.
- **It reads the moment it starts.** You don't have to wait for the next scheduled check.

**The one thing you should know:** for this to happen **completely on its own** when the PC
boots, the helper needs to be able to log into the router without you — which means ticking
**"Remember my password on this PC"** in Settings. If you leave that off (it's off by
default, which is the safer choice), nothing is lost — the catch-up simply happens **the
first time you click Sync**.

### When the router's own meter goes backwards

Occasionally the running total *drops*. There are only two honest explanations, and the
helper now tells them apart instead of giving up:

- **It filled up and rolled over.** The box stores the total in a slot that holds about
  4.29 GB, so when it fills it goes back to zero and carries on — like an odometer rolling
  past 999,999. The traffic really happened, so the helper adds *the room left at the top*
  plus *the new reading*. It only accepts this explanation when the old number was already
  near the top and only one direction dropped, so it can't be fooled.
- **The meter genuinely restarted** (the line reconnected, or the box rebooted). Then
  whatever ran just before the restart is gone — **nobody** recorded it, not the router and
  not the helper. The helper credits what it *can* prove and labels that day **"at least
  this much"**, in those words, rather than quietly pretending it's an exact figure.

Either way it **never throws the period away**, which is what it used to do. If you see a
day marked *"at least this much"*, that's the helper being straight with you: the real
number for that day was that much **or more**.

**One more thing about rolling over, and it matters.** That 4.29 GB slot is small. On a
fast line it fills up in roughly **a quarter of an hour**. So:

- If the helper was running and took its readings a few minutes apart, the meter can only
  have rolled over **once** in between — there simply wasn't time for more. The figure is
  **exact**.
- If your PC was off for hours, the meter had time to fill up and roll over **again and
  again**, and nothing the router sends says how many times.

The helper works out which case you're in with arithmetic, not guesswork: it takes the
**fastest speed your line has ever actually been measured at** (from the speed tests),
doubles it to be generous, and asks whether even that could have filled the slot a second
time during the gap. If it couldn't, only one lap was possible and the number is **exact**.

**When more than one lap was possible, the helper gives you its best estimate.** Adding only
the single lap it can strictly prove would badly *undercount* — one lap is about 4.29 GB, but
a normal day on this line is more like 30 GB, which is about seven laps. So instead of pretending
a busy day was 4 GB, the helper looks at **how much data you normally move in a day** (averaged
from the days it measured properly, download and upload counted separately), works out the most
likely number of laps for the length of the gap, and fills that in. That day is marked with a
little **`~`** (meaning "close estimate, not an exact count") and the dashboard says so in plain
words. Underneath, it still keeps the one lap it can *prove* as the rock-bottom floor.

The one thing it will **never** do is guess out of thin air: if it has no properly-measured
days to learn your normal usage from, it does **not** invent a figure — it drops back to the
provable one-lap **minimum** and marks that day *"at least this much"*. And while your PC is on,
the helper reads the meter every few minutes against a 15-minute fill, so wraps are always caught
exactly and none of this estimating happens at all. So a long spell with the PC off is still
counted — as an exact figure when it can be, a clearly-marked best estimate when it can't, and
never just thrown away.

---

## Your fibre box is read directly (Huawei HG8145X7)

Your MTN FibreX box at **192.168.100.1** is read by the helper directly — you don't have to
do anything for this, and you don't need to pick your model. When you click **Sync**, the
helper tries each router it knows until one answers, and recognises yours automatically. The
dashboard will say **Huawei HG8145X7**.

A few honest notes about this particular box:

- **The figures include Wi-Fi.** These are the totals for your whole broadband connection,
  not just the network cable — so phones and laptops on Wi-Fi are counted.
- **It reports usage, but not "how long have you been connected".** The box simply doesn't
  publish that number anywhere the helper could find, so rather than guess, the helper leaves
  it blank. Your **uptime %** comes from the separate connection monitor below instead, which
  is the more truthful source anyway.
- **One admin at a time.** The box only allows a single person signed into its settings page.
  If you open **192.168.100.1** in your browser while the helper is running, one of you may
  get bumped out. Nothing breaks — the helper just signs back in.
- **Three wrong passwords locks it for about a minute.** That's the router doing it, not the
  helper. If you mistype, wait a minute and try again.
- **It's the router's own admin password** — the one on the sticker, often `admin`. **Not**
  your bank password and **not** your MyMTN password.

---

## Uptime & outages — the always-on connection monitor

The **Reliability** panel (the big uptime ring + the outage list) and the **Uptime · month**
figure at the top are powered by a small **connection monitor** that runs the whole time the
helper is open — **on by default**, no setting to switch on.

**How it decides you're up or down.** Every ~30 seconds it quietly asks two or three big,
always-there internet addresses "are you reachable?" (the same tiny "no-content" check your
phone uses to spot a captive Wi-Fi portal). If **any** answer comes back, you're **up**. If
**all** of them fail, it then pings your **router**:

- Router answers but the internet doesn't → labelled **"service"** (your MTN line is down,
  but your box and power are fine).
- Router doesn't answer either → labelled **"router / power"** (the box, its power, or this
  PC's link to it dropped).

**It doesn't cry wolf.** A single failed check is ignored — the line has to fail **twice in
a row** before an outage is opened (and it's then **backdated** to the first failure, so the
duration is honest). One good check closes it.

**It only counts time it actually watched.** The uptime % is *up-time ÷ time-observed*, and
"time-observed" excludes any stretch where the **PC was asleep or the helper was closed** —
those gaps are **unknown**, never counted as up *or* down. That's why the panel says
*"over 3 days watched"* rather than pretending to know about hours it wasn't running. If an
outage is still open when the helper stops, it's closed at the **last moment it actually
saw**, not stretched across the dark. Each new billing cycle starts the window fresh.

**Cost.** These checks are tiny — a few bytes each, on the order of **a few MB a month** —
but since you asked for full monitoring regardless of data, it simply runs. (If you ever
wanted it off, starting the helper with `set UPTIME_ENABLED=0` before `node server.js` turns
just this monitor off; the Reliability panel then falls back to 🟡 Sample.)

---

## Keep it running 24/7 (optional)

Out of the box the helper only reads your router **while its black window is open and you're
signed in**, and it asks you to click **Sync** once after each restart. If you'd like it to
just keep going by itself on a PC that stays on at home, turn on **both** of these:

1. **Remember the password on this PC.** In **Settings → Router**, tick **"Remember my
   password on this PC"** *before* you click Sync. Now the helper can log into the router
   again on its own after a reboot — no browser, no Sync. (See the honest caveat under
   **Safety** below: it's scrambled and tied to this computer, but not strong encryption —
   use only on a PC you trust. Undo any time with **"Forget saved password"**.)
2. **Start the helper when Windows starts.** In the `helper` folder, **double-click
   `install-autostart.cmd`** once. From then on the helper launches automatically each time
   you sign in, opening **minimized** in the taskbar. To undo, double-click
   `uninstall-autostart.cmd`.

With both on, the flow after any restart is: Windows signs in → the helper starts itself →
it reads the saved password → it logs into the router and goes **Live** again — all with
**zero clicks**.

**Honest caveats:**

- It starts **after you sign in to Windows**, not at the lock screen. If your PC reboots and
  waits at the sign-in screen, the helper waits too (until you sign in). For truly
  before-login running you'd use Windows **Task Scheduler** ("Run whether user is logged on
  or not") instead — more involved, and not needed for most home setups.
- It still only runs **while that PC is on**. A laptop that sleeps or a PC that's shut down
  can't read the router — you'll just get harmless gaps, which the dashboard shows honestly.
- **This has to run at home.** Your router lives on your **private home network**
  (`192.168.x.x`), which no outside "cloud" server can reach — so the reader must be a
  computer **on your own Wi-Fi**. That's why there's no "host it online so it's always up"
  option: the always-on computer simply needs to be one of yours, at home.

---

## Speed tests — and their small data cost

Your router tells the dashboard *how much* data you've used, but **not how fast** your
line is. The only honest way to show a real speed is to **measure it** — download and
upload a small chunk and time it. That measurement itself **uses a little data** (about
**33 MB** per test).

- By default the helper runs one **every 6 hours** (about **4 GB a month**).
- Change this in **Settings → Speed tests**: *Twice a day* (~2 GB/month), *Once a day*
  (~1 GB/month), or **Off** (only when you press the button).
- There's always a **"⚡ Run a speed test now"** button for a one-off check.
- Results feed the **"Speed vs your plan"** panel and are tagged 🟢 **Live**.

If the helper isn't running, the button is disabled and that panel stays 🟡 Sample.

---

## Safety — please read once

- The **router admin password** is the **router box's own password** — often printed on
  the **sticker** on the box, or just **`admin`**. It is **NOT** your bank password and
  **NOT** your MyMTN app password.
- Your password goes **only to the helper on this computer** (`localhost`). It is
  **never** sent to the internet. Your **usage file** (`data/data_history.json`) holds your
  usage numbers and settings (and, when read, the connected-device list and signal
  readings) — but **never your password**.
- **By default the password is kept in memory only**, and is **forgotten the moment you
  close the helper window.** Nothing is written to disk.
- **Optional — "Remember my password on this PC":** off by default. If you tick it (during
  Sync), the helper saves the password to a **separate file** (`data/.router-credential`)
  so tracking can **resume by itself after a restart** without you opening the browser.
  Honest caveat: it is **scrambled and tied to this computer and sign-in account, but that
  is not strong encryption** — someone with access to this signed-in account could recover
  it. So use it **only on a PC you trust and keep to yourself**, never a shared one. Remove
  it any time with **"Forget saved password"** in Settings (or by turning off *Keep
  refreshing automatically*) — that deletes the file immediately and stops Live.
- Nothing here is loaded from the internet, so the dashboard keeps working offline.

---

## If something doesn't work

- **"Helper not running / not detected"** → double-click `start-helper.cmd` and keep its
  window open, then reload the dashboard.
- **"Router password looks incorrect"** → check the sticker on the router; try `admin`.
- **"Could not reach the router"** → make sure this computer is on the **same Wi-Fi/router**,
  and that you picked the right gateway. **The reliable way to find it:** open **Command
  Prompt**, type **`ipconfig`**, and use the number beside **"Default Gateway"** (paste it
  into the **Other** box). FibreX ONTs are often **192.168.100.1**, some gateways
  **192.168.1.1**, and MTN 5G is **192.168.0.1**.
- **"No supported router detected"** → the helper reached a box but doesn't know how to read
  it. It currently speaks two routers: the **ZTE F6600P** (FibreX) and the **ZLT X17U** (5G
  ODU). Other models — including **Huawei HG8145X7** ONTs — answer on the network but don't
  yet have a reader, so usage stays 🟡 Sample. The **uptime/outage monitor still works**
  (it doesn't need the router).
- **"Port 8947 is already in use"** → the helper is probably already running in another
  window — use that one. (Advanced: start on another port with
  `set PORT=8948 && node server.js`, then open `http://localhost:8948`.)
- **Charts look blank** → they shouldn't ever, because they're hand-drawn inside the page.
  If they do, reload; and confirm the file wasn't edited to load anything from the
  internet.

## To stop the helper

Close the black window, or press **Ctrl+C** inside it. The dashboard falls back to your
saved (Manual) details and Sample numbers — nothing is lost.

---

## Your Huawei box — the "can it even tell us?" tools

**You don't need these any more** — the answer turned out to be **yes**, the box does publish
running data totals, and the helper now reads them for you automatically (see the section
above). These two tools are kept for troubleshooting: if usage ever stops updating, they
tell you whether the box is still answering and still showing numbers.

Your fibre line runs through a **Huawei HG8145X7** ONT at **192.168.100.1**. Every page on it
is locked behind the admin password, so the only way to look is to log in.

There's a look-only tool for exactly that. In `helper/tools/`, **double-click**:

```
check-huawei-router.cmd
```

It asks for the router's username (usually `root`) and password **in its own window** — the
password never goes into a chat, a file, or the internet. Then it reads pages and prints a
plain answer: **GOOD NEWS** (it found running totals), **MIXED**, or **NOT PROMISING**. It
saves the detail to `tools/huawei-probe-report.txt` next to itself.

**What it will and won't do:**

- It only **reads** (plain page requests) and deliberately **skips any address that looks
  like it changes a setting** — nothing on your router is altered.
- Your router **locks logins for about a minute after 3 wrong tries**. The tool makes **one
  attempt** and tells you where you stand.
- Huawei boxes allow **one admin session at a time**, so this may sign your browser out of
  the router page. Harmless — just log back in.
- The password is the **router box's own** password (usually on its sticker) — **not** your
  bank or MyMTN password. It is never written down anywhere.

You can prove the tool itself works, against a pretend Huawei, with no real router and no
password:

```bash
node test/selftest-huawei-probe.js
```

You should see **ALL CHECKS PASSED (15 checks)**.

### Step 2 of the check — read the counters properly

The first check came back **MIXED**, but that headline undersold it. The report showed your
box's WAN pages do use **`BytesSent`** and **`BytesReceived`** — the running data totals we
need — the first tool just peeks at the first few mentions per page, and on a
74,000-character page the real numbers sit further down.

So there's a follow-up tool. Same folder, **double-click**:

```
check-huawei-data-counters.cmd
```

It goes back to only those specific pages, reads them **in full**, prints every byte field
and its value, and answers **YES / ALMOST / NOT FOUND**. Detail goes to
`tools/huawei-counters-report.txt`.

Same promises — look-only, refuses any address whose name suggests it changes a setting,
password typed into that window only and never saved. **One addition:** because broadband
pages carry your **PPPoE password and Wi-Fi key**, this report is **scrubbed** — anything
password-like becomes `***hidden***` before it is written to disk. Byte totals are plain
numbers, so they survive.

Prove it against a pretend Huawei (no router, no password):

```bash
node test/selftest-huawei-stats.js
```

You should see **ALL CHECKS PASSED (28 checks)**.

### The answer, from your own box — YES

You ran it on 2026-09-16 and it worked. Your Huawei box **does keep a running data total**,
which means a real Live usage reader for the fibre line is possible.

Here is what it found, in plain terms:

- There's a tiny page on the box — `get_wan_list_pppwanstat.asp`, about 231 characters —
  that hands out the current totals. Nothing links to it from the router's menus; the tool
  found it by reading the router's own code and following where it fetches from.
- That page sends only **numbers, with no labels**, like `"896319260","1689502191",…`. The
  labels live on a different page, which states the order once. Put the two together and
  the numbers get their names back:
  - **uploaded so far: 896,319,260 bytes** (about 0.83 GB)
  - **downloaded so far: 1,689,502,191 bytes** (about 1.57 GB)
- **The real proof is that the numbers went UP between the two runs.** Minutes earlier they
  read 858,601,123 up and 1,672,972,618 down. So in that gap the box counted **+36 MB
  uploaded and +15.8 MB downloaded** — which is exactly how the dashboard would measure
  usage: read the total now, read it again later, subtract.

**A correction to something I told you earlier.** I said the box publishes the total in
**two halves** (a "high" part and a "low" part) and that any reader *must* add them together.
**That was wrong.** The router's own code *lists* fourteen values, but when you actually ask
it, only **ten** come back — the four "half" values are never sent. So a reader gets one plain
number per direction and nothing to add to it. What it must do instead is **cope with the
number going backwards**: if the total ever drops, that's the counter starting over, not
negative usage. Handily, the helper's always-on connection monitor can tell you *why* it
dropped — if it saw no outage, the counter simply rolled over at about 4 GB and 4 GB should be
added back; if it saw an outage, the line genuinely reconnected and the new number is a fresh
zero. (I also misread some `4294967295` values as proof of that 4 GB limit. They sit next to
settings like "always on" and mean "unlimited / not set" — nothing to do with counters.)

- **Why the two figures look small** for a line that uses ~520 GB a month: most likely your
  broadband reconnected recently and the count started over. That's unconfirmed — and it
  doesn't matter for usage, because usage comes from the *difference* between two readings,
  not from the absolute number.

**Nothing has been built yet.** Reading the box is now proven possible; turning it into Live
numbers on the dashboard is a separate job, and it's your call whether to do it.

One honest note about the tool: it first printed **"ALMOST"** even though the numbers were
right there in its own report. It was looking for a name Huawei doesn't use (`stWanStats`;
your box calls it `WaninfoStats`). That's now fixed, and there's a test using your box's exact
wording so the same kind of miss can't come back quietly. A second, smaller flaw is fixed too:
the tool was putting byte names onto records from *other* parts of the router, printing
nonsense like "PacketsSent = AlwaysOn". It now checks where a record came from first.

### What we already know about this box (so nobody re-treads it)

- **Logging in is solved and coded.** Its login page uses `CfgMode = 'MTN'`, which takes the
  simple path: ask `/asp/GetRandCount.asp` for a one-time token, then post `UserName`,
  `PassWord` as **plain base64**, `Language=english` and `x.X_HW_Token`. No extra software
  needed.
- **The password is unavoidable.** Of 17 addresses tried without logging in, only the login
  token replies; everything else returns "forbidden". *(Note: those refusals prove only that
  the pages are locked — **not** that any traffic page exists.)*
- **The web page is the only door.** A port sweep found **80 open** and 22/23 (SSH/Telnet),
  443, 161 (SNMP), 7547, 8080, 8443 all shut or silent; SNMP answered nothing on `public` or
  `admin`. So there is no back way in to try.
- **It serves HTTPS on port 80** with its own self-signed certificate — hence the tool's
  `https://192.168.100.1:80`.
- **Caution flag:** the closest public project on the same family (an **HG8145X6-10**) reads
  its ONT over **SSH**, and its parsers pull out link status, VLAN and MTU — **no byte
  counters**. The only counter-ish command there is per-**LAN-port**, which would miss all
  Wi-Fi traffic. *(This flag has now been largely overtaken: the first probe run on the real
  box showed its own WAN pages using `BytesSent` / `BytesReceived`, which is a whole-line
  total, not per-port.)*
- **First real run, 2026-09-16 — what came back:** signed in as `root` on the first try; **23
  pages readable**. `/html/index.asp` and most guessed paths are **404** — this firmware uses
  a `bbsp` layout instead. The pages that matter:
  - `/html/bbsp/common/wan_list_info.asp` — defines the connection record, including
    `this.BytesSent` and `this.BytesReceived` (blank in the template).
  - `/html/bbsp/common/wan_list.asp` — has the merge loop
    `WanList[j].BytesSent = WanStats[i].BytesSent`, so a **`WanStats`** list carrying real
    values exists on this box.
  - Also readable: `wan_check.asp`, `wan_list_cache_wan.asp`, `/html/bbsp/wan/wan.asp`,
    `/index.asp`, and a set of small `get_wan_list_*.asp` fragments.
  - **Watch out:** the WAN pages carry `X_HW_IPoEPassword` — the broadband password. Any tool
    reading them must scrub secrets before writing a report.

---

## Test it without a real router (optional)

You can prove the whole chain works using a pretend router — no MTN box needed:

```bash
node test/selftest.js
```

It spins up a fake **ZTE (FibreX)** and a fake **ZLT (5G ODU)** and checks the whole
chain: a first sync is a *baseline*, a second sync (after usage changes) produces a
**real daily figure**, a wrong password is rejected, the **connected-device list** and
**5G signal** are read and saved, a **speed test** measures a real number (against a
local stand-in, so it costs no data), the connected-device list comes from the
**confirmed command (cmd 223)**, and — with the fast live loop on — the **device count
updates within seconds when a device joins or leaves, with no re-Sync**. It also proves
the loop **survives a brief router hiccup** (so the old "why must I reload to see a device?"
bug stays fixed), and that **"Remember my password on this PC"** saves the password
**scrambled in a separate file**, keeps it **out of your usage file**, wipes it again on
**Forget**, and — the whole point — lets a **freshly-started helper log in and go Live on
its own, with no Sync click** (proving the after-a-reboot flow). Finally it exercises the
**connection monitor**: a one-tick blip is **ignored**, two failures in a row open a
**backdated outage** with the right cause label (**service** vs **router / power**), recovery
**closes** it, uptime is counted **only over time actually watched** (a PC-off gap is excluded,
never counted up or down), and the monitor comes up **watching from boot with no Sync**.
Last, it checks the **Huawei fibre reader**: that the box is recognised on its own, that
download and upload don't come out swapped, and — the part you asked for — that a **three-day
stretch with the PC switched off is filled back in across all three days**, that a counter
which **rolls over past 4 GB is repaired instead of binned**, that a meter which genuinely
**restarts** is labelled *"at least this much"* rather than passed off as exact, and that a
**wrong password is refused**. You should see **ALL CHECKS PASSED (65 checks)**.

This test is **safe to run any time** — it writes to a throwaway file and **never touches
your real saved usage** in `data/data_history.json`.

---

## Credit & licence

The router-reading **engine** in `helper/engine/` is reused from the open-source
**WiFiWatch** project by **Sagenoya** (`github.com/sagenoya/mtn-data-tracker`), used under
the **MIT licence**. Thank you. Only the small web server (`server.js`), the launcher,
and the tests here were written for this dashboard; the proven router-reading code is
theirs, unchanged.
