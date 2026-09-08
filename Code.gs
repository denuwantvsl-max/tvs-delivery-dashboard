/**
 * ============================================================================
 * TVS Stock & Delivery Pipeline — FINAL (email-based)
 * ============================================================================
 * Reads two report types directly from Gmail (denuwantvsl@gmail.com):
 *   1. "VEHICLE STOCK AS AT dd/mm/yyyy"  (Shantha / Horana Stores)
 *   2. "STOCK & DELIVERY STATUS"          (Piyumal / delivery team)
 *
 * Writes to two tabs in the tracking Sheet:
 *   - "Vehicle Stock Raw"      (one row per work-order / yard-stock entry)
 *   - "Delivery Status Raw"    (long/tidy: Date, Tab, Model, Color, Metric, Value)
 *
 * INSTALL:
 *   1. Paste this whole file into the Apps Script project (replace old content).
 *   2. Run runFullBackfill() once — pulls everything in the last 10 days,
 *      writes to both tabs, emails you if anything doesn't validate.
 *   3. Check both tabs in the tracking Sheet against the real source files.
 *   4. Once confirmed, run setupDailyTrigger() ONCE to install the 3 AM job.
 *      (Safe to re-run — it clears any old trigger first, no duplicates.)
 * ============================================================================
 */

const TRACKING_SHEET_ID = '1iqpg4nFTKJsQCpgfTD9B8Rs-bwHxEl55_JSiDf3Pc1A';
const VEHICLE_STOCK_OUTPUT_TAB = 'Vehicle Stock Raw';
const DELIVERY_STATUS_OUTPUT_TAB = 'Delivery Status Raw';
const BACKFILL_DAYS = 10;
const DAILY_WINDOW_DAYS = 2;
const DELIVERY_STATUS_TABS = ['Summary', 'IQUBE', '3W'];
const REPORT_TZ = 'Asia/Colombo';

// ============================================================================
// ENTRY POINTS
// ============================================================================

function runFullBackfill() {
  const issues = [];
  runBackfillVehicleStock(issues);
  runBackfillDeliveryStatus(issues);
  if (issues.length) {
    notifyIssues('Backfill — issues found', issues);
    Logger.log(issues.join('\n'));
  } else {
    Logger.log('Backfill complete for both report types, no validation issues.');
  }
}

// Split versions — run these separately if runFullBackfill times out (Apps
// Script has a 6-minute limit; each xlsx→Sheets conversion takes several
// seconds, and 6 Vehicle Stock emails × 13+ tabs plus Delivery Status on
// top can exceed that in one run).
function runVehicleStockBackfillOnly() {
  const issues = [];
  runBackfillVehicleStock(issues);
  if (issues.length) notifyIssues('Vehicle Stock backfill — issues found', issues);
  else Logger.log('Vehicle Stock backfill complete, no validation issues.');
}

function runDeliveryStatusBackfillOnly() {
  const issues = [];
  runBackfillDeliveryStatus(issues);
  if (issues.length) notifyIssues('Delivery Status backfill — issues found', issues);
  else Logger.log('Delivery Status backfill complete, no validation issues.');
}

// FAST single-email test — converts and parses only the single most recent
// Delivery Status email. Use this first to confirm the parser is correct
// before running the full multi-email backfill (each conversion is slow —
// the source workbook has 10+ tabs even though we only read 3 of them).
function testLatestDeliveryStatusOnly() {
  const issues = [];
  const query = `subject:DELIVERY has:attachment newer_than:${BACKFILL_DAYS}d`;
  const threads = GmailApp.search(query, 0, 20);
  const candidates = [];
  threads.forEach(thread => thread.getMessages().forEach(m => {
    if (m.getAttachments().length > 0 && isDeliveryStatusSubject(m.getSubject())) candidates.push(m);
  }));
  if (!candidates.length) { Logger.log('No Delivery Status email found.'); return; }
  candidates.sort((a, b) => a.getDate() - b.getDate());
  const latest = candidates[candidates.length - 1];
  Logger.log('Processing: ' + latest.getSubject() + ' (' + latest.getDate() + ')');
  processDeliveryStatusMessage(latest, issues);
  if (issues.length) { Logger.log(issues.join('\n')); notifyIssues('Delivery Status test — issues found', issues); }
  else Logger.log('Single-email test complete, no validation issues. Check the Delivery Status Raw tab.');
}

function runDailyExtractionAll() {
  const issues = [];
  runDailyVehicleStockExtraction(issues);
  runDailyDeliveryStatusExtraction(issues);
  if (issues.length) notifyIssues('Daily extraction — issues found', issues);
}

// Run this to see every trigger currently installed in this project — helps
// spot the stale one from an earlier script version that's still firing.
function listAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.length) { Logger.log('No triggers installed.'); return; }
  triggers.forEach(t => {
    Logger.log(`Handler: ${t.getHandlerFunction()} | Type: ${t.getEventType()} | Source: ${t.getTriggerSource()}`);
  });
}

// Deletes ALL triggers in this project — use if listAllTriggers() shows a
// stale one from an old script version, then re-run setupDailyTrigger().
function deleteAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('All triggers deleted. Run setupDailyTrigger() to reinstall the current one.');
}

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runDailyExtractionAll' ||
        t.getHandlerFunction() === 'runDailyExtraction') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('runDailyExtractionAll')
    .timeBased()
    .atHour(3)
    .everyDays(1)
    .inTimezone('Asia/Colombo')
    .create();
  Logger.log('Daily trigger installed for 3:00 AM Asia/Colombo.');
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

/**
 * Canonical dd/MM/yyyy key for any date value.
 *
 * WHY THIS EXISTS: the Date column in the raw tabs holds a MIX of types.
 * We always write dd/MM/yyyy strings, but Google Sheets silently converts
 * some of them into real Date cells on write. A Date object is never ===
 * to a string, so any raw comparison between the two forms fails silently.
 *
 * That single mismatch caused three separate symptoms:
 *   1. clearRowsForDate() stopped matching existing rows, so re-running the
 *      pipeline for a date APPENDED duplicates instead of replacing them.
 *   2. The dashboard feed's date sort compared NaN and collapsed, picking
 *      the wrong day as "latest".
 *   3. String(dateCell) leaked "Thu Jul 09 2026 00:00:00 GMT+0530 (...)"
 *      into the JSON payload as asOfDate.
 *
 * Every date comparison in this file must go through here.
 */
function normalizeDateKey(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, REPORT_TZ, 'dd/MM/yyyy');
  }
  return String(v).trim();
}

/**
 * Forces column A (Date) to plain-text format.
 *
 * WHY: the tracking Sheet's locale is US (M/D/Y). Writing the string
 * "07/09/2026" (7 September) into a date-formatted cell makes Sheets parse it
 * as July 9 and store a Date object with day and month SWAPPED. Dates whose
 * day is > 12 are invalid as US dates so they survive as text -- which is why
 * only 03/09, 04/09 and 07/09 were corrupted while 21/08..31/08 were fine.
 *
 * Formatting the column as text ("@") makes Sheets store exactly what we
 * write, so dd/MM/yyyy stays dd/MM/yyyy regardless of spreadsheet locale.
 */
function forceDateColumnText(sheet) {
  sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');
}

function convertAttachmentToTempSheet(attachment) {
  const file = Drive.Files.create(
    { name: 'TEMP_PARSE_' + new Date().getTime(), mimeType: MimeType.GOOGLE_SHEETS },
    attachment.copyBlob(),
    { convert: true }
  );
  return file;
}

function cleanupTempSheet(fileId) {
  DriveApp.getFileById(fileId).setTrashed(true);
}

function firstXlsxAttachment(message) {
  const atts = message.getAttachments();
  const xlsx = atts.find(a => a.getName().toLowerCase().endsWith('.xlsx'));
  return xlsx || atts[0] || null;
}

function getSheetCaseInsensitive(ss, name) {
  return ss.getSheets().find(s => s.getName().trim().toLowerCase() === name.trim().toLowerCase()) || null;
}

function notifyIssues(subject, issues) {
  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: 'TVS Pipeline — ' + subject,
    body: issues.join('\n\n')
  });
}

// ============================================================================
// VEHICLE STOCK (Shantha / Horana Stores)
// ============================================================================

function runBackfillVehicleStock(issuesOut) {
  const query = `subject:"VEHICLE STOCK AS AT" has:attachment newer_than:${BACKFILL_DAYS}d`;
  const threads = GmailApp.search(query, 0, 20);
  threads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      if (msg.getAttachments().length === 0) return;
      try { processVehicleStockMessage(msg, issuesOut); }
      catch (e) { issuesOut.push(`Vehicle Stock — "${msg.getSubject()}": FAILED — ${e.message}`); }
    });
  });
}

function runDailyVehicleStockExtraction(issuesOut) {
  const query = `subject:"VEHICLE STOCK AS AT" has:attachment newer_than:${DAILY_WINDOW_DAYS}d`;
  const threads = GmailApp.search(query, 0, 3);
  if (!threads.length) { issuesOut.push('Vehicle Stock: no email found in the last ' + DAILY_WINDOW_DAYS + ' days.'); return; }
  const messages = threads[0].getMessages();
  const latest = messages[messages.length - 1];
  if (latest.getAttachments().length === 0) { issuesOut.push('Vehicle Stock: latest email has no attachment.'); return; }
  try { processVehicleStockMessage(latest, issuesOut); }
  catch (e) { issuesOut.push(`Vehicle Stock — "${latest.getSubject()}": FAILED — ${e.message}`); }
}

function processVehicleStockMessage(msg, issuesOut) {
  const subject = msg.getSubject();
  const dateMatch = subject.match(/AS AT\s*(\d{2}\/\d{2}\/\d{4})/i);
  const reportDate = dateMatch ? dateMatch[1] : Utilities.formatDate(msg.getDate(), 'Asia/Colombo', 'dd/MM/yyyy');

  const attachment = firstXlsxAttachment(msg);
  if (!attachment) { issuesOut.push(`Vehicle Stock ${reportDate}: no attachment found.`); return; }
  const tempFile = convertAttachmentToTempSheet(attachment);

  try {
    const ss = SpreadsheetApp.openById(tempFile.id);
    const allRows = [];
    ss.getSheets().forEach(sheet => {
      const { rows, issues } = parseVehicleStockTab(sheet, reportDate);
      allRows.push(...rows);
      issues.forEach(i => issuesOut.push(`Vehicle Stock ${reportDate} — ${sheet.getName()}: ${i}`));
    });
    writeVehicleStockRows(allRows, reportDate);
  } finally {
    cleanupTempSheet(tempFile.id);
  }
}

function parseVehicleStockTab(sheet, reportDate) {
  const rows = [];
  const issues = [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { rows, issues };

  const modelName = (data[0][0] || sheet.getName()).toString().trim();

  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(5, data.length); r++) {
    if (data[r].some(cell => /W\/?ORDER/i.test(String(cell)))) { headerRowIdx = r; break; }
  }
  if (headerRowIdx === -1) {
    issues.push('Could not find header row (no "W/ORDER" in first 5 rows) — tab skipped.');
    return { rows, issues };
  }

  const header = data[headerRowIdx].map(c => String(c).toUpperCase().trim());
  const colIdx = {
    worder: header.findIndex(h => /W\/?ORDER/.test(h)),
    container: header.findIndex(h => /CONTAINER/.test(h)),
    color: header.findIndex(h => /COLOR|COLOUR/.test(h)),
    qty: header.findIndex(h => /QTY|QUANTITY/.test(h)),
    remarks: header.findIndex(h => /REMA/.test(h)) // matches REMARKS and the REMAKS typo
  };
  if (colIdx.worder === -1 || colIdx.qty === -1) {
    issues.push('Header row found but missing W/ORDER or QTY column — tab skipped.');
    return { rows, issues };
  }

  let extractedTotal = 0;
  let sheetTotal = null;

  for (let r = headerRowIdx + 1; r < data.length; r++) {
    const row = data[r];
    const rowText = row.map(c => String(c)).join(' ');

    // Matches both "SPECTRA YARD STOCK - RAIDER (BLACK)" and "SPECTRA CONTAINER YARD STOCK - NTORQ"
    if (/SPECTRA.*STOCK/i.test(rowText)) {
      const colorMatch = rowText.match(/\(([^)]+)\)/);
      const color = colorMatch ? colorMatch[1].trim() : '';
      const qty = Number(row[colIdx.qty]) || 0;
      rows.push({ date: reportDate, model: modelName, rowType: 'Yard Stock', worder: '', container: '', color: color, qty: qty, remarks: rowText.trim().split(/\s{2,}/)[0] || 'SPECTRA STOCK' });
      extractedTotal += qty;
      continue;
    }

    // Check the W/Order CELL specifically for "TOTAL" — checking the whole row
    // text was wrong: a real TOTAL row still has a qty number elsewhere in the
    // row, so "TOTAL 23" never matched ^TOTAL$ and fell through as a fake row.
    const worderCellText = String(row[colIdx.worder] || '').trim();
    if (/^TOTAL$/i.test(worderCellText)) {
      sheetTotal = Number(row[colIdx.qty]) || 0;
      break;
    }

    const worderVal = row[colIdx.worder];
    if (worderVal !== '' && worderVal !== null && worderVal !== undefined) {
      const qty = Number(row[colIdx.qty]) || 0;
      rows.push({
        date: reportDate, model: modelName, rowType: 'Work Order',
        worder: String(worderVal), container: colIdx.container > -1 ? String(row[colIdx.container]) : '',
        color: colIdx.color > -1 ? String(row[colIdx.color]) : '', qty: qty,
        remarks: colIdx.remarks > -1 ? String(row[colIdx.remarks]) : ''
      });
      extractedTotal += qty;
    }
  }

  if (sheetTotal !== null && sheetTotal !== extractedTotal) {
    issues.push(`TOTAL mismatch — sheet says ${sheetTotal}, extracted rows sum to ${extractedTotal}.`);
  }
  return { rows, issues };
}

function writeVehicleStockRows(rows, reportDate) {
  const ss = SpreadsheetApp.openById(TRACKING_SHEET_ID);
  let sheet = ss.getSheetByName(VEHICLE_STOCK_OUTPUT_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(VEHICLE_STOCK_OUTPUT_TAB);
    sheet.appendRow(['Date', 'Model', 'Row Type', 'W/Order', 'Container No', 'Color', 'Qty', 'Remarks']);
  }
  forceDateColumnText(sheet);
  clearRowsForDate(sheet, reportDate);
  if (rows.length === 0) return;
  const values = rows.map(r => [r.date, r.model, r.rowType, r.worder, r.container, r.color, r.qty, r.remarks]);
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
}

// ============================================================================
// STOCK & DELIVERY STATUS (Piyumal / delivery team)
// ============================================================================

// NOTE: these are forwards from your work email, so GmailApp sees YOU as the
// sender on every message (Piyumal/Sasika's names only appear in the body
// text). Filtering by from: would never match, so this searches everything
// with an attachment in the window and filters by subject pattern in code.
function runBackfillDeliveryStatus(issuesOut) {
  const query = `subject:DELIVERY has:attachment newer_than:${BACKFILL_DAYS}d`;
  const threads = GmailApp.search(query, 0, 30);
  threads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      if (msg.getAttachments().length === 0) return;
      if (!isDeliveryStatusSubject(msg.getSubject())) return;
      try { processDeliveryStatusMessage(msg, issuesOut); }
      catch (e) { issuesOut.push(`Delivery Status — "${msg.getSubject()}": FAILED — ${e.message}`); }
    });
  });
}

function runDailyDeliveryStatusExtraction(issuesOut) {
  const query = `subject:DELIVERY has:attachment newer_than:${DAILY_WINDOW_DAYS}d`;
  const threads = GmailApp.search(query, 0, 10);
  const candidates = [];
  threads.forEach(thread => thread.getMessages().forEach(m => {
    if (m.getAttachments().length > 0 && isDeliveryStatusSubject(m.getSubject())) candidates.push(m);
  }));
  if (!candidates.length) { issuesOut.push('Delivery Status: no email found in the last ' + DAILY_WINDOW_DAYS + ' days.'); return; }
  candidates.sort((a, b) => a.getDate() - b.getDate());
  const latest = candidates[candidates.length - 1];
  try { processDeliveryStatusMessage(latest, issuesOut); }
  catch (e) { issuesOut.push(`Delivery Status — "${latest.getSubject()}": FAILED — ${e.message}`); }
}

// Matches on "DELIVERY" alone, not "DELIVERY"+"STATUS" — subject lines are
// typed by hand daily and STATUS gets mistyped (e.g. "STATUSD" on 24-Aug).
// DELIVERY is the stable anchor: it's never misspelled in practice, and it
// never appears in Vehicle Stock subjects, so this alone is enough to
// distinguish the two report types without being brittle to human typos.
function isDeliveryStatusSubject(subject) {
  return /DELIVERY/i.test(subject);
}

function processDeliveryStatusMessage(msg, issuesOut) {
  const attachment = firstXlsxAttachment(msg);
  if (!attachment) { issuesOut.push(`Delivery Status "${msg.getSubject()}": no attachment found.`); return; }
  const tempFile = convertAttachmentToTempSheet(attachment);

  try {
    const ss = SpreadsheetApp.openById(tempFile.id);
    let reportDate = null;

    // Try to read "As at dd/mm/yyyy" from the Summary tab first (most reliable)
    const summarySheet = getSheetCaseInsensitive(ss, 'Summary');
    if (summarySheet) {
      const top = summarySheet.getRange(1, 1, 3, 1).getValues();
      for (const row of top) {
        const m = String(row[0]).match(/AS AT\s*(\d{2}\/\d{2}\/\d{4})/i);
        if (m) { reportDate = m[1]; break; }
      }
    }
    if (!reportDate) reportDate = Utilities.formatDate(msg.getDate(), 'Asia/Colombo', 'dd/MM/yyyy');

    const allRows = [];
    DELIVERY_STATUS_TABS.forEach(tabName => {
      const sheet = getSheetCaseInsensitive(ss, tabName);
      if (!sheet) { issuesOut.push(`Delivery Status ${reportDate}: tab "${tabName}" not found — skipped.`); return; }
      const { rows, issues } = parseDeliveryStatusTab(sheet, reportDate, tabName);
      allRows.push(...rows);
      issues.forEach(i => issuesOut.push(`Delivery Status ${reportDate} — ${tabName}: ${i}`));
    });

    writeDeliveryStatusRows(allRows, reportDate);
  } finally {
    cleanupTempSheet(tempFile.id);
  }
}

/**
 * Parses one tab (Summary / IQUBE / 3W) of the Delivery Status report.
 * Header is two rows: model group (merged cells, forward-filled) + color/variant.
 * Data rows are matched by label pattern (normalizeMetric), not row number,
 * so the parser survives new rows/typos and future model columns.
 */
function parseDeliveryStatusTab(sheet, reportDate, tabLabel) {
  const rows = [];
  const issues = [];
  const data = sheet.getDataRange().getValues();

  let descRowIdx = -1;
  for (let r = 0; r < Math.min(8, data.length); r++) {
    if (/DESCRIPTION/i.test(String(data[r][0]))) { descRowIdx = r; break; }
  }
  if (descRowIdx === -1) {
    issues.push('Could not find "Description" header row — tab skipped.');
    return { rows, issues };
  }
  const groupRow = data[descRowIdx] || [];
  const colorRow = data[descRowIdx + 1] || [];
  const dataStartRow = descRowIdx + 2;

  const colGroup = [], colColor = [], colIsTotal = [], colIsGrandTotal = [];
  let lastGroup = '';
  const width = Math.max(groupRow.length, colorRow.length);
  for (let c = 1; c < width; c++) {
    const g = String(groupRow[c] || '').trim();
    if (g) lastGroup = g;
    colGroup[c] = lastGroup;
    const colorVal = String(colorRow[c] || '').trim();
    colColor[c] = colorVal;
    colIsGrandTotal[c] = /GRAND TOTAL/i.test(colorVal) || /GRAND TOTAL/i.test(g);
    colIsTotal[c] = !colIsGrandTotal[c] && /^TOTAL$/i.test(colorVal);
  }

  for (let r = dataStartRow; r < data.length; r++) {
    const row = data[r];
    const label = String(row[0] || '').trim();
    if (!label) break; // stop at first blank Description cell

    const metric = normalizeMetric(label);
    const groupSums = {};
    let grandTotalExtracted = 0;
    let grandTotalReported = null;

    for (let c = 1; c < width; c++) {
      const val = Number(row[c]) || 0;
      if (colIsGrandTotal[c]) { grandTotalReported = val; continue; }
      if (colIsTotal[c]) {
        const g = colGroup[c];
        const summed = groupSums[g] || 0;
        if (summed !== val) issues.push(`${metric}: ${g} total mismatch — sheet says ${val}, colors sum to ${summed}.`);
        continue;
      }
      const g = colGroup[c];
      const color = colColor[c];
      if (!g || !color) continue;
      rows.push({ date: reportDate, tab: tabLabel, model: g, color: color, metric: metric, value: val });
      groupSums[g] = (groupSums[g] || 0) + val;
      grandTotalExtracted += val;
    }

    if (grandTotalReported !== null && grandTotalReported !== grandTotalExtracted) {
      issues.push(`${metric}: Grand Total mismatch — sheet says ${grandTotalReported}, extracted sums to ${grandTotalExtracted}.`);
    }
  }

  return { rows, issues };
}

function normalizeMetric(rawLabel) {
  const clean = rawLabel.replace(/[-–]\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/i, '').trim();
  const map = [
    [/REQUESTED QUANTIT/i, 'Weekly Requested Quantities'],
    [/RECEIVED QUANTIT/i, 'Weekly Received Quantities'],
    [/DELIVERED QTY/i, 'Delivered Qty'],
    [/DELIVERY PLAN/i, 'Delivery Plan'],
    [/FINISHED STOCK AVAILABLE/i, 'Finished Stock Available for Delivery'],
    [/UNFINISHED STOCK/i, 'Unfinished Stock Delivery Orders'],
    [/PENDING DELIVERY/i, 'Pending Delivery'],
    [/STOCK N\/A/i, 'Stock N/A for Delivery Orders'],
    [/BALANCED STOCK FOR NEW ORDERS/i, 'Balanced Stock for New Orders'],
    [/BALANCED STOCK.*NOT ASSEMBLED/i, 'Balanced Stock (Not Assembled)'],
    [/VARIANCE/i, 'Variance with Weekly Requested Quantities']
  ];
  for (const [pattern, canonical] of map) {
    if (pattern.test(clean)) return canonical;
  }
  return clean; // unrecognized row: keep as-is so nothing silently gets dropped
}

function writeDeliveryStatusRows(rows, reportDate) {
  const ss = SpreadsheetApp.openById(TRACKING_SHEET_ID);
  let sheet = ss.getSheetByName(DELIVERY_STATUS_OUTPUT_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(DELIVERY_STATUS_OUTPUT_TAB);
    sheet.appendRow(['Date', 'Tab', 'Model', 'Color', 'Metric', 'Value']);
  }
  forceDateColumnText(sheet);
  clearRowsForDate(sheet, reportDate);
  if (rows.length === 0) return;
  const values = rows.map(r => [r.date, r.tab, r.model, r.color, r.metric, r.value]);
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
}

// ============================================================================
// SHARED: idempotent write (clear existing rows for a date before re-inserting)
// ============================================================================

/**
 * FIXED: this used to compare `existing[r][0] === reportDate` directly.
 * reportDate is always a dd/MM/yyyy string, but Sheets converts some written
 * dates into real Date cells, and a Date is never === to a string. Matching
 * silently failed, so re-running the pipeline for a date APPENDED a second
 * copy of every row instead of replacing them — the source of the duplicate
 * rows in Delivery Status Raw. Both sides now go through normalizeDateKey().
 */
function clearRowsForDate(sheet, reportDate) {
  const existing = sheet.getDataRange().getValues();
  const target = normalizeDateKey(reportDate);
  for (let r = existing.length - 1; r >= 1; r--) {
    if (normalizeDateKey(existing[r][0]) === target) sheet.deleteRow(r + 1);
  }
}

/**
 * Recovers the intended dd/MM/yyyy from a Date cell that Sheets created by
 * mis-parsing a dd/MM/yyyy string under a US (M/D/Y) locale.
 *
 * The written string was "D/M/yyyy" but Sheets read it as "M/D/yyyy", so the
 * stored month IS the intended day and the stored day IS the intended month.
 * Swapping them back is exact, not a guess.
 *
 * Returns null when the cell cannot have come from that mis-parse (stored day
 * > 12 could never be a month), so genuine dates are never silently rewritten.
 */
function recoverSwappedDate(v) {
  if (Object.prototype.toString.call(v) !== '[object Date]' || isNaN(v.getTime())) return null;
  var intendedDay = v.getMonth() + 1;
  var intendedMonth = v.getDate();
  if (intendedMonth > 12) return null;
  var pad = function (x) { return (x < 10 ? '0' : '') + x; };
  return pad(intendedDay) + '/' + pad(intendedMonth) + '/' + v.getFullYear();
}

/**
 * One-off repair for both raw tabs. Run ONCE from the editor.
 *   1. Rewrites locale-swapped Date cells in column A back to correct
 *      dd/MM/yyyy text (e.g. the Date "Jul 9 2026" becomes "07/09/2026").
 *   2. Removes duplicate rows left behind while clearRowsForDate was broken,
 *      keeping one copy of each identical row.
 * Safe to re-run; logs what it changed in each tab.
 */
function repairRawTabs() {
  const ss = SpreadsheetApp.openById(TRACKING_SHEET_ID);
  [VEHICLE_STOCK_OUTPUT_TAB, DELIVERY_STATUS_OUTPUT_TAB].forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) { Logger.log(`${tabName}: tab not found, skipped.`); return; }

    // Pass 1: un-swap corrupted Date cells, then lock the column to text so
    // writing the corrected strings back cannot re-trigger the same parse.
    let values = sheet.getDataRange().getValues();
    let repaired = 0, skipped = 0;
    const fixedCol = [];
    for (let r = 1; r < values.length; r++) {
      const recovered = recoverSwappedDate(values[r][0]);
      if (recovered !== null) { fixedCol.push([recovered]); repaired++; }
      else {
        if (Object.prototype.toString.call(values[r][0]) === '[object Date]') skipped++;
        fixedCol.push([normalizeDateKey(values[r][0])]);
      }
    }
    forceDateColumnText(sheet);
    if (fixedCol.length) sheet.getRange(2, 1, fixedCol.length, 1).setValues(fixedCol);
    Logger.log(`${tabName}: repaired ${repaired} swapped date(s)` +
               (skipped ? `, left ${skipped} unrecognised Date cell(s) alone` : ''));

    // Pass 2: de-duplicate against the now-consistent dates.
    values = sheet.getDataRange().getValues();
    const seen = {};
    let removed = 0;
    for (let r = values.length - 1; r >= 1; r--) {
      // JSON.stringify keeps field boundaries unambiguous - joining on a
      // plain separator would let ["a","bc"] collide with ["ab","c"].
      const key = JSON.stringify(
        [normalizeDateKey(values[r][0])].concat(values[r].slice(1).map(v => String(v)))
      );
      if (seen[key]) { sheet.deleteRow(r + 1); removed++; }
      else seen[key] = true;
    }
    Logger.log(`${tabName}: removed ${removed} duplicate row(s).`);
  });
}

/**
 * TVS Lanka — Delivery & Stock Dashboard data feed
 *
 * This project is STANDALONE (it reads reports from Gmail and opens the
 * tracking Sheet by id), so this uses openById(TRACKING_SHEET_ID) --
 * getActiveSpreadsheet() returns null outside a container-bound script.
 *
 * Deploy → New deployment → Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Copy the Web app URL — that's what the dashboard fetches.
 *
 * After changing this code, use "Manage deployments" → edit → new version,
 * so the same URL keeps working.
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

  // Returns null rather than an Invalid Date, so unparseable values can be
  // filtered out instead of poisoning the sort comparator with NaN.
  function parseDate(s) {
    var p = String(s).split('/');
    if (p.length !== 3) return null;
    var d = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
    return isNaN(d.getTime()) ? null : d;
  }

  var uniqueDates = Array.from(new Set(rows.map(function (r) {
    return normalizeDateKey(r[idx['Date']]);
  })));
  uniqueDates = uniqueDates.filter(function (s) { return parseDate(s) !== null; });
  uniqueDates.sort(function (a, b) { return parseDate(a) - parseDate(b); });
  var asOfDate = uniqueDates[uniqueDates.length - 1];

  var latestRows = rows.filter(function (r) {
    return normalizeDateKey(r[idx['Date']]) === asOfDate;
  });
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
  // Collapsed by Tab/Model/Color so leftover duplicate rows in the raw tab
  // cannot inflate the shortage line count on the dashboard.
  var shortMap = {};
  latestRows
    .filter(function (r) { return String(r[idx['Metric']]).trim() === 'Stock N/A for Delivery Orders'; })
    .forEach(function (r) {
      var key = r[idx['Tab']] + '|' + r[idx['Model']] + '|' + r[idx['Color']];
      var val = Number(r[idx['Value']]) || 0;
      if (!shortMap[key]) {
        shortMap[key] = { tab: r[idx['Tab']], model: r[idx['Model']], color: r[idx['Color']], qty: val };
      } else if (val > shortMap[key].qty) {
        shortMap[key].qty = val;
      }
    });
  var shortage = Object.keys(shortMap)
    .map(function (k) { return shortMap[k]; })
    .filter(function (s) { return s.qty > 0; })
    .sort(function (a, b) { return b.qty - a.qty; });

  // ---- Trend: last 14 days, summed by Tab ----
  var last14 = uniqueDates.slice(-14);
  var trendMap = {};
  rows.forEach(function (r) {
    var d = normalizeDateKey(r[idx['Date']]);
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
