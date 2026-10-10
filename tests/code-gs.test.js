'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCodeGs, makeEvent, parseResponse } = require('./gas-harness');

// getOrCreateSheet() writes the HEADERS row on first use, exactly like a
// real fresh Sheet - so row 1 is always the header and submissions start
// at row 2. Tests should assert against the data rows only.
function dataRows(state, sheetName = 'Submissions') {
  const sheet = state.sheetsByName.get(sheetName);
  return sheet ? sheet.rows.slice(1) : [];
}

function validParams(overrides) {
  return Object.assign(
    {
      name: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Acme Co',
      vertical: 'IT Services',
      message: 'Hello - we would like a quote.',
      submission_id: 'aaaa1111-bbbb-2222-cccc-333333333333',
    },
    overrides
  );
}

// --- Phase 2: input validation -------------------------------------------

test('valid submission is accepted, written to the Sheet, and emailed', () => {
  const { context, state } = loadCodeGs();
  const res = parseResponse(context.doPost(makeEvent(validParams())));

  assert.equal(res.result, 'ok');
  assert.equal(dataRows(state).length, 1);
  assert.equal(state.sentEmails.length, 1);
});

test('missing required fields are rejected without writing a row or sending email', () => {
  for (const field of ['name', 'email', 'message']) {
    const { context, state } = loadCodeGs();
    const params = validParams();
    params[field] = '';
    const res = parseResponse(context.doPost(makeEvent(params)));

    assert.equal(res.result, 'error');
    assert.equal(state.sheetsByName.size, 0);
    assert.equal(state.sentEmails.length, 0);
  }
});

test('whitespace-only required fields are rejected (trimmed to empty)', () => {
  const { context, state } = loadCodeGs();
  const res = parseResponse(context.doPost(makeEvent(validParams({ name: '   ' }))));

  assert.equal(res.result, 'error');
  assert.equal(state.sentEmails.length, 0);
});

test('invalid email addresses are rejected server-side', () => {
  for (const bad of ['not-an-email', 'missing-at.example.com', 'a@b', 'a b@example.com']) {
    const { context } = loadCodeGs();
    const res = parseResponse(context.doPost(makeEvent(validParams({ email: bad }))));
    assert.equal(res.result, 'error', `expected "${bad}" to be rejected`);
  }
});

test('name containing digits is rejected server-side, independent of the client pattern attribute', () => {
  const { context } = loadCodeGs();
  const res = parseResponse(context.doPost(makeEvent(validParams({ name: 'Jane2Doe' }))));
  assert.equal(res.result, 'error');
});

test('message with disallowed characters is rejected server-side', () => {
  const { context } = loadCodeGs();
  const res = parseResponse(context.doPost(makeEvent(validParams({ message: '<script>alert(1)</script>' }))));
  assert.equal(res.result, 'error');
});

test('maximum field length boundaries: exactly at the cap is accepted, one over is rejected', () => {
  const atCap = 'a'.repeat(100);
  const overCap = 'a'.repeat(101);

  {
    const { context } = loadCodeGs();
    const res = parseResponse(context.doPost(makeEvent(validParams({ name: atCap }))));
    assert.equal(res.result, 'ok');
  }
  {
    const { context } = loadCodeGs();
    const res = parseResponse(context.doPost(makeEvent(validParams({ name: overCap }))));
    assert.equal(res.result, 'error');
  }

  const messageAtCap = 'a'.repeat(5000);
  const messageOverCap = 'a'.repeat(5001);
  {
    const { context } = loadCodeGs();
    const res = parseResponse(context.doPost(makeEvent(validParams({ message: messageAtCap }))));
    assert.equal(res.result, 'ok');
  }
  {
    const { context } = loadCodeGs();
    const res = parseResponse(context.doPost(makeEvent(validParams({ message: messageOverCap }))));
    assert.equal(res.result, 'error');
  }
});

test('an unrecognized "vertical" value is rejected (server no longer trusts the client dropdown)', () => {
  const { context, state } = loadCodeGs();
  const res = parseResponse(
    context.doPost(makeEvent(validParams({ vertical: 'Totally Made Up Vertical' })))
  );
  assert.equal(res.result, 'error');
  assert.equal(state.sheetsByName.size, 0);
});

test('an empty "vertical" value is still accepted (optional field, unchanged behavior)', () => {
  const { context } = loadCodeGs();
  const res = parseResponse(context.doPost(makeEvent(validParams({ vertical: '' }))));
  assert.equal(res.result, 'ok');
});

test('unexpected extra parameters (including a __proto__ key) are ignored safely', () => {
  const { context, state } = loadCodeGs();
  const params = validParams({ admin: 'true', __proto__: { polluted: true } });
  const res = parseResponse(context.doPost(makeEvent(params)));

  assert.equal(res.result, 'ok');
  assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
  const [row] = dataRows(state);
  assert.equal(row.length, 6, 'row has exactly the 6 intended columns, nothing extra');
});

test('server error responses never echo raw exception detail back to the caller', () => {
  const { context } = loadCodeGs({ appendRowThrows: true });
  const res = parseResponse(context.doPost(makeEvent(validParams())));

  assert.equal(res.result, 'error');
  assert.doesNotMatch(res.message, /Service Spreadsheets|Internal error/i);
  assert.equal(res.message, 'Something went wrong on our end. Please try again, or email hello@braintrustllp.com directly.');
});

// --- Phase 3: injection ----------------------------------------------------

test('spreadsheet formula injection is neutralized for every text field', () => {
  const { context, state } = loadCodeGs();
  const payload = {
    name: 'Jane Doe',
    company: '=HYPERLINK("http://evil.example")',
    // Stays within MESSAGE_ALLOWED_RE's character set (letters, numbers,
    // spaces, - . [ ] ( )) while still starting with a formula-trigger
    // character, so this exercises sheetSafe() rather than tripping the
    // unrelated character-allowlist check.
    message: '-1 - 1 (should stay literal text)',
  };
  const res = parseResponse(context.doPost(makeEvent(validParams(payload))));
  assert.equal(res.result, 'ok');

  const [row] = dataRows(state);
  const [, , , storedCompany, , storedMessage] = row;

  assert.equal(storedCompany[0], "'", 'formula-triggering company value must be stored as text');
  assert.equal(storedCompany, "'" + payload.company);
  assert.equal(storedMessage[0], "'", 'formula-triggering message value must be stored as text');
});

test('every formula-trigger character (= + - @) survives the full request pipeline neutralized', () => {
  // Tab is deliberately excluded here: doPost() trims the company field
  // before it ever reaches sheetSafe(), which strips a *leading* tab on its
  // own - so this exercises the other four trigger characters end-to-end,
  // and the tab case is verified directly against sheetSafe() below.
  for (const trigger of ['=', '+', '-', '@']) {
    const { context, state } = loadCodeGs();
    const res = parseResponse(
      context.doPost(makeEvent(validParams({ company: trigger + 'SUM(A1:A9)' })))
    );
    assert.equal(res.result, 'ok');
    const [row] = dataRows(state);
    assert.equal(row[3][0], "'", `trigger ${JSON.stringify(trigger)} should be neutralized`);
  }
});

test('sheetSafe() neutralizes a leading tab directly (defense in depth if ever called without a prior trim)', () => {
  const { context } = loadCodeGs();
  const result = context.sheetSafe('\tSUM(A1:A9)');
  assert.equal(result[0], "'");
});

test('notification email is plain text only - no HTML body exists for injected markup to render in', () => {
  const { context, state } = loadCodeGs();
  const res = parseResponse(
    context.doPost(makeEvent(validParams({ company: '<img src=x onerror=alert(1)>' })))
  );
  assert.equal(res.result, 'ok');

  const email = state.sentEmails[0];
  assert.equal(Object.prototype.hasOwnProperty.call(email, 'htmlBody'), false);
  assert.ok(email.body.includes('<img src=x onerror=alert(1)>'), 'plain-text body contains the literal text, inert as plain text');
});

test('CRLF in name cannot inject a new header-like line into the notification email body', () => {
  const { context, state } = loadCodeGs();
  // Note: NAME_DIGIT_RE only forbids digits, so a CR/LF in `name` reaches
  // sendNotification() - singleLine() is what's actually responsible for
  // neutralizing it there, by folding it onto one line rather than letting
  // it start a new line that could be mistaken for a real header/field.
  const res = parseResponse(
    context.doPost(makeEvent(validParams({ name: 'Jane\r\nBcc: attacker@evil.example' })))
  );
  assert.equal(res.result, 'ok');

  const email = state.sentEmails[0];
  assert.doesNotMatch(email.subject, /[\r\n]/, 'subject must stay on one line');

  const lines = email.body.split('\n');
  assert.ok(
    !lines.includes('Bcc: attacker@evil.example'),
    'the injected text must not become its own standalone line in the body'
  );
  assert.ok(
    lines.some((l) => l.startsWith('Name:') && l.includes('Bcc: attacker@evil.example')),
    'singleLine() should fold the injected text onto the existing Name: line, not drop it'
  );
});

test('reply-to is always the validated submitter email - never attacker-controlled beyond that', () => {
  const { context, state } = loadCodeGs();
  parseResponse(context.doPost(makeEvent(validParams({ email: 'jane@example.com' }))));
  assert.equal(state.sentEmails[0].replyTo, 'jane@example.com');
});

test('notification recipient ("to") is always the fixed NOTIFY_TO constant, never request-controlled', () => {
  const { context, state } = loadCodeGs();
  parseResponse(
    context.doPost(makeEvent(validParams({ to: 'someone-else@attacker.example' })))
  );
  assert.equal(state.sentEmails[0].to, 'braintrustllp@gmail.com');
});

// --- Phase 4/5: endpoint exposure & honeypot ------------------------------

test('doGet is not defined - the endpoint cannot be used to read spreadsheet contents', () => {
  const { context } = loadCodeGs();
  assert.equal(typeof context.doGet, 'undefined');
});

test('honeypot field being filled silently drops the submission server-side', () => {
  const { context, state } = loadCodeGs();
  const res = parseResponse(context.doPost(makeEvent(validParams({ website: 'http://bot.example' }))));

  assert.equal(res.result, 'ok');
  assert.equal(state.sheetsByName.size, 0);
  assert.equal(state.sentEmails.length, 0);
});

// --- Phase 5/6: rate limiting, dedup, locking -----------------------------

test('a flood of unique submissions within one window is throttled silently - disguised as "ok", by design', () => {
  // Deliberate choice (revisited and reaffirmed): the rate limiter can't
  // tell a bot from a real visitor, so it never reveals itself via an
  // error response - a caller that could see the difference between 'ok'
  // and "throttled" could start adapting around the limit. The actual
  // protection (the Sheet/inbox/mail quota) is unaffected by this choice:
  // appendRow()/sendNotification() are never reached once isRateLimited()
  // is true, regardless of what's returned to the caller.
  const { context, state } = loadCodeGs();
  const results = [];
  for (let i = 0; i < 25; i++) {
    results.push(
      parseResponse(
        context.doPost(
          makeEvent(validParams({ submission_id: 'id-' + i, message: 'Message number ' + i }))
        )
      )
    );
  }
  assert.equal(dataRows(state).length, 20, 'exactly RATE_LIMIT_MAX_PER_WINDOW rows written in one window, no more');

  const throttled = results.slice(20);
  assert.ok(
    throttled.every((r) => r.result === 'ok'),
    'a throttled request must still report "ok" - no signal to the caller that anything was dropped'
  );
});

test('rate-limit window boundary: the cap resets in the next window (documented, bounded ~2x burst, not an unbounded bypass)', () => {
  const { context, state } = loadCodeGs();
  const realNow = Date.now;
  try {
    let fakeNow = Math.floor(realNow() / 60000) * 60000; // align to a window start
    Date.now = () => fakeNow;

    for (let i = 0; i < 20; i++) {
      const res = parseResponse(
        context.doPost(makeEvent(validParams({ submission_id: 'win1-' + i })))
      );
      assert.equal(res.result, 'ok');
    }
    const blocked = parseResponse(
      context.doPost(makeEvent(validParams({ submission_id: 'win1-blocked' })))
    );
    assert.equal(blocked.result, 'ok', 'throttled requests are disguised as "ok" by design (see the test above)');
    assert.equal(dataRows(state).length, 20, 'but the 21st request in the same window must not actually write a row');

    fakeNow += 60000; // advance exactly one window

    const firstOfNextWindow = parseResponse(
      context.doPost(makeEvent(validParams({ submission_id: 'win2-0' })))
    );
    assert.equal(
      firstOfNextWindow.result,
      'ok',
      'a fresh window must admit requests again - this is the known, documented fixed-window boundary behavior'
    );
    assert.equal(dataRows(state).length, 21, '20 from window 1 + 1 from window 2');
  } finally {
    Date.now = realNow;
  }
});

test('duplicate submission_id is deduplicated: exactly one row, one email, regardless of retries', () => {
  const { context, state } = loadCodeGs();
  const params = validParams({ submission_id: 'retry-id-123' });

  const first = parseResponse(context.doPost(makeEvent(params)));
  const second = parseResponse(context.doPost(makeEvent(params)));
  const third = parseResponse(context.doPost(makeEvent(params)));

  assert.equal(first.result, 'ok');
  assert.equal(second.result, 'ok');
  assert.equal(third.result, 'ok');

  assert.equal(dataRows(state).length, 1, 'retries of the same submission_id must not create duplicate rows');
  assert.equal(state.sentEmails.length, 1, 'retries of the same submission_id must not resend the email');
});

test('CONFIRMED (accepted risk): a missing submission_id has no idempotency guarantee at all - repeats create separate rows', () => {
  // sanitizeSubmissionId() treats an absent id as '', and doPost() only
  // runs the dedup check `if (submissionId && ...)`, so two requests with
  // no id are indistinguishable from two genuinely different submissions.
  // This is intentional, not a regression: there is nothing safe to key
  // dedup on without an id, and the real client (js/main.js) always
  // supplies a crypto.randomUUID() id, so this only affects a direct POST
  // that omits it. The practical blast radius is bounded by the rate
  // limiter (SEC-003), not by this mechanism.
  const { context, state } = loadCodeGs();
  const params = validParams();
  delete params.submission_id;

  const first = parseResponse(context.doPost(makeEvent(params)));
  const second = parseResponse(context.doPost(makeEvent(params)));

  assert.equal(first.result, 'ok');
  assert.equal(second.result, 'ok');
  assert.equal(dataRows(state).length, 2, 'no id means no dedup key - this is expected, not a bypass of a guarantee that was ever made');
});

test('CONFIRMED (platform ceiling, not a defect): dedup cache entries expire after DEDUP_TTL_SECONDS, allowing a duplicate on a very late retry', () => {
  const { context, state } = loadCodeGs();
  const realNow = Date.now;
  try {
    let fakeNow = realNow();
    Date.now = () => fakeNow;

    const params = validParams({ submission_id: 'late-retry-id' });
    const first = parseResponse(context.doPost(makeEvent(params)));
    assert.equal(first.result, 'ok');
    assert.equal(dataRows(state).length, 1);

    fakeNow += 6 * 60 * 60 * 1000 + 1000; // DEDUP_TTL_SECONDS (21600s = 6h, the CacheService maximum) + 1s

    const retryAfterExpiry = parseResponse(context.doPost(makeEvent(params)));
    assert.equal(retryAfterExpiry.result, 'ok');
    assert.equal(
      dataRows(state).length,
      2,
      'expected: 21600s is the CacheService-enforced maximum TTL, not a value this code can raise further'
    );
  } finally {
    Date.now = realNow;
  }
});

test('an oversized/malformed submission_id is rejected as an id (dedup skipped) rather than crashing the request', () => {
  const { context, state } = loadCodeGs();
  const hugeId = 'x'.repeat(5000); // would exceed CacheService's 250-byte key limit if used raw
  const res = parseResponse(context.doPost(makeEvent(validParams({ submission_id: hugeId }))));

  assert.equal(res.result, 'ok', 'must not crash or surface a 500 just because the id is malformed');
  assert.equal(dataRows(state).length, 1);
});

test('a CacheService failure on an oversized key does not corrupt the response or duplicate the row', () => {
  // Simulates the original bug directly: if submission_id sanitization were
  // ever removed/bypassed and cache.put() threw on an oversized key, the
  // request must still fail safely (generic message, no crash) rather than
  // leaking the cache error - sanitizeSubmissionId() is what prevents this
  // key from ever reaching cache.put() in the first place.
  const { context, state } = loadCodeGs({
    cachePutThrowsFor: (key) => key.length > 250,
  });
  const hugeId = 'y'.repeat(5000);
  const res = parseResponse(context.doPost(makeEvent(validParams({ submission_id: hugeId }))));

  assert.equal(res.result, 'ok');
  assert.equal(dataRows(state).length, 1);
});

test('a cache failure AFTER a successful appendRow must not be reported as a request failure (would cause a client retry to duplicate the row)', () => {
  // This is a materially different scenario from the two tests above: here
  // the key is a normal, valid-length key, and cache.put() throws for an
  // unrelated reason (a transient CacheService error, quota hiccup, etc.
  // unrelated to submission_id). Confirms doPost() swallows this failure
  // (logging it) rather than letting it propagate to the outer catch,
  // since the row is already the source of truth and was already written.
  const { context, state } = loadCodeGs({ cachePutThrowsFor: () => true });
  const res = parseResponse(context.doPost(makeEvent(validParams({ submission_id: 'cache-fails-after-write' }))));

  assert.equal(res.result, 'ok', 'the write already succeeded - this must not be reported as an error');
  assert.equal(dataRows(state).length, 1);
  assert.ok(state.consoleErrors.some((m) => m.includes('Post-write cache bookkeeping failed')));
});

test(
  'lock contention: a second overlapping request is rejected cleanly instead of racing the dedup check ' +
    '(true concurrent execution cannot be reproduced in a synchronous test; this exercises the ' +
    'lock-unavailable code path that LockService enforces at runtime)',
  () => {
    const { context, state } = loadCodeGs({ lockUnavailable: true });
    const res = parseResponse(context.doPost(makeEvent(validParams())));

    assert.equal(res.result, 'error');
    assert.equal(state.sheetsByName.size, 0, 'no row written when the critical section could not be entered');
    assert.equal(state.sentEmails.length, 0);
  }
);

test('the script lock is always released, including when appendRow throws', () => {
  const { context, state } = loadCodeGs({ appendRowThrows: true });
  parseResponse(context.doPost(makeEvent(validParams())));
  assert.equal(state.lockHeldCount, 0, 'lock must be released even on failure (finally block)');
});

// --- Phase 7/8: Sheets + email failure handling ---------------------------

test('a Sheets write failure returns a generic error and sends no email', () => {
  const { context, state } = loadCodeGs({ appendRowThrows: true });
  const res = parseResponse(context.doPost(makeEvent(validParams())));

  assert.equal(res.result, 'error');
  assert.equal(state.sentEmails.length, 0);
});

test('an email-send failure does not fail the submission or duplicate the row on retry (row already safely written)', () => {
  const { context, state } = loadCodeGs({ mailThrows: true });
  const params = validParams({ submission_id: 'retry-after-mail-fail' });

  const first = parseResponse(context.doPost(makeEvent(params)));
  const second = parseResponse(context.doPost(makeEvent(params)));

  assert.equal(first.result, 'ok', 'row-write success must still report ok even if the email failed');
  assert.equal(second.result, 'ok');
  assert.equal(dataRows(state).length, 1);
  assert.equal(state.sentEmails.length, 0);
  assert.ok(state.consoleErrors.some((m) => m.includes('Notification failed')));
});

test('the Sheet row columns always match HEADERS order: timestamp, name, email, company, vertical, message', () => {
  const { context, state } = loadCodeGs();
  parseResponse(context.doPost(makeEvent(validParams())));
  const [row] = dataRows(state);

  assert.ok(row[0] instanceof Date);
  assert.equal(row[1], 'Jane Doe');
  assert.equal(row[2], 'jane@example.com');
  assert.equal(row[3], 'Acme Co');
  assert.equal(row[4], 'IT Services');
  assert.equal(row[5], 'Hello - we would like a quote.');
});

test('the honeypot field is never forwarded into the notification email fields', () => {
  const { context, state } = loadCodeGs();
  parseResponse(context.doPost(makeEvent(validParams())));
  const email = state.sentEmails[0];
  assert.equal(Object.prototype.hasOwnProperty.call(email, 'website'), false);
});
