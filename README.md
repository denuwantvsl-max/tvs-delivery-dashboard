# TVS Lanka — Horana Delivery & Stock Control Board

Live delivery and stock-shortage board for the **Horana Assembly Complex**.
A single self-contained `index.html` — no build step, no CDNs, no external
requests of any kind (the plant network blocks external hosts) — reading JSON
from a Google Apps Script Web App.

**Live:** https://denuwantvsl-max.github.io/tvs-delivery-dashboard/

---

## How the data flows

```
Gmail (daily reports)  ->  Apps Script pipeline (Code.gs)
                                    |
                                    v
              Sheet tab "Delivery Status Raw"
              Date | Tab | Model | Color | Metric | Value
                                    |
                              doGet() Web App
        { asOfDate, generatedAt, deliveryStatus[], shortage[], trend[] }
                                    |
                                    v
                      index.html  ->  GitHub Pages
```

Metrics consumed:

| Metric | Used by |
| --- | --- |
| `Delivered Qty` | Delivery status, trend |
| `Delivery Plan` | Delivery status, trend |
| `Pending Delivery` | Delivery status, trend |
| `Stock N/A for Delivery Orders` | Shortage |

### Product lines

`Tab` is the product-line axis. **Verified 08/09/2026: the three tabs are
mutually exclusive product lines with no shared models — `Summary` is not a
roll-up.** Plant totals therefore sum all three.

| Tab | Contains |
| --- | --- |
| `Summary` | JUPITER, NTORQ, RAIDER 125, RONIN, RTR 160, SPORTELS 110, XL 100 iTouch (petrol 2W) |
| `IQUBE` | IQUBE ELECTRIC 2.2, IQUBE ELECTRIC 3.4, ORBITER (electric) |
| `3W` | 3 WHEEL, 3W EV (three-wheelers) |

---

## The board

Designed as a **plant control board**, not a marketing page: everything
critical is visible without scrolling, then four views for drill-down.

| View | Shows |
| --- | --- |
| **Overview** | 4 KPI tiles (delivered + day-on-day delta, plan attainment, pending, units short), one card per product line with attainment bar, delivered-vs-plan chart, top shortages |
| **Delivery Status** | Every model/colour line — sortable on any column, filterable by line, searchable by model or colour, in-row attainment bars and status |
| **Shortage** | Shortage KPIs, ranked bars by units short, full register with share-of-total |
| **14-Day Trend** | Delivered / plan / pending over time, per line or combined, with a daily history table |

### Interaction

- **Sorting** — click (or Enter/Space on) any sortable column header.
- **Filtering** — segmented control per product line, plus a search box on Delivery Status.
- **Chart** — hover or focus and use left/right arrows for a crosshair readout; Esc dismisses. Days where delivered fell below 60% of plan are ringed **and** labelled `UNDER PLAN` in the tooltip.
- **Theme** — light/dark toggle, remembered per browser. Dark is the default (suits a wall display); light is there for daylight desk use.
- **Tabs** — ARIA tablist with left/right arrow navigation.
- **Refresh** — every 5 minutes automatically, or the refresh button. The page only re-renders when the payload actually changed.

### Design notes

- **No scroll-jacking.** The previous version pinned each category to a full
  viewport and animated on scroll. For operational data that buried the
  numbers; this replaces it with a dense board at a dashboard spacing scale
  (4-32px).
- **Status is never colour alone** — every pill carries an icon and a word
  (`On plan` / `Behind` / `Short` / `No plan`), so it survives greyscale
  printing and colour-blindness.
- **Tabular figures** everywhere via a monospace stack, so columns of numbers
  align and are comparable at a glance.
- **System fonts only.** The design guidance suggested Fira Sans/Code via
  Google Fonts; that would be an external request, so the equivalent mood is
  achieved with the system sans + system monospace stacks.
- **Icons are inline SVG**, never emoji.
- Responsive at 1440 / 1180 / 820 / 420px. Reduced-motion disables all
  animation. Print stylesheet unhides every view.

---

## CONFIG reference

At the top of the `<script>` block in `index.html`:

| Key | Default | Purpose |
| --- | --- | --- |
| `WEBAPP_URL` | *(deployed /exec)* | Apps Script endpoint |
| `REFRESH_MS` | `300000` | Background refresh interval |
| `LINE_ORDER` | `["Summary","IQUBE","3W"]` | Display order; unlisted tabs sort to the end |
| `LINE_DESC` | *(see file)* | Display-only subtitle per line |
| `MISS_THRESHOLD` | `0.6` | Below this share of plan, a day is flagged on the chart |
| `BAND_OK` / `BAND_WARN` | `1.0` / `0.8` | Row status bands |

---

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The entire board — markup, styles, engine, logo |
| `Code.gs` | **Canonical** Apps Script pipeline including `doGet()`. Paste this whole file into the Apps Script project. |
| `tvs-logo-mask.png` | Source alpha mask for the logo (embedded in `index.html` as a data URI and coloured with CSS, so it takes the brand blue or white as needed) |
| `dashboard-webapp-snippet.gs` | Superseded feed-only excerpt, kept for reference |
| `_previous-version.html.bak` | The original plain tabbed dashboard |

---

## Fixes carried in `Code.gs`

Three bugs were found and fixed in the pipeline while wiring this up:

1. **`getActiveSpreadsheet()` returned null** — the project is standalone, not
   bound to the Sheet. Now opens by `TRACKING_SHEET_ID`.
2. **Locale date swap** — the Sheet's locale is US (M/D/Y), so `"07/09/2026"`
   was stored as *July 9*. Only dates with day <= 12 were affected. Column A is
   now forced to text on write; `repairRawTabs()` repaired 1,779 existing rows.
3. **Duplicate rows** — `clearRowsForDate` compared a `Date` cell to a string
   and never matched, so re-runs appended instead of replacing. 412 duplicate
   rows were removed.

---

## Updating

All changes go through git — no manual uploads via the GitHub web UI.

```bash
cd ~/tvs-delivery-dashboard
git add -A
git commit -m "Describe the change"
git push
```

GitHub Pages rebuilds within about a minute. If `Code.gs` changed, also
re-paste it into Apps Script and use **Deploy → Manage deployments → edit →
new version** so the `/exec` URL stays the same.
