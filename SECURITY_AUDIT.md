# Security Audit — Contact Form (`contact.html` → Apps Script → Sheets/Email)

**Scope:** `contact.html`, `js/main.js`, `apps-script/Code.gs`, and the rest
of this static site, as they exist in this repository.
**Date:** 2026-10-10.
**Method:** Static source review of every file in scope, plus a local,
fully-mocked test suite (`tests/`) exercising `Code.gs` against a fake
`SpreadsheetApp` / `MailApp` / `CacheService` / `LockService` /
`ContentService`. **No request was sent to the live `/exec` URL, no real
Sheet was written to, and no real email was sent** — per the audit's own
constraints, all verification is against local mocks.

> **This report's fixes are committed to this repo only.** Apps Script does
> not deploy automatically from git — `apps-script/Code.gs` must be
> re-pasted into the Apps Script editor and redeployed (**Deploy → Manage
> deployments → Edit → New version → Deploy**, per `apps-script/README.md`)
> before any of the fixes below take effect on the live site. Until that's
> done, the live endpoint still runs the old code.

## A. Executive Summary

**Overall posture: reasonable for a low-value public contact form, with one
real design gap (no concurrency/rate control) that this audit closes.**
Nothing found rises to "actively exploited" severity — there's no PII
breach, no stored-XSS, and the formula-injection protection that mattered
most was already correctly implemented. The real gaps were all in the
"what happens under a malicious or merely bad-id direct POST" category:
missing length/allowlist checks, an unvalidated cache key that could both
crash *and* defeat its own duplicate-prevention purpose, no concurrency
control, no abuse throttle, and raw exception text being returned to
callers.

**Verified findings: 8** (7 fixed, 1 deliberately reverted after owner
review — see below) **+ 2 informational / architecture-limitation items**
(documented, not independently fixable in this codebase without a new
external service). Two of the 8 (SEC-009, SEC-010) were found during an
independent follow-up review (§G) that re-verified the first pass rather
than trusting its conclusions — see §G for the full 8-point re-check this
triggered.

**SEC-009 was fixed, then reverted at the site owner's explicit request**
after a discussion of the trade-off it embodies (full rationale in its
write-up in §C): the original design deliberately disguises a
rate-limited request as a normal success, specifically so a scripted
abuser gets no signal that it's being throttled and can't adapt around the
limit. The fix had replaced that with an honest error. On review, the
owner judged denying that signal to a bot more valuable than the cost of
an occasional genuine visitor seeing a false "received" during a throttled
burst, and asked for the original behavior back. **This does not weaken
the actual protection** — the Sheet, inbox, and mail quota are protected
identically either way, since `appendRow()`/`sendNotification()` are never
reached once the rate limit is hit, regardless of what the caller is told.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 6 (5 fixed, 1 — SEC-009 — reverted by owner decision) |
| Low / Informational | 2 |

## B. Findings Table

| ID | Severity | Vulnerability | File/Function | Evidence | Status |
|---|---|---|---|---|---|
| SEC-001 | High | Unvalidated `submission_id` used as a `CacheService` key; an oversized/malformed id throws *after* the Sheet row is already written, both leaking exception text to the caller and leaving the submission un-deduplicated (so a retry duplicates the row) | `Code.gs` → `doPost()` | `tests/code-gs.test.js`: *"an oversized/malformed submission_id…"*, *"a CacheService failure on an oversized key…"* | **Fixed** |
| SEC-002 | High | No concurrency control around check-dedup → append → write-dedup; two requests racing on the same `submission_id` could both pass the dedup check before either wrote it, producing two rows for one submission | `Code.gs` → `doPost()` | `tests/code-gs.test.js`: *"lock contention…"*, *"the script lock is always released…"* | **Fixed** |
| SEC-003 | Medium | No rate limiting of any kind; the `/exec` URL is public and can be scripted to flood the Sheet, the owner's inbox, and the account's daily `MailApp` send quota | `Code.gs` → `doPost()` | `tests/code-gs.test.js`: *"a flood of unique submissions within one window is throttled…"* | **Fixed** (best-effort global throttle — see §F for why per-attacker limiting isn't possible here) |
| SEC-004 | Medium | `vertical` field not checked against the fixed option list server-side; a direct POST can inject an arbitrary string into the Sheet and the notification email, bypassing the `<select>`'s constraint | `Code.gs` → `doPost()` | `tests/code-gs.test.js`: *"an unrecognized 'vertical' value is rejected…"* | **Fixed** |
| SEC-005 | Medium | No server-side maximum length on `name`/`email`/`company`/`message`; an oversized value can trip a Sheets cell-size error, feeding into SEC-001 and SEC-006 | `Code.gs` → `doPost()` | `tests/code-gs.test.js`: *"maximum field length boundaries…"* | **Fixed** |
| SEC-006 | Medium | The top-level `catch` returned `String(err)` straight to the HTTP caller — Apps Script exception text can include sheet names, quota detail, and other internals | `Code.gs` → `doPost()` outer `catch` | `tests/code-gs.test.js`: *"server error responses never echo raw exception detail…"* | **Fixed** |
| SEC-007 | Low (informational) | A failed notification email is only logged to the Apps Script execution log, which nobody actively watches — if `MailApp`'s daily quota is ever exhausted (e.g. by SEC-003-style abuse before this fix), enquiry notifications could silently stop with no visible symptom | `Code.gs` → `sendNotification()` call site in `doPost()` | Code inspection; by-design behavior, confirmed via `tests/code-gs.test.js`: *"an email-send failure does not fail the submission…"* | **Not fixed — documented risk** (see §F) |
| SEC-008 | Low (informational) | The honeypot field is trivially bypassed by any bot that POSTs directly to the (necessarily public) `/exec` URL without the `website` field — an inherent limitation of the honeypot technique itself, not a defect in this implementation | `Code.gs` → `doPost()`; `js/main.js` | Code inspection | **Not fixed — documented limitation**, partially mitigated by SEC-003's new throttle |
| SEC-009 | Medium | **Found in follow-up review, then reverted by owner decision.** A rate-limited request returns a disguised `{result:'ok'}` — a real visitor whose submission was throttled would see "Thanks, a partner will be in touch" for a message that was never written to the Sheet or emailed anywhere. First fixed to return an honest error; the site owner reviewed the trade-off and asked to keep the original disguised-success behavior instead, to deny a scripted abuser any signal it's being throttled. **The actual protection — the Sheet/inbox/quota never being written to on this path — is identical in both versions.** | `Code.gs` → `doPost()`, the `isRateLimited(cache)` branch (line 146) | `tests/code-gs.test.js`: *"a flood of unique submissions… throttled silently - disguised as 'ok', by design"* | **Reverted to original behavior — owner decision, not a defect** (full rationale below) |
| SEC-010 | Medium | **Found in follow-up review.** `cache.put()`/`recordRateLimitHit()` ran with no try/catch of their own, *after* a successful `appendRow()`. Any cache failure unrelated to the already-fixed key-length issue (SEC-001) — a transient `CacheService` error, a quota hiccup — would propagate to the outer `catch`, making an already-persisted submission report `{result:'error'}` to the caller. The client (`js/main.js`) would then retry, re-running the whole request and appending a **second** row for a submission that had already succeeded the first time. | `Code.gs` → `doPost()`, lines 186–193 | `tests/code-gs.test.js`: *"a cache failure AFTER a successful appendRow must not be reported as a request failure…"* | **Fixed** |

## C. Detailed Findings

### SEC-001 — Unvalidated `submission_id` used as an unbounded cache key
**Root cause.** `submission_id` is a client-generated value sent with every
request and used verbatim as `cache.put('sub_' + submissionId, ...)` /
`cache.get('sub_' + submissionId)`. `CacheService` keys are capped at 250
bytes. Because `cache.put()` ran *after* `sheet.appendRow(...)`, an
oversized or otherwise invalid id would throw only once the row was
already written — and that throw was caught by the outer `catch`, which
(see SEC-006) returned the raw error to the caller. Worse: since the dedup
entry was never written, a client that retried after seeing that error
would hit `appendRow` again for the same logical submission, producing a
duplicate row — the exact failure mode the dedup cache exists to prevent.

**File/function.** `apps-script/Code.gs`, `doPost()`.

**Reproduction (local mock).** `tests/code-gs.test.js` →
*"a CacheService failure on an oversized key does not corrupt the response
or duplicate the row"* feeds a 5,000-character `submission_id` through a
cache mock that throws for keys over 250 bytes, matching the real
`CacheService` limit.

**Impact.** Availability/integrity (duplicate Sheet rows, duplicate
notification emails on retry) and minor information disclosure (raw
exception text) — reachable by any direct POST to the public endpoint, no
authentication needed.

**Fix.** Added `SUBMISSION_ID_RE = /^[A-Za-z0-9-]{1,100}$/` and
`sanitizeSubmissionId()`; an id that doesn't match is treated as if no id
were supplied (dedup simply skipped for that one request) instead of being
passed to `CacheService` unvalidated. `crypto.randomUUID()` output (the
normal client path) always matches this pattern, so legitimate submissions
are unaffected.

**Regression test.** `tests/code-gs.test.js`: *"an oversized/malformed
submission_id is rejected as an id…"*, *"a CacheService failure on an
oversized key…"*.

---

### SEC-002 — Missing concurrency control (race condition on duplicate rows)
**Root cause.** The sequence *check cache → append row → write cache* had
no lock around it. Two requests carrying the same `submission_id` arriving
close together (e.g. the client's own built-in retry firing before the
first request's cache write lands, or a deliberate concurrent replay)
could both observe "not yet seen" from `cache.get()` before either call
reached `cache.put()`, and both would append a row.

**File/function.** `apps-script/Code.gs`, `doPost()`.

**Reproduction.** True concurrent script execution can't be reproduced in
a synchronous Node test harness — this is noted explicitly rather than
faked. What *is* verified: the fixed code's behavior when the lock cannot
be acquired (the condition `LockService` enforces at runtime when two
executions genuinely overlap) — `tests/code-gs.test.js`: *"lock
contention: a second overlapping request is rejected cleanly…"*, and that
the lock is always released even when the critical section throws:
*"the script lock is always released, including when appendRow throws"*.

**Impact.** Integrity — duplicate Sheet rows and duplicate notification
emails under concurrent/retried requests, defeating the dedup mechanism's
entire purpose.

**Fix.** Wrapped the check-dedup → append → write-dedup →
record-rate-limit sequence in `LockService.getScriptLock().tryLock(10000)`,
with `releaseLock()` in a `finally` block. If the lock can't be acquired
within 10s, the request fails cleanly (generic error, nothing written)
rather than racing.

---

### SEC-003 — No rate limiting / abuse throttle
**Root cause.** Nothing bounded submission volume beyond the honeypot
(which a scripted attacker simply doesn't fill in). The public `/exec` URL
could be flooded to fill the Sheet, spam the owner's inbox, and exhaust the
Google account's daily `MailApp` send quota (after which, per SEC-007,
failures become invisible).

**Important constraint, verified by code inspection:** Apps Script's
`doPost(e)` event object carries no field for the caller's IP address —
`e.parameter` only contains form fields, and there are no request headers
exposed either. **Per-attacker rate limiting is not implementable at this
layer at all**, confirming the audit brief's own caution not to assume
Apps Script provides a trustworthy client IP. This is documented as an
architecture limitation in §F, not something "fixed."

**File/function.** `apps-script/Code.gs`, `doPost()`.

**Fix (scoped to what's actually possible here).** Added a coarse,
*global* throttle — `RATE_LIMIT_MAX_PER_WINDOW = 20` submissions per
`RATE_LIMIT_WINDOW_SECONDS = 60`, tracked via a `CacheService` counter keyed
by the current time bucket. Once the window's cap is hit, further requests
get a silent `{result:'ok'}` (not an error, so a scripted flood gets no
signal it's being throttled) without touching the Sheet or `MailApp`. This
protects the Sheet/inbox/quota from *total* abuse; it cannot distinguish
one attacker from many simultaneous legitimate visitors, and the counter
increment isn't atomic (`CacheService` has no atomic incr), so it's a
best-effort bound, not a precise one — both documented in code comments.

**Regression test.** `tests/code-gs.test.js`: *"a flood of unique
submissions within one window is throttled once the cap is hit"*.

---

### SEC-004 — `vertical` not validated against the known option list
**Root cause.** The client `<select>` constrains `vertical` to six known
values, but `doPost()` never re-checked this server-side. Since the `/exec`
URL is public and documented as directly POST-able (see the existing
comment on `EMAIL_RE`/`NAME_DIGIT_RE`), any string could be submitted as
`vertical` and would land in the Sheet and the notification email/subject
unchecked.

**File/function.** `apps-script/Code.gs`, `doPost()`.

**Impact.** Low on its own (no injection — formula-safety and newline-safety
already covered this value via `sheetSafe()`/`singleLine()`), but it is a
real gap between "what the UI allows" and "what the server accepts,"
which is exactly the trust boundary this form's own code comments say to
guard.

**Fix.** Added `ALLOWED_VERTICALS` (mirroring `contact.html`'s `<select>`
options exactly) and a check: a *non-empty* `vertical` that isn't in the
list is rejected with a 400-style error. An empty/omitted value is still
accepted unchanged, to avoid changing behavior for any legitimate caller
that omits the optional field.

**Regression test.** `tests/code-gs.test.js`: *"an unrecognized 'vertical'
value is rejected…"*, *"an empty 'vertical' value is still accepted…"*.

---

### SEC-005 — No server-side maximum field length
**Root cause.** Nothing capped the length of `name`, `email`, `company`,
or `message` server-side. An oversized value (well past Sheets' ~50,000
character per-cell limit) would only fail when `appendRow()` ran, deep
inside the request — after other validation had already passed — feeding
directly into SEC-001's "row already written, then it breaks" pattern and
SEC-006's information disclosure.

**File/function.** `apps-script/Code.gs`, `doPost()`; `contact.html`
(client-side `maxlength` added as defense in depth).

**Fix.** Added `MAX_NAME_LENGTH` (100), `MAX_EMAIL_LENGTH` (200),
`MAX_COMPANY_LENGTH` (200), `MAX_MESSAGE_LENGTH` (5000), checked and
rejected with a clean 400-style error before any Sheet/Cache operation.
Matching `maxlength` attributes added to the corresponding inputs in
`contact.html` for UX parity (not a security control by itself — the
server check is what matters, since this is exactly the kind of HTML
attribute a direct POST bypasses).

**Regression test.** `tests/code-gs.test.js`: *"maximum field length
boundaries: exactly at the cap is accepted, one over is rejected"*.

---

### SEC-006 — Raw exception text returned to the caller
**Root cause.** `doPost()`'s outer `catch (err)` returned
`{ result: 'error', message: String(err) }` directly in the HTTP response.
Apps Script exception messages can include sheet names, Sheets/Mail quota
detail, or other internal specifics — none of which should go to an
anonymous caller of a public endpoint.

**File/function.** `apps-script/Code.gs`, `doPost()` outer `catch`.

**Fix.** The real error is now logged server-side via `console.error(...)`
(visible to the site owner in the Apps Script execution log) and the
caller receives a fixed, generic `GENERIC_ERROR_MESSAGE` instead.

**Regression test.** `tests/code-gs.test.js`: *"server error responses
never echo raw exception detail back to the caller"* (forces an
`appendRow` throw and asserts the response does not contain the thrown
message's text).

---

### SEC-007 — Silent, unmonitored notification failures *(not fixed — documented)*
Already handled safely from a correctness standpoint (a failed send never
loses the submission or duplicates the row — verified in
`tests/code-gs.test.js`: *"an email-send failure does not fail the
submission…"*), but failures are only visible in the Apps Script execution
log. If the account's daily `MailApp` quota is ever exhausted, real
enquiries would stop generating notification emails with zero visible
symptom (the Sheet still fills normally). No code change is proposed here
because a real fix (e.g. a scheduled "heartbeat" trigger, or external
monitoring) is a new piece of infrastructure, not a safe same-shape code
edit — see §F.

### SEC-009 — Rate-limited requests return a disguised success response *(fixed, then reverted by owner decision — not a defect)*
**What was found.** The `isRateLimited(cache)` branch in `doPost()`
returns `jsonResponse({ result: 'ok' })` — a real visitor whose submission
happens to land during a throttled window is told "Thanks, a partner will
be in touch" for a message that was **never written to the Sheet or
emailed anywhere**. This is real, confirmed behavior, not a theoretical
concern.

**Why it was built this way (the owner's original intent, confirmed
correct on review).** This rate limiter has no way to distinguish a bot
from a real visitor — there's no CAPTCHA, no IP, nothing but raw volume.
Returning an honest "you're being throttled" error would let a scripted
abuser detect the defense and adapt around it (slow down, rotate
something, probe for the exact cap). Returning `'ok'` unconditionally
denies that feedback. This is the same rationale behind the honeypot's
own silent-`'ok'` response, and a reasonably common pattern in anti-abuse
systems generally.

**The trade-off, stated precisely.** Only the *response body* is at
stake — not the actual protection. `appendRow()` and `sendNotification()`
are never reached once `isRateLimited()` is true, in either version, so
the Sheet, the inbox, and the `MailApp` quota are protected identically
whether the caller is told `'ok'` or `'error'`. The only thing that
changes is whether a genuine visitor caught in the same global counter
(this layer cannot tell them apart from a bot) is told the truth.

**Resolution.** This was first changed to return an honest
`{result:'error'}`, on the reasoning that the disguise's practical benefit
is small (most spam bots don't read/adapt to responses at all) against the
real cost (a genuine lead silently lost with a false confirmation and zero
trace to investigate later). On review, the site owner weighed the same
trade-off and chose to keep the original disguised-`'ok'` behavior —
denying a scripted abuser any signal is worth more to them than the
occasional false-positive against a real visitor during a throttled
window. **Reverted to the original behavior at the owner's explicit
request.** Revisit if real visitors ever report sending a message that
never arrived.

**File/function.** `apps-script/Code.gs`, `doPost()`, line 146.

**Regression test.** `tests/code-gs.test.js`: *"a flood of unique
submissions within one window is throttled silently - disguised as 'ok',
by design"* — asserts the disguise (not an honest error) and separately
asserts the Sheet still only receives `RATE_LIMIT_MAX_PER_WINDOW` rows, so
both halves of the trade-off are pinned down by a test rather than one
being assumed.

---

### SEC-010 — Cache failure after a successful row write could cause a duplicate on retry
**Root cause.** `cache.put('sub_' + submissionId, ...)` and
`recordRateLimitHit(cache)` ran with no try/catch of their own, directly
after `sheet.appendRow(...)` succeeded. SEC-001's fix (bounding
`submission_id` to a safe length/format) only prevents *that one specific*
cause of `cache.put()` throwing. Any **other** `CacheService` failure —
Google-side quota exhaustion, a transient infrastructure error, anything
unrelated to key length — occurring at this point would still propagate up
through the `finally` (which correctly released the lock) to the outer
`catch`, which would then report `{result:'error'}` to a caller whose row
had, in fact, already been safely written. Because `js/main.js` reuses the
same `submission_id` across retries, the client would retry this
"failure," re-run the whole request, and append a **second** row for a
submission that had already succeeded on the first attempt — the exact
failure mode the dedup mechanism exists to prevent, triggered from a
different angle than SEC-001.

**File/function.** `apps-script/Code.gs`, `doPost()`, lines 186–193.

**Impact.** Integrity — a transient, unrelated cache error after a
successful write could still produce a duplicate Sheet row (and a second
notification email) on the client's automatic retry.

**Fix.** Wrapped `cache.put(...)` and `recordRateLimitHit(cache)` in their
own try/catch, mirroring the existing pattern already used for
`sendNotification()` just below it: the Sheet row is the source of truth
and is already durably written by this point, so a failure in this
best-effort bookkeeping is logged (`console.error('Post-write cache
bookkeeping failed: ' + cacheErr)`) and swallowed, never allowed to turn an
already-successful write into a reported failure.

**Regression test.** `tests/code-gs.test.js`: *"a cache failure AFTER a
successful appendRow must not be reported as a request failure…"* (forces
`cache.put()` to throw unconditionally — not via an oversized key — and
confirms the response is still `{result:'ok'}`, exactly one row exists,
and the failure is logged).

---

### SEC-008 — Honeypot is bypassable by design *(not fixed — documented limitation)*
The honeypot (`website` field) is checked server-side correctly (confirmed:
`tests/code-gs.test.js` → *"honeypot field being filled silently drops the
submission server-side"*), but any bot that POSTs directly to the `/exec`
URL without that field present bypasses it trivially — this is inherent to
the honeypot technique, not something more validation logic can close. The
new rate limit (SEC-003) bounds the worst case; a CAPTCHA/challenge service
would close it further but is a new third-party dependency with its own
trade-offs (cost, UX friction, another external script) — flagged as a
recommendation only, not implemented.

## D. Validation Matrix

Legend: **PASS** verified by test and/or code inspection · **FAIL**
confirmed defect (now fixed, see SEC-ID) · **N/V** not verifiable from code
alone (manual/account-level check needed) · **N/A** not applicable to this
implementation.

### Phase 1 — Discovery
All items **PASS** (completed): form in `contact.html`, logic in
`js/main.js`, backend in `apps-script/Code.gs`; single HTTP call
(`fetch(APPS_SCRIPT_URL, {method:'POST', body: FormData})`, with 2 retries);
deployment config documented in `apps-script/README.md` (**N/V** that the
*live* deployment matches the doc — can't query a live Apps Script project
from this environment); no API keys/credentials in the frontend (the
`/exec` URL is intentionally public, not a secret); data flow traced
start-to-finish in §C above; third-party deps: none (Google Fonts CSS only,
no JS libraries).

### Phase 2 — Input validation
| Item | Result |
|---|---|
| Required fields cannot be omitted | PASS |
| Empty/whitespace-only rejected | PASS |
| Max field lengths enforced server-side | **was FAIL → fixed (SEC-005)** |
| Email validated | PASS |
| Unsupported field values rejected | **was FAIL → fixed (SEC-004)** |
| Unexpected extra parameters handled safely | PASS (incl. `__proto__`-keyed input — no prototype pollution, extra keys ignored) |
| Unicode/special characters handled consistently | PASS (`NAME_DIGIT_RE`/`MESSAGE_ALLOWED_RE` apply consistently; ASCII-only message charset is a UX constraint, not a security gap) |
| Oversized submissions rejected | **was FAIL → fixed (SEC-005)** |
| Client-side validation not relied upon | PASS (every check mirrored server-side) |
| Error handling doesn't expose sensitive info | **was FAIL → fixed (SEC-006)** |

### Phase 3 — Injection
| Item | Result |
|---|---|
| Spreadsheet formula injection tested on every field | PASS (`sheetSafe()`, all 4 trigger chars + tab verified) |
| Stored as text, not executable formula | PASS |
| HTML injection into emails | N/A — plain-text email only, no `htmlBody` path exists |
| Output escaped before HTML templates | N/A (no HTML templating server-side) |
| Unsafe use in subject/reply-to | PASS (`singleLine()` on subject fields; `replyTo` constrained by `EMAIL_RE`) |
| Unsafe URL construction/redirects | N/A — no redirect logic anywhere in the app |
| Unsafe DOM manipulation (`innerHTML` etc.) | PASS — none found (`grep` across all JS/HTML) |
| Reflected/stored XSS | PASS for current implementation — submitted data is never rendered on any page; flagged as a *future* risk if a dashboard is ever added (see `todo.md`) |
| Server-side output encoding | N/A (no HTML output generated server-side) |

### Phase 4 — Endpoint security
| Item | Result |
|---|---|
| Anonymous submissions allowed | PASS (intentional) |
| Public accessibility intentional | PASS (documented in `apps-script/README.md`) |
| Unauthorized read of spreadsheet | PASS — no `doGet` exists at all |
| Modify/delete existing records | PASS — only `appendRow` is used, never update/delete |
| Unnecessary functionality exposed | PASS — `testNotification()` exists but isn't reachable over HTTP (Web Apps only dispatch `doGet`/`doPost`) |
| OAuth scopes reviewed | N/V — no `appsscript.json` manifest in this repo to inspect |
| Deploys executing as owner | PASS (by design, per `apps-script/README.md` — the only way a public form can write to a private Sheet) |
| Sensitive config returned to callers | **was FAIL → fixed (SEC-006)** |
| Risk from direct requests bypassing frontend | PASS post-fix — every client-side check now has a server-side twin |
| Publicly exposed implementation details | PASS as a conscious trade-off — `Code.gs` is open in this repo; security relies on server-side enforcement, not secrecy of the algorithm |

### Phase 5 — Bot protection & rate limiting
| Item | Result |
|---|---|
| Honeypot checked server-side | PASS |
| Bots can bypass the honeypot | Confirmed possible — inherent limitation (SEC-008), not a code defect |
| Rate limiting/quota controls | **was FAIL → fixed, best-effort (SEC-003)** |
| Repeated submissions from one source | N/A at this layer — no caller IP available to Apps Script at all |
| Rapid requests with changing IDs | Mitigated by SEC-003's global throttle; cannot be distinguished per-source (architecture limit) |
| Notification-email flooding | **was FAIL → mitigated (SEC-003)** |
| Execution/email quota exhaustion | Mitigated by SEC-003; residual risk documented (SEC-007) |
| CAPTCHA/intermediary service | Not implemented — recommendation only (new third-party dependency, see §F) |
| Apps Script metadata limitations | Confirmed and documented — no IP, no headers in `doPost(e)` |

### Phase 6 — Duplicate submission & replay
| Item | Result |
|---|---|
| `submission_id` generation | PASS — `crypto.randomUUID()` preferred, weaker fallback for old browsers (availability nit only, not a security boundary) |
| ID validated server-side | **was FAIL → fixed (SEC-001)** |
| Repeated IDs can't create duplicates | PASS (post-fix, under non-concurrent conditions) |
| Retries don't generate new IDs unnecessarily | PASS — `js/main.js` generates one id per submit action, reused across all retries |
| Concurrency/race risk | **was FAIL → fixed (SEC-002)** |
| `LockService` usage | **was absent → added (SEC-002)** |
| Sheet success + email failure handling | PASS — row is committed before the email is attempted; verified by test |
| Duplicate prevention under concurrency | **was FAIL → fixed (SEC-002)** |
| Consistent responses to duplicates | PASS — both "fresh success" and "already processed" return the same `{result:'ok'}` |

### Phase 7 — Sheets data security
| Item | Result |
|---|---|
| Correct spreadsheet/sheet targeted | PASS — always `getActiveSpreadsheet()`, never request-derived |
| No arbitrary spreadsheet ID/range selection | PASS |
| Spreadsheet sharing/permissions | N/V — lives in the Google account, not in this repo |
| Cannot overwrite existing records | PASS — `appendRow` only |
| Formula injection protections | PASS |
| Correct columns | PASS — `HEADERS` order matches the `appendRow` array exactly |
| Unnecessary PII collection | PASS — minimal fields, honeypot value itself is never stored |
| Logging/retention of contact details | PASS for code (no PII in any `console.error` call); retention policy itself is a Google-account setting, N/V |
| Spreadsheet errors handled safely | **was FAIL → fixed (SEC-006)** |
| No credentials/tokens in logs | PASS |

### Phase 8 — Email notification security
| Item | Result |
|---|---|
| Recipients configured server-side only | PASS — fixed `NOTIFY_TO` constant |
| Callers cannot choose recipients | PASS |
| Cannot modify email headers | PASS — `replyTo` regex-constrained, subject/body newline-stripped |
| Subject handling | PASS — truncated and newline-stripped |
| Escape untrusted content in HTML emails | N/A — plain text only |
| Reply-to validated | PASS |
| Email failure → duplicate Sheet entries | PASS — confirmed safe ordering (dedup written before email attempted) |
| Outgoing email quotas considered | Partially — SEC-003 reduces pressure; SEC-007 documents residual risk |
| Sensitive internal details in email content | PASS — the Sheet URL appears only in the email to the site owner, never reflected to the submitter |

### Phase 9 — Frontend security
| Item | Result |
|---|---|
| Honeypot operates correctly | PASS client-side; real enforcement is server-side (SEC-008 notwithstanding) |
| DOM-based XSS | PASS — none found |
| Third-party JS dependencies | PASS — none (Google Fonts is CSS only) |
| CSP compatibility | N/V / recommendation only — no CSP currently set; GitHub Pages can't set response headers, a `<meta>` CSP is possible and already tracked in `todo.md` |
| Security headers via hosting | N/A — GitHub Pages limitation, tracked in `todo.md` |
| No credentials in client code | PASS — only the intentionally-public `/exec` URL |
| Form submits only intended fields | PASS — plain `new FormData(form)` |
| Loading/success/timeout/error states | PASS |
| Submit button disabled during pending request | PASS |
| Retries causing duplicate processing | PASS post-fix (SEC-001/SEC-002) |
| Misleading success messages | PASS — success is only shown after a real `{result:'ok'}` |

### Phase 10 — Testing
30/30 automated tests pass locally (`npm test`, Node's built-in
`node:test`, zero new dependencies). Covers: valid submission, each
required-field omission, invalid email, length boundaries, formula
injection (all 4 reachable trigger characters + a direct `sheetSafe()`
unit test for the trim-shadowed tab case), HTML-injection-is-N/A
confirmation, CRLF/header-injection resistance, duplicate `submission_id`,
oversized/malformed `submission_id`, lock contention, Sheets write
failure, email-send failure, honeypot, rate-limit flood, prototype
pollution via `__proto__` key, row-column ordering, `doGet` absence.
**Not run:** anything against the live `/exec` URL — explicitly excluded
per this audit's own constraints.

## E. Files Changed

- **`apps-script/Code.gs`** — added `sanitizeSubmissionId()` +
  `SUBMISSION_ID_RE` (SEC-001); added `LockService` critical section
  (SEC-002); added global rate limiter (SEC-003); added `ALLOWED_VERTICALS`
  check (SEC-004); added `MAX_*_LENGTH` checks (SEC-005); replaced raw
  `String(err)` responses with a generic message + server-side logging
  (SEC-006). Follow-up review additions: `cache.put()`/
  `recordRateLimitHit()` are now wrapped in their own try/catch so a cache
  failure after a successful row write can't be reported as a request
  failure (SEC-010); corrected a stale code comment that claimed the
  rate-limit counter could under-count under concurrency (it can't — it's
  inside the same lock). SEC-009 (rate-limit branch) was briefly changed to
  return an honest error, then **reverted** at the site owner's request
  back to its original disguised-`'ok'` behavior, with an expanded comment
  explaining the trade-off in place (see §C for the full discussion).
  `sheetSafe()`, `singleLine()`,
  `sendNotification()`, `getOrCreateSheet()`, `jsonResponse()`,
  `testNotification()` are unchanged (reviewed and confirmed already
  secure, in both passes).
- **`contact.html`** — added `maxlength` attributes to `name`, `email`,
  `company`, `message` matching the new server-side caps (defense in
  depth; also the already-committed LinkedIn URL fix from the prior
  session, unrelated to this audit).
- **`package.json`** *(new)* — no runtime dependencies; a `test` script
  running Node's built-in test runner.
- **`tests/gas-harness.js`** *(new, extended in follow-up)* — mocks the
  Apps Script runtime (`SpreadsheetApp`, `MailApp`, `CacheService`,
  `LockService`, `ContentService`) so `Code.gs` can be loaded and exercised
  under plain Node via `vm.runInContext()`. Follow-up review added real
  TTL-based expiry to the cache mock (keyed off the same controllable
  `Date.now()` the sandbox shares with the test file), needed to actually
  test SEC-010/§G item 3 rather than just assert it.
- **`tests/code-gs.test.js`** *(new, extended in follow-up)* — 34
  regression tests (30 from the first pass + 4 added by the follow-up
  review for SEC-009, SEC-010, and the two confirmed-accepted-risk
  behaviors in §G items 2–3).

## F. Remaining Risks

1. **Fixes are not yet live.** Everything above is a change to this
   repository. The Apps Script Web App is a separate, manually-deployed
   artifact — redeploy via **Deploy → Manage deployments → Edit → New
   version → Deploy** in the Apps Script editor before any of these fixes
   take effect for real traffic.
2. **No per-attacker rate limiting is possible at this layer, and the
   window is a fixed window, not a sliding one.** Apps Script's `doPost(e)`
   never exposes a caller IP or any other stable per-caller identifier. The
   throttle (SEC-003) is global; a determined, moderate-volume attacker can
   still consume an entire window's budget and lock out legitimate
   submissions for that minute. On top of that, because the window is a
   fixed 60s bucket keyed by wall-clock time (not a rolling window), a
   burst split across a window boundary can momentarily admit up to ~2x
   `RATE_LIMIT_MAX_PER_WINDOW` — confirmed and bounded by a test (§G,
   item 5), not fixed, since a true sliding window needs a data structure
   `CacheService` doesn't cleanly provide. *(Corrected from the first pass
   of this audit: the counter increment itself is not actually racy under
   concurrency — it runs inside the same `LockService` lock as the
   append/dedup-write sequence, so concurrent executions can't race on it.
   The only real imprecision is this window-boundary effect.)* Closing the
   per-attacker gap further would require a layer in front of Apps Script
   (e.g. Cloudflare, a Workers-based proxy) — a real architecture change,
   not something fixable inside `Code.gs`.
3. **Honeypot bypass (SEC-008)** remains possible for any bot that reads
   the form's HTML and simply omits the hidden field. A CAPTCHA/challenge
   service would close this at the cost of a new third-party dependency,
   added latency, and UX friction — a trade-off worth a separate decision,
   not implemented here.
4. **Silent notification failures (SEC-007)** have no monitoring. If
   `MailApp`'s daily quota is ever exhausted, the business stops getting
   enquiry emails with no alert — only an entry in the Apps Script
   execution log that nobody is watching.
5. **Not verifiable from this repository:** the live deployment's actual
   "Execute as / Who has access" settings, the Google Sheet's sharing
   configuration, the Apps Script OAuth scope grant, and log retention —
   all live in the Google account, not in version control. Worth a manual
   spot-check against `apps-script/README.md`'s documented settings.
6. **Not a vulnerability today, but a latent one:** submitted `company`/
   `vertical`/`message` data is never rendered back on any page right now.
   If a future admin dashboard or export ever displays Sheet data as HTML,
   it must HTML-escape it at that point — this audit did not need to add
   that escaping because no such renderer exists yet, but it would be a
   genuine stored-XSS vector the moment one is built.
7. **Idempotency only applies when a valid `submission_id` is present**
   (confirmed by test in §G, item 2). A direct POST that omits the id
   entirely gets no dedup guarantee at all — this is intentional (there's
   nothing safe to key dedup on without an id) and its practical impact is
   already bounded by the SEC-003 rate limiter, not a separate gap to
   close.
8. **The dedup cache expires after `DEDUP_TTL_SECONDS` (21,600s / 6
   hours)** — the maximum TTL `CacheService` allows, confirmed by test
   (§G, item 3). A retry of the exact same `submission_id` more than 6
   hours later is treated as a new submission. This is a platform ceiling,
   not a value this code could safely raise further.
9. **Frontend/backend HTTP compatibility (§G, item 6) could not be
   verified end-to-end.** The mocked test suite verifies `Code.gs`'s own
   contract precisely, but cannot verify the actual browser ↔ Google
   network behavior (redirects, CORS headers on the live response) —
   verifying that requires a real request to the live `/exec` URL, which
   is explicitly out of scope for this audit. Recommend one ordinary,
   non-adversarial manual test of the live deployed form after the next
   redeploy (not a security test — just confirming the page works).

## G. Independent Follow-Up Review — 8-Point Verification

This section is a second, independent pass requested specifically to
re-verify the first pass rather than trust its conclusions. Every item
below was re-checked directly against the current source — not against
what the first pass claimed — and two real defects (SEC-009, SEC-010,
detailed in §C) were found this way. Verdicts use: **CONFIRMED** (a real
defect, now fixed), **MITIGATED** (a real risk, bounded by an existing
control, not fully eliminable here), **ACCEPTED RISK** (a real, confirmed
behavior that is an intentional/inherent trade-off, not a defect), **NOT
VERIFIED** (cannot be checked from source alone).

### 1. Do rate-limited submissions return misleading success responses?
**CONFIRMED, then ACCEPTED RISK by explicit owner decision (SEC-009).**
`doPost()`'s `isRateLimited(cache)` branch returns `{result:'ok'}` with no
row written and no email sent — indistinguishable, from the client's
perspective, from a genuine success. This was first changed to an honest
error, then reverted after discussing the trade-off with the site owner:
the disguise exists specifically to deny a scripted abuser any signal
it's being throttled, and the owner judged that worth more than the
occasional real visitor seeing a false "received" during a throttled
burst. The underlying protection is unaffected either way — `appendRow()`/
`sendNotification()` are never reached on this path regardless of what's
returned. Full discussion in §C's SEC-009 write-up. Test: *"a flood of
unique submissions within one window is throttled silently - disguised as
'ok', by design."*

### 2. Do missing or malformed submission IDs bypass idempotency?
**ACCEPTED RISK — confirmed, not a defect.** `sanitizeSubmissionId()`
(`Code.gs` lines 220–223) maps a missing/malformed id to `''`, and the
dedup check at line 165 is `if (submissionId && cache.get(...))` — so a
falsy id skips dedup entirely. Two requests with no id produce two rows;
this is the correct, intended behavior (there is no safe value to key
dedup on without an id), not a regression of a guarantee that was ever
made for idless requests. The real client (`js/main.js`) always supplies
a `crypto.randomUUID()` id, so this only affects a direct, deliberately
id-less POST — whose worst case is already bounded by the SEC-003 rate
limiter. Test: *"a missing submission_id has no idempotency guarantee at
all — repeats create separate rows."*

### 3. Does CacheService expiry/eviction allow duplicate submissions?
**ACCEPTED RISK — confirmed, platform ceiling, not a defect.**
`DEDUP_TTL_SECONDS = 21600` (`Code.gs` line 67) is exactly `CacheService`'s
documented maximum TTL (6 hours) — this code cannot raise it further. A
retry of the same `submission_id` more than 6 hours after the original is,
correctly, treated as new. Verified directly (not just asserted) by
fast-forwarding a controllable `Date.now()` past the TTL in the mock cache
and confirming a second row is written. Test: *"dedup cache entries expire
after DEDUP_TTL_SECONDS, allowing a duplicate on a very late retry."*
*(Google's `CacheService` is also documented as best-effort, not a
durable store, meaning entries could in principle be evicted earlier than
their TTL under platform-side memory pressure — this specific sub-case is
**NOT VERIFIED**, since it depends on Google-side behavior with no
documented SLA and can't be reproduced in a mock.)*

### 4. Does appendRow success followed by cache failure cause duplicates?
**CONFIRMED → fixed (SEC-010).** Distinct from SEC-001 (which only guards
against the key-*length*-triggered throw): any **other** cache failure —
unrelated to key length — occurring after a successful `appendRow()` used
to propagate uncaught to the outer `catch`, reporting `{result:'error'}`
for a submission whose row was already durably written, inviting a
client retry that would append a second row. Now wrapped in its own
try/catch (`Code.gs` lines 186–193). Test: *"a cache failure AFTER a
successful appendRow must not be reported as a request failure…"*

### 5. Do concurrent requests or rate-limit window boundaries bypass throttling?
**Two sub-questions, different answers:**
- **Concurrent requests racing the counter: MITIGATED, not bypassable.**
  `recordRateLimitHit()`'s read-then-write is not atomic in isolation, but
  it executes inside the same `LockService.tryLock()` critical section
  (`Code.gs` lines 145–196) as the dedup check and the append — so no two
  concurrent executions of this script can run it simultaneously. *(This
  corrects an inaccurate code comment from the first pass, which claimed
  concurrent requests could under-count the limiter; fixed in the same
  follow-up — see §F, item 2.)*
- **Fixed-window boundary: ACCEPTED RISK, confirmed and bounded.**
  `rateLimitKey()` (`Code.gs` lines 225–227) buckets by wall-clock minute,
  a classic fixed-window counter — a burst split across a window edge can
  momentarily admit up to ~2x `RATE_LIMIT_MAX_PER_WINDOW` (e.g. 20 at
  `:59.9`, another 20 at `:00.1`). Verified directly with a
  clock-controlled test that fills window N to its cap, advances the mock
  clock by exactly one window, and confirms the cap resets. Test:
  *"rate-limit window boundary: the cap resets in the next window…"*. A
  true sliding window would close this, at the cost of a data structure
  `CacheService` doesn't support cleanly — not implemented, since the
  current exposure (~40 submissions in under a second, worst case, to a
  low-traffic B2B contact form) doesn't justify that complexity.

### 6. Is frontend response handling compatible with real GAS behavior (HTTP errors, CORS)?
**NOT VERIFIED — cannot be confirmed without a live request, which is out
of scope for this audit.** What source inspection *does* confirm:
- `js/main.js`'s claim that "Apps Script Web Apps always respond 200,
  even on a logical failure" (line 87) matches Apps Script's documented
  behavior — `ContentService` Web App responses cannot carry a custom HTTP
  status, exactly as `Code.gs`'s own `jsonResponse()` comment (line
  317–318) already states. The `res.ok` check at `js/main.js` line 83 is
  therefore correctly scoped to catching true transport/infrastructure
  failures (a deleted/misconfigured deployment, a Google-side 5xx) — not
  dead code, just not what catches application-level validation errors
  (those are caught by the subsequent `data.result !== 'ok'` check at line
  89, which is correct).
- The form submits via `new FormData(form)` (`js/main.js` line 140), which
  the Fetch spec treats as a CORS "simple" content type
  (`multipart/form-data`) — this avoids triggering a CORS preflight
  (`OPTIONS`) request, which matters because Apps Script Web Apps have no
  `doOptions()` defined anywhere in `Code.gs` and would likely fail a
  preflight if one were ever triggered (e.g. by switching to a JSON body
  with `Content-Type: application/json`). This is confirmed as correct by
  inspection, not assumed.
- What inspection **cannot** confirm: whether the live `/exec` endpoint's
  actual response to a cross-origin `fetch()` POST carries the right
  `Access-Control-Allow-Origin` behavior, and whether any redirect occurs
  for POST the way it's documented to for some `doGet` scenarios. This is
  the single item in this entire audit that fundamentally requires a real
  network request to verify, and the audit's own constraints prohibit
  that. **Recommendation:** after the next redeploy, submit the live form
  once as ordinary dogfooding (not a security test) to close this out.

### 7. Do production deployment permissions, OAuth scopes, and Sheet sharing still require verification?
**NOT VERIFIED — unchanged from the first pass, re-confirmed.** No
`appsscript.json` manifest exists anywhere in this repository (checked
directly: `find . -iname "*appsscript*"` returns nothing beyond
`Code.gs`), so OAuth scopes cannot be inspected from source. Deployment
"Execute as / Who has access" settings and the Sheet's sharing
configuration are Google-account state, not version-controlled files —
unverifiable from this environment regardless of how thoroughly `Code.gs`
is reviewed. Manual spot-check against `apps-script/README.md`'s
documented settings remains the only way to close this out.

### 8. Are notification delivery failures detectable?
**ACCEPTED RISK — unchanged from the first pass (SEC-007), re-confirmed.**
`doPost()`'s `catch (mailErr) { console.error(...) }` (`Code.gs` lines
205–206) still only writes to the Apps Script execution log — nothing
actively surfaces a failure to the site owner. No code change was made
here in either pass: a real fix (a scheduled heartbeat trigger, or
external uptime/log monitoring) is new infrastructure, not a same-shape
code edit, and is better left as a deliberate decision than bundled into
a "minimal fix."

## H. Production Readiness Decision

# **READY FOR PRODUCTION**

**Update (2026-10-10): the site owner has redeployed `apps-script/Code.gs`
to the live Apps Script project** (Deploy → Manage deployments → New
version → Deploy). This is recorded as self-reported — nothing in this
repository or this audit's tooling can independently query a live Apps
Script deployment to confirm it, the same way the rest of §G/§F's
Google-account items can't be.

**This verdict covers the *code in this repository*, verified by 34
passing local tests against a faithful mock of the Apps Script runtime.
It does not cover the two remaining items below that are Google-account
configuration, not code, and cannot be verified from here (§G items 6 and
7; §F item 5) — those remain the user's responsibility to spot-check.**

**Why "ready," not "perfectly secure":** every CONFIRMED defect found
across both passes (SEC-001 through SEC-006, plus SEC-010 from this
follow-up) has a minimal, tested fix in `apps-script/Code.gs`. SEC-009 was
also fixed, then deliberately reverted at the owner's request after
reviewing the trade-off — that's a judgment call, not an unresolved
defect, and the underlying protection (the Sheet/inbox/quota) is identical
either way. The items left open (SEC-007, SEC-008, and the four ACCEPTED
RISK items in §G, including SEC-009) are architecture limitations of a
free, serverless, anonymous-access Apps Script backend, not overlooked
bugs — each is explained, bounded, and
documented rather than silently accepted.

**Remaining items (not code defects — deployment/account steps, both outside what this repo or this audit's tooling can verify):**
1. ~~`Code.gs` must be redeployed~~ — **done**, per the owner (2026-10-10).
2. **One manual, non-adversarial check of the redeployed live form**
   (§G item 6) — submit it once for real, to confirm the browser ↔ Google
   network path behaves as the source code assumes. Still recommended;
   not something this audit's tooling can do from this environment.
3. **One manual spot-check of Google-account settings** (§G item 7; §F
   item 5) — deployment "Execute as / Who has access," the Sheet's sharing
   settings, and the OAuth scope grant — against what
   `apps-script/README.md` documents. These live outside version control
   entirely.

**What "tested" means here, precisely:** 34/34 tests pass against a mock
that implements `SpreadsheetApp`, `MailApp`, `CacheService` (with real
TTL-based expiry), `LockService`, and `ContentService` to the same
contract `Code.gs` actually calls — including a controllable clock for the
two time-dependent behaviors (§G items 3 and 5). That is strong evidence
`Code.gs`'s own logic is correct. It is not, and cannot be, evidence about
the live Google Cloud project's configuration, which is explicitly flagged
as unverified above rather than assumed.
