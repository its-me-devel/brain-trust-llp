/**
 * Brain Trust Collectives - contact form endpoint.
 *
 * Deploy this bound to a Google Sheet owned by braintrustllp@gmail.com.
 * See apps-script/README.md for full setup and deployment steps.
 *
 * Expected POST fields (sent by js/main.js as FormData):
 *   name, email, company, vertical, message, website (honeypot), submission_id
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

// Hard caps so a direct POST (which doesn't go through the browser form's
// HTML attributes at all) can't push an oversized value into Sheets - a
// cell value near Sheets' ~50,000-character limit throws when appendRow()
// runs, and that throw happens deep inside the request, after other checks
// have already passed.
var MAX_NAME_LENGTH = 100;
var MAX_EMAIL_LENGTH = 200;
var MAX_COMPANY_LENGTH = 200;
var MAX_MESSAGE_LENGTH = 5000;

// Mirrors the <select> options in contact.html. The dropdown constrains this
// client-side, but the /exec URL is public - a direct POST could send any
// string here unless it's re-checked server-side. Empty/omitted is allowed
// through unchanged (matches a direct POST that simply leaves it out); only
// a non-empty, unrecognized value is rejected.
var ALLOWED_VERTICALS = [
  'General enquiry',
  'Industrial Project Management',
  'Legal Services',
  'Core HR / HR Facilitation',
  'Counselling & Coaching',
  'IT Services'
];

// submission_id is attacker-controllable (it's a client-generated value
// echoed back from a public endpoint) and is used below as a CacheService
// key. CacheService keys are capped at 250 bytes - an oversized or
// otherwise malformed id must never reach cache.put()/cache.get()
// unvalidated, or the resulting exception (thrown *after* the Sheet row for
// this submission is already written) would both leak internal error
// detail to the caller and leave the submission permanently
// un-deduplicated, so a retry with the same bad id would write a second
// row. An id that fails this check is treated as if no id were supplied at
// all - dedup is simply skipped for that one request rather than the
// request failing.
var SUBMISSION_ID_RE = /^[A-Za-z0-9-]{1,100}$/;

// Web App response delivery back to the browser is unreliable on Apps
// Script's infrastructure - a request can succeed server-side (row written)
// while the client never sees the response and retries. This cache makes
// that safe: a retry carrying the same submission_id is recognized and
// short-circuited instead of writing a second row. 6 hours (the max TTL)
// comfortably outlives any realistic retry window.
var DEDUP_TTL_SECONDS = 21600;

// Coarse, global (not per-caller) throttle. Apps Script's doPost(e) event
// object has no field carrying the caller's IP address, so per-attacker
// rate limiting isn't implementable at this layer at all - this instead
// bounds total submission throughput across every caller combined, to
// protect the Sheet, the owner's inbox, and the account's daily MailApp
// send quota from a scripted flood. The increment itself is read-then-write
// rather than atomic, but every request that reaches it already holds the
// script lock (see LOCK_TIMEOUT_MS below), so concurrent executions can't
// race on it - the real imprecision is the fixed-window boundary: a burst
// split across two adjacent windows can momentarily admit up to ~2x this
// cap. That's accepted as a bounded, documented limitation rather than
// fixed with a sliding window, which CacheService doesn't support cleanly.
var RATE_LIMIT_WINDOW_SECONDS = 60;
var RATE_LIMIT_MAX_PER_WINDOW = 20;

// The script lock serializes the dedup-check -> append -> dedup-write ->
// rate-limit-write sequence across concurrent executions of this script, so
// two requests racing on the same submission_id (e.g. two retries of the
// same failed request firing close together) can't both pass the dedup
// check before either one writes it - which would otherwise write two rows
// for one logical submission.
var LOCK_TIMEOUT_MS = 10000;

var GENERIC_ERROR_MESSAGE = 'Something went wrong on our end. Please try again, or email hello@braintrustllp.com directly.';

function doPost(e) {
  try {
    var params = (e && e.parameter) || {};

    // Honeypot: bots fill every field, real users never see/fill this one.
    // Silently accept without writing a row, same as the client-side check.
    if (params.website) {
      return jsonResponse({ result: 'ok' });
    }

    var submissionId = sanitizeSubmissionId(params.submission_id);

    var name = String(params.name || '').trim();
    var email = String(params.email || '').trim();
    var message = String(params.message || '').trim();
    var company = String(params.company || '').trim();
    var vertical = String(params.vertical || '').trim();

    if (!name || !email || !message) {
      return jsonResponse({ result: 'error', message: 'Missing required field' }, 400);
    }

    if (name.length > MAX_NAME_LENGTH || email.length > MAX_EMAIL_LENGTH ||
        company.length > MAX_COMPANY_LENGTH || message.length > MAX_MESSAGE_LENGTH) {
      return jsonResponse({ result: 'error', message: 'One or more fields are too long' }, 400);
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

    if (vertical && ALLOWED_VERTICALS.indexOf(vertical) === -1) {
      return jsonResponse({ result: 'error', message: 'Invalid vertical selection' }, 400);
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
      return jsonResponse({ result: 'error', message: GENERIC_ERROR_MESSAGE }, 503);
    }

    var sheet;
    try {
      var cache = CacheService.getScriptCache();

      if (isRateLimited(cache)) {
        // Deliberately disguised as a normal success, not an error: this
        // throttle has no way to tell a bot from a real visitor, but a
        // caller that can see the difference between 'ok' and a throttled
        // error can start adapting around the limit (slow down, rotate
        // something, probe for the exact threshold). The Sheet/inbox/mail
        // quota are already fully protected regardless of what's returned
        // here - appendRow()/sendNotification() are never reached on this
        // path either way - so this only trades "a genuine visitor caught
        // in a throttled window sees a false success" against "a scripted
        // flood gets no signal it's being throttled." Decided in favor of
        // not tipping off abuse; revisit if real visitors start reporting
        // messages that never arrived.
        return jsonResponse({ result: 'ok' });
      }

      if (submissionId && cache.get('sub_' + submissionId)) {
        return jsonResponse({ result: 'ok' });
      }

      sheet = getOrCreateSheet();
      sheet.appendRow([
        new Date(),
        sheetSafe(name),
        sheetSafe(email),
        sheetSafe(company),
        sheetSafe(vertical),
        sheetSafe(message)
      ]);

      // The row above is already safely written and is the source of
      // truth - from here on, a failure updating the dedup marker or the
      // rate-limit counter must never be allowed to make this request look
      // like it failed. If it did, the client would retry and append a
      // second row for a submission that had already succeeded, which is
      // exactly the duplicate-row failure mode the dedup marker exists to
      // prevent in the first place.
      try {
        if (submissionId) {
          cache.put('sub_' + submissionId, 'true', DEDUP_TTL_SECONDS);
        }
        recordRateLimitHit(cache);
      } catch (cacheErr) {
        console.error('Post-write cache bookkeeping failed: ' + cacheErr);
      }
    } finally {
      lock.releaseLock();
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
    // Never echo the raw exception back to a caller - Apps Script error
    // messages can include sheet names, quota detail, or other internals.
    // Log the real error for the owner to find in the Apps Script
    // execution log, and return a generic message instead.
    console.error('doPost failed: ' + err);
    return jsonResponse({ result: 'error', message: GENERIC_ERROR_MESSAGE }, 500);
  }
}

function sanitizeSubmissionId(raw) {
  var id = String(raw || '').trim();
  return SUBMISSION_ID_RE.test(id) ? id : '';
}

function rateLimitKey() {
  return 'rl_' + Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
}

function isRateLimited(cache) {
  return Number(cache.get(rateLimitKey()) || 0) >= RATE_LIMIT_MAX_PER_WINDOW;
}

function recordRateLimitHit(cache) {
  var key = rateLimitKey();
  var count = Number(cache.get(key) || 0);
  cache.put(key, String(count + 1), RATE_LIMIT_WINDOW_SECONDS * 2);
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
