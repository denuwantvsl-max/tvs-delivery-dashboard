# TVS Lanka — Delivery & Stock Dashboard

Live delivery and stock-shortage dashboard for the **Horana Assembly Complex**.
A single self-contained `index.html` (no build step, no CDNs — the plant network
blocks external hosts) that reads JSON from a Google Apps Script Web App.

---

## How the data flows

```
Google Sheet tab "Delivery Status Raw"      <- daily Apps Script pipeline
  Date | Tab | Model | Color | Metric | Value
              |
              v
doGet() Web App  (dashboard-webapp-snippet.gs)
  { asOfDate, generatedAt, deliveryStatus[], shortage[], trend[] }
              |
              v
index.html  ->  GitHub Pages
```

Metrics consumed from the raw tab:

| Metric | Used by |
| --- | --- |
| `Delivered Qty` | Delivery Status, Trend |
| `Delivery Plan` | Delivery Status, Trend |
| `Pending Delivery` | Delivery Status, Trend |
| `Stock N/A for Delivery Orders` | Shortage |

`Tab` is the category axis — **Summary**, **IQUBE**, **3W**.

---

## Setup

1. Deploy the Web App (already done, but for reference):
   Apps Script → **Deploy → New deployment → Web app**,
   *Execute as:* Me, *Who has access:* Anyone. Copy the `/exec` URL.
2. Open `index.html`, find the `CONFIG` block near the top of `<script>`, and set:

   ```js
   WEBAPP_URL: "https://script.google.com/macros/s/AKfy.../exec",
   ```

3. Commit and push. GitHub Pages redeploys automatically.

> If you change the Apps Script code later, use **Manage deployments → edit →
> new version** so the same URL keeps working.

### Preview without the URL

Append `?demo=1` to the page address to render the full layout with illustrative
sample figures. Useful for reviewing design changes offline. The status badge
reads **Demo data** so it can never be mistaken for the real feed.

---

## CONFIG reference

| Key | Default | Purpose |
| --- | --- | --- |
| `WEBAPP_URL` | *(placeholder)* | Apps Script `/exec` endpoint |
| `REFRESH_MS` | `300000` | Background refresh interval (5 min) |
| `CATEGORY_ORDER` | `["Summary","IQUBE","3W"]` | Order chapters appear in; unlisted tabs fall to the end alphabetically |
| `SUMMARY_TAB` | `"Summary"` | Name of the roll-up tab |
| `TOTALS_FROM_SUMMARY` | `false` | See note below |
| `TOP_N` | `6` | Rows shown in the pinned panel (the full set is always in the table beneath) |

### `TOTALS_FROM_SUMMARY` — resolved 08/09/2026

Despite its name, the **`Summary` tab is not a roll-up.** Checked against the
live feed, the three tabs are mutually exclusive product lines with no shared
models:

| Tab | Models |
| --- | --- |
| `Summary` | JUPITER, NTORQ, RAIDER 125, RONIN, RTR 160, SPORTELS 110, XL 100 iTouch (petrol 2W) |
| `IQUBE` | IQUBE ELECTRIC 2.2, IQUBE ELECTRIC 3.4, ORBITER (electric) |
| `3W` | 3 WHEEL, 3W EV (three-wheelers) |

So the headline figures **sum all three tabs** (`TOTALS_FROM_SUMMARY: false`).
Taking `Summary` alone would have under-reported the plant by the entire
electric and three-wheeler output. Set this back to `true` only if a genuine
roll-up tab is added later.

---

## Design / behaviour notes

- **Structure.** The three tabs (Delivery Status / Shortage / Trend) are
  preserved. Within each tab: a full-viewport hero (as-of date + three headline
  stats), then one pinned full-viewport chapter per category, then a full data
  table under each chapter so no row is ever hidden by the storytelling.
- **Scroll engine.** Sections pin with `position: sticky` over a `300vh` runway.
  Animation is driven by native **CSS scroll-driven animations**
  (`animation-timeline: view()`, guarded by `@supports`). Where unsupported, an
  `IntersectionObserver` fallback drives the *same* `--r` custom property, so
  there is one set of visual rules rather than two.
- **Counters.** Numbers count up via `requestAnimationFrame` in both paths —
  CSS counters cannot render thousands separators.
- **Charts.** Inline SVG; lines draw in via `stroke-dashoffset` bound to `--r`.
- **Accessibility.** `prefers-reduced-motion: reduce` unpins every chapter,
  disables all motion, and renders final values immediately. Tabs are a proper
  ARIA tablist with arrow-key navigation.
- **Refresh.** Every 5 minutes the feed is re-fetched, but the page only
  re-renders if the payload actually changed — a background refresh never yanks
  a reader back to the top.

### Browser support

| | Pinned scroll narrative | Count-up | Charts |
| --- | --- | --- | --- |
| Chrome / Edge 115+ | native scroll-driven | ✅ | ✅ |
| Safari 26+ / Firefox 144+ | native scroll-driven | ✅ | ✅ |
| Older evergreen browsers | IntersectionObserver reveal | ✅ | ✅ |
| No `@property` support | static (content shown immediately) | ✅ | ✅ |

---

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The entire dashboard — markup, styles, engine |
| `Code.gs` | **Canonical** full Apps Script pipeline, including `doGet()`. Paste this whole file into the Apps Script project. |
| `dashboard-webapp-snippet.gs` | Superseded feed-only excerpt, kept for reference |
| `_previous-version.html.bak` | The plain tabbed dashboard this replaced |

---

## Updating

All changes go through git — no manual uploads via the GitHub web UI.

```bash
cd ~/tvs-delivery-dashboard
# edit index.html
git add -A
git commit -m "Describe the change"
git push
```

GitHub Pages rebuilds within about a minute.
