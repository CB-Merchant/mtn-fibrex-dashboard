# MTN FibreX Usage Dashboard

A personal dashboard for **MTN FibreX** home broadband that shows more than MTN's
own portal or the router page: data left this cycle, a run-out prediction, daily
and monthly usage, speed vs your plan, uptime/outages, and connected devices.

The dashboard is **one self-contained HTML file** — all styling and all charts
(hand-drawn in SVG) live inside the page, so it opens with a double-click and
works even with no internet. Nothing is loaded from a CDN.

An optional **local helper** reads your own router on your home network and fills
in the live numbers automatically. The helper runs only on your own machine; your
router password never leaves it and is never stored in this repository.

![Single-file dashboard · no CDN · local helper](https://img.shields.io/badge/dashboard-single--file-FFCC00) ![Zero dependencies](https://img.shields.io/badge/helper-zero--dependency%20Node-34D399)

---

## What's in here

| Path | What it is |
|------|------------|
| [`mtn-fibrex-dashboard.html`](mtn-fibrex-dashboard.html) | The dashboard. Double-click to open; works offline. |
| [`helper/`](helper/) | The optional local program that reads your router and feeds the dashboard. |
| [`helper/README-helper.md`](helper/README-helper.md) | Plain-language setup guide for the helper. |
| [`wifiwatch-engine-reference/`](wifiwatch-engine-reference/) | Reference code (WiFiWatch, MIT, by Sagenoya) the router-reading engine draws on. |
| [`CLAUDE.md`](CLAUDE.md) | The full project brief and history, written for a first-time builder. |

---

## Just want to look at it?

Download or open [`mtn-fibrex-dashboard.html`](mtn-fibrex-dashboard.html) and
double-click it. With no helper running it shows clearly-labelled **Sample**
numbers so you can see the layout. Every panel is tagged **Live**, **Manual**, or
**Sample** so sample data is never mistaken for real data.

Use the on-page **Settings** panel to type your own plan name, price, data cap (or
"unlimited"), renewal date and wallet balance. Those are saved in your browser
(`localStorage`) and remembered next time — they are never uploaded anywhere.

---

## Want live numbers from your router?

Run the helper on a computer that stays on at home, on the same network as the
router. Full step-by-step instructions are in
[`helper/README-helper.md`](helper/README-helper.md); the short version:

```bash
cd helper
node supervise.js
```

Then open `http://localhost:8947` and click **Sync**, entering your router's
**admin password** (the one on the router sticker — *not* your bank or MyMTN
password) when asked. The helper logs into the router, reads its built-in data
counters, works out daily usage and uptime, and the dashboard goes **Live**.

Supported routers: **Huawei HG8145X7** (MTN FibreX ONT), **ZTE F6600P**, and
**MTN 5G ODU / ZLT X17U**. The helper auto-detects which one you have.

---

## Privacy & safety

- **Your router password stays on your PC.** It is held in memory by default. If
  you tick "Remember on this PC" it is scrambled (AES-GCM) into a local file that
  is **git-ignored** and never committed. There is a one-click "Forget".
- **No real usage data is in this repository** — your usage history lives in
  `helper/data/`, which is git-ignored.
- The device names and MAC addresses in the test files are **fabricated
  placeholders**, not real devices.
- The dashboard page itself makes no outbound internet calls (the only external
  reference is an optional Google Fonts link, which safely falls back to system
  fonts if blocked).

---

## Running the tests

The helper is zero-dependency plain Node and ships with self-tests that run
against pretend routers — they never touch your real router or usage file:

```bash
cd helper
node test/selftest.js
node test/selftest-huawei-devices.js
```

---

## A note on automation limits

There is **no official MTN data feed (API)** a home customer can use, and a web
page cannot log into your router by itself. That is why the live numbers need the
small local helper. Account details that change about once a month (plan, price,
wallet) are typed in by you; countdowns and predictions calculate themselves each
time you open the page.

---

## Credits & licence

The router-reading engine draws on **WiFiWatch** by *Sagenoya*
(`github.com/sagenoya/mtn-data-tracker`, MIT licence). Please respect that
licence when reusing the engine code in `wifiwatch-engine-reference/`.
