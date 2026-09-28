/**
 * Brain Trust Collectives - contact form endpoint.
 *
 * Deploy this bound to a Google Sheet owned by braintrustllp@gmail.com.
 * See apps-script/README.md for full setup and deployment steps.
 *
 * Expected POST fields (sent by js/main.js as FormData):
 *   name, email, company, vertical, message, website (honeypot)
 */

var SHEET_NAME = 'Submissions';
var HEADERS = ['timestamp', 'name', 'email', 'company', 'vertical', 'message'];
// These match the `pattern` attributes on the name/email inputs in
// contact.html - kept in sync deliberately, since this /exec URL is public
// and can be POSTed to directly, bypassing the browser form (and its
// validation) entirely.
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var NAME_DIGIT_RE = /[0-9]/;
// Only letters, numbers, spaces and - . [ ] ( ) - kept in sync with
// MESSAGE_ALLOWED_RE in js/main.js.
var MESSAGE_ALLOWED_RE = /^[A-Za-z0-9\s\-.[\]()]*$/;
var NOTIFY_TO = 'braintrustllp@gmail.com'; // comma-separate to add more recipients

// Web App response delivery back to the browser is unreliable on Apps
// Script's infrastructure - a request can succeed server-side (row written)
// while the client never sees the response and retries. This cache makes
// that safe: a retry carrying the same submission_id is recognized and
// short-circuited instead of writing a second row. 6 hours (the max TTL)
// comfortably outlives any realistic retry window.
var DEDUP_TTL_SECONDS = 21600;

function doPost(e) {
  try {
    var params = (e && e.parameter) || {};

    // Honeypot: bots fill every field, real users never see/fill this one.
    // Silently accept without writing a row, same as the client-side check.
    if (params.website) {
      return jsonResponse({ result: 'ok' });
    }

    var submissionId = String(params.submission_id || '').trim();
    var cache = submissionId ? CacheService.getScriptCache() : null;
    if (cache && cache.get('sub_' + submissionId)) {
      return jsonResponse({ result: 'ok' });
    }

    var name = String(params.name || '').trim();
    var email = String(params.email || '').trim();
    var message = String(params.message || '').trim();
    var company = String(params.company || '').trim();
    var vertical = params.vertical || '';

    if (!name || !email || !message) {
      return jsonResponse({ result: 'error', message: 'Missing required field' }, 400);
    }

    if (!EMAIL_RE.test(email)) {
      return jsonResponse({ result: 'error', message: 'Invalid email address' }, 400);
    }

    if (NAME_DIGIT_RE.test(name)) {
      return jsonResponse({ result: 'error', message: 'Name should not contain numbers' }, 400);
    }

    if (!MESSAGE_ALLOWED_RE.test(message)) {
      return jsonResponse({ result: 'error', message: 'Message contains characters that are not allowed' }, 400);
    }

    var sheet = getOrCreateSheet();
    sheet.appendRow([
      new Date(),
      sheetSafe(name),
      sheetSafe(email),
      sheetSafe(company),
      sheetSafe(vertical),
      sheetSafe(message)
    ]);

    // Mark this submission processed only after the row is safely written,
    // so a genuinely failed write is still eligible for a real retry.
    if (cache) {
      cache.put('sub_' + submissionId, 'true', DEDUP_TTL_SECONDS);
    }

    // Notification email is best-effort - a failure here must never lose or
    // fail the submission, since the row above is already written.
    try {
      sendNotification(
        { name: name, email: email, company: company, vertical: vertical, message: message },
        sheet.getLastRow()
      );
    } catch (mailErr) {
      console.error('Notification failed: ' + mailErr);
    }

    return jsonResponse({ result: 'ok' });
  } catch (err) {
    return jsonResponse({ result: 'error', message: String(err) }, 500);
  }
}

// Google Sheets treats a cell value starting with =, +, -, @ or a tab as a
// formula/expression - the same as if it had been typed straight into the
// UI. Without this, a submitted name or message like `=IMPORTXML(...)`
// would execute as a live formula the moment someone opens the sheet.
// Prefixing with a single quote forces it to be stored as plain text,
// matching how a leading apostrophe behaves when typed manually. This is
// applied only to the values written to the Sheet - the notification email
// below gets the original, unescaped text, since a plain-text email body
// can't execute a formula.
var FORMULA_TRIGGER_RE = /^[=+\-@\t]/;
function sheetSafe(s) {
  s = String(s || '');
  return FORMULA_TRIGGER_RE.test(s) ? "'" + s : s;
}

// Strips embedded newlines so a submitted value can't break across lines in
// the notification email's subject or header-style body lines. `message` is
// deliberately excluded - it's meant to stay multi-line in the body.
function singleLine(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').trim();
}

function sendNotification(fields, rowNumber) {
  var sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  var name = singleLine(fields.name);
  var email = singleLine(fields.email);
  var company = singleLine(fields.company);
  var vertical = singleLine(fields.vertical);

  var body = [
    'New enquiry from the Brain Trust website',
    '',
    'Name:     ' + name,
    'Email:    ' + email,
    'Company:  ' + company,
    'Vertical: ' + vertical,
    '',
    'Message:',
    fields.message,
    '',
    'Row ' + rowNumber + ' in Submissions: ' + sheetUrl
  ].join('\n');

  MailApp.sendEmail({
    to: NOTIFY_TO,
    replyTo: email,
    subject: 'New enquiry: ' + name.substring(0, 60) + (vertical ? ' (' + vertical + ')' : ''),
    body: body
  });
}

// Run once from the Apps Script editor (Run > testNotification) to trigger
// the authorization prompt for the Gmail send scope and confirm delivery,
// before relying on it from a live form submission.
function testNotification() {
  sendNotification({
    name: 'Test User',
    email: 'test@example.com',
    company: 'Test Co',
    vertical: 'IT Services',
    message: 'This is a test notification.'
  }, 0);
}

function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonResponse(obj, statusCode) {
  // Apps Script ContentService can't set a custom HTTP status for Web Apps -
  // statusCode is accepted here for readability only and ignored. The
  // response is always HTTP 200; js/main.js reads the JSON `result` field
  // to tell a logical success from a failure.
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
