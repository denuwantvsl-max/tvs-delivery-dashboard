/**
 * TVS Lanka — Delivery & Stock Dashboard data feed
 * Paste this at the bottom of Code.gs in the "Stock Delivery Pipeline"
 * Apps Script project.
 *
 * That project is STANDALONE (it reads reports from Gmail and opens the
 * tracking Sheet by id), so this must use openById(TRACKING_SHEET_ID) --
 * getActiveSpreadsheet() returns null outside a container-bound script.
 *
 * Then: Deploy → New deployment → Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Deploy, and copy the Web app URL — that's what the dashboard fetches.
 *
 * If you ever change the code, use "Manage deployments" → edit → new
 * version, so the same URL keeps working.
 */

function doGet(e) {
  var ss = SpreadsheetApp.openById(TRACKING_SHEET_ID);
  var tabName = (typeof DELIVERY_STATUS_OUTPUT_TAB !== 'undefined')
    ? DELIVERY_STATUS_OUTPUT_TAB
    : 'Delivery Status Raw';
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Tab not found: ' + tabName }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });

  var rows = data.slice(1).filter(function (r) { return r[idx['Date']]; });

  /* The Date column holds a MIX of types: most rows are dd/MM/yyyy text, but
     some are real spreadsheet Date cells. String() turns those into
     "Thu Jul 09 2026 00:00:00 GMT+0530 (...)", which parseDate cannot split on
     "/" -- the sort then compares NaN, ordering collapses, and the wrong day is
     chosen as latest. Normalise every date to dd/MM/yyyy before doing anything. */
  function normDate(v) {
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
    }
    return String(v).trim();
  }

  function parseDate(s) {
    var p = String(s).split('/');
    if (p.length !== 3) return null;
    var d = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
    return isNaN(d.getTime()) ? null : d;
  }

  var uniqueDates = Array.from(new Set(rows.map(function (r) { return normDate(r[idx['Date']]); })));
  uniqueDates = uniqueDates.filter(function (s) { return parseDate(s) !== null; });
  uniqueDates.sort(function (a, b) { return parseDate(a) - parseDate(b); });
  var asOfDate = uniqueDates[uniqueDates.length - 1];

  var latestRows = rows.filter(function (r) { return normDate(r[idx['Date']]) === asOfDate; });
  var statusMetrics = ['Delivered Qty', 'Delivery Plan', 'Pending Delivery'];

  // ---- Delivery status: latest day, by Tab/Model/Color ----
  var statusMap = {};
  latestRows.forEach(function (r) {
    var metric = String(r[idx['Metric']]).trim();
    if (statusMetrics.indexOf(metric) === -1) return;
    var key = r[idx['Tab']] + '|' + r[idx['Model']] + '|' + r[idx['Color']];
    if (!statusMap[key]) {
      statusMap[key] = { tab: r[idx['Tab']], model: r[idx['Model']], color: r[idx['Color']], delivered: 0, plan: 0, pending: 0 };
    }
    var val = Number(r[idx['Value']]) || 0;
    if (metric === 'Delivered Qty') statusMap[key].delivered = val;
    if (metric === 'Delivery Plan') statusMap[key].plan = val;
    if (metric === 'Pending Delivery') statusMap[key].pending = val;
  });
  var deliveryStatus = Object.keys(statusMap).map(function (k) { return statusMap[k]; });

  // ---- Shortage: Stock N/A for Delivery Orders, latest day ----
  var shortage = latestRows
    .filter(function (r) { return String(r[idx['Metric']]).trim() === 'Stock N/A for Delivery Orders'; })
    .map(function (r) { return { tab: r[idx['Tab']], model: r[idx['Model']], color: r[idx['Color']], qty: Number(r[idx['Value']]) || 0 }; })
    .filter(function (s) { return s.qty > 0; })
    .sort(function (a, b) { return b.qty - a.qty; });

  // ---- Trend: last 14 days, summed by Tab ----
  var last14 = uniqueDates.slice(-14);
  var trendMap = {};
  rows.forEach(function (r) {
    var d = normDate(r[idx['Date']]);
    if (last14.indexOf(d) === -1) return;
    var metric = String(r[idx['Metric']]).trim();
    if (statusMetrics.indexOf(metric) === -1) return;
    var key = d + '|' + r[idx['Tab']];
    if (!trendMap[key]) trendMap[key] = { date: d, tab: r[idx['Tab']], delivered: 0, plan: 0, pending: 0 };
    var val = Number(r[idx['Value']]) || 0;
    if (metric === 'Delivered Qty') trendMap[key].delivered += val;
    if (metric === 'Delivery Plan') trendMap[key].plan += val;
    if (metric === 'Pending Delivery') trendMap[key].pending += val;
  });
  var trend = Object.keys(trendMap)
    .map(function (k) { return trendMap[k]; })
    .sort(function (a, b) { return parseDate(a.date) - parseDate(b.date); });

  var payload = {
    asOfDate: asOfDate,
    generatedAt: new Date().toISOString(),
    deliveryStatus: deliveryStatus,
    shortage: shortage,
    trend: trend
  };

  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
