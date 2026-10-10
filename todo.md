# Security hardening TODO

Findings from a review of `contact.html`, `js/main.js`, `apps-script/Code.gs`,
and the rest of the static site (2026-09-28). Grouped by area, roughly in
priority order within each group.

## Contact form backend (`apps-script/Code.gs`)

Full audit (findings, fixes, and a 34-test regression suite) is in
[`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) — 2026-10-10, including an
independent follow-up pass (§G) that found two more real issues (below)
and ends with an explicit **READY FOR PRODUCTION** call, contingent on
redeploying `Code.gs` (it doesn't auto-deploy from git) and two manual
checks outside version control (§H).

- [x] Validate `vertical` server-side against the fixed option list —
      **fixed** (SEC-004 in the audit): added `ALLOWED_VERTICALS`, rejects
      any non-empty unrecognized value.
- [x] Add a length cap to `name`/`email`/`company`/`message` — **fixed**
      (SEC-005): `MAX_*_LENGTH` constants, rejected with a 400-style error.
- [x] Add basic rate limiting — **fixed, best-effort** (SEC-003): a global
      (not per-IP — Apps Script never exposes a caller IP to `doPost`, see
      the audit's §F) throttle via `CacheService`, 20 submissions/minute
      across all callers.
- [x] Fixed two issues found during the audit that weren't on this list
      yet: an unvalidated `submission_id` used as an unbounded cache key
      (SEC-001 — could crash *and* defeat its own dedup purpose), and a
      missing `LockService` lock around the dedup-check/append/dedup-write
      sequence (SEC-002 — a race could duplicate rows). Also: raw exception
      text was being returned to callers on error (SEC-006) — now a generic
      message, with the real error logged server-side instead.
- [x] Found and fixed in an independent follow-up review: a `CacheService`
      failure occurring right after a successful row write could cause the
      client to retry and duplicate the row (SEC-010 — same failure class
      as SEC-001, different trigger).
- [ ] **SEC-009, discussed and decided — not a bug, left as-is on purpose.**
      A rate-limited request returns a disguised `{result:'ok'}` (no row
      written, no email sent, caller told success anyway). This was briefly
      changed to an honest error, then **reverted back to the original
      behavior at the owner's request**: the disguise exists specifically
      so a scripted abuser gets no signal it's being throttled, and that's
      judged worth more than an occasional real visitor seeing a false
      "received" during a throttled burst. The actual protection (Sheet/
      inbox/quota) is unaffected either way. Revisit only if real visitors
      start reporting messages that never arrived. Full discussion in
      `SECURITY_AUDIT.md` §C.
- [x] Also confirmed (as accepted, intentional behavior, not
      bugs): dedup doesn't apply without a valid `submission_id`, the dedup
      cache expires after 6h (the `CacheService` maximum), and the rate
      limiter's fixed-window design allows a bounded ~2x burst at a window
      boundary.
- [ ] Consider adding a lightweight CAPTCHA/challenge (e.g. Cloudflare
      Turnstile or hCaptcha) if spam gets past the honeypot in practice —
      honeypots stop simple bots but not targeted abuse of a known public
      endpoint. (SEC-008 in the audit — documented as a limitation, not
      fixed; it's a new third-party dependency, a separate decision.)
- [ ] Re-confirm `sheetSafe()` and `singleLine()` stay applied to *any* new
      field added later — both are field-by-field opt-in, not automatic, so
      a future field is unsafe by default until someone remembers to wire it
      in.
- [x] **Redeployed (2026-10-10, per owner)** — `Code.gs` with the fixes
      above has been pasted into the Apps Script editor and redeployed via
      **Deploy → Manage deployments → Edit → New version → Deploy**.
- [x] **Deployment settings + Sheet sharing checked, confirmed accurate
      (2026-10-10, per owner)** — "Execute as: Me" / "Who has access:
      Anyone" and the Sheet's sharing permissions match what
      `apps-script/README.md` documents. Both of these items (like the
      redeploy above) are self-reported — not independently verifiable
      from this repo, since nothing here can query a live Apps Script
      deployment or a Google account's sharing settings.
- [ ] Still open: one ordinary (non-adversarial) live submission of the
      real form, to confirm the browser ↔ Google network path behaves as
      the code assumes (§G item 6 in `SECURITY_AUDIT.md` — the one check
      in the whole audit that genuinely needs a real network request,
      which this audit's tooling is deliberately prohibited from making).
- [ ] No monitoring on notification-email failures (SEC-007 in the audit) —
      if the account's daily `MailApp` quota is ever exhausted, enquiry
      emails silently stop with nothing visible except an Apps Script
      execution-log entry nobody is watching.

## Contact form frontend (`contact.html`, `js/main.js`)

- [x] Add a `maxlength` attribute to `company`, `name`, `email`, and
      `message` inputs matching the new server-side caps — **done**
      (2026-10-10, alongside the audit above).
- [ ] Confirm the deployed Apps Script is still set to **Execute as: Me** /
      **Who has access: Anyone**, and periodically re-check this hasn't
      drifted — this is the entire trust boundary for the endpoint.

## Anti-abuse / operational

- [ ] Set a calendar reminder to periodically review the `Submissions`
      Sheet and `braintrustllp@gmail.com` inbox for spam volume — decide on
      CAPTCHA/rate-limiting only once there's real data on whether abuse is
      happening.
- [ ] Consider rotating the Apps Script deployment (new `/exec` URL) if the
      current one is ever found to be actively abused — it's not a secret
      (it must be public for the form to work) but a new deployment ID
      resets any scraped/targeted abuse.

## Repo & secrets hygiene

- [ ] `apps-script/README-dontEdit.md` (contains the live `/exec` URL,
      deployment ID, and library link) is correctly excluded via
      `.gitignore` — keep this excluded, don't accidentally `git add -f` it.
- [ ] The `/exec` URL is also hardcoded in `js/main.js`, which **is**
      committed and public on GitHub Pages by design (the browser has to
      reach it). This is expected, not a leak — but it means the endpoint's
      own defenses (validation, honeypot, rate limiting above) are the real
      security boundary, not obscurity.
- [ ] `git_access_pat.md` in the parent folder (`/home/sm/Documents/
      Brain-trust-LLP/`, outside this repo) looks like a plaintext GitHub
      PAT. Move it out of a plain file — use a credential manager / Git
      credential helper instead — and rotate the token if it's ever been
      copied, committed, or shared anywhere.
- [ ] Before making the GitHub repo public (or if it already is), scan
      history with `git log -p` / a secrets scanner (e.g. `gitleaks`) to
      confirm no `/exec` URL, API key, or PAT was ever committed and later
      removed — deleted-but-in-history secrets still leak.

## Hosting / transport

- [x] **Add a real `Content-Security-Policy` as an HTTP header** — done
      (2026-10-10) via `_headers` at the repo root, plus
      `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and a
      restrictive `Permissions-Policy`. This only takes effect on
      **Cloudflare Pages** — GitHub Pages can't set custom response
      headers at all, which is exactly why the site is moving there for
      the real custom domain (see `README.md`'s "Deploy to Cloudflare
      Pages" section). Scoped to the site's actual resources: `'self'`,
      `fonts.googleapis.com`/`fonts.gstatic.com`, and `script.google.com`
      (the Apps Script origin, for the contact form's `fetch()`).
- [ ] Confirm **Always Use HTTPS** is turned on in Cloudflare's SSL/TLS
      settings once `braintrustcollectivesllp.com` is attached (step 7 of
      the Cloudflare Pages deploy in `README.md`).
- [ ] If GitHub Pages is kept running as a fallback alongside Cloudflare
      Pages: confirm **Enforce HTTPS** is checked there too (Settings →
      Pages) — GitHub Pages defaults to allowing HTTP until that's
      explicitly turned on for a custom domain.
- [ ] Add `rel="noopener noreferrer"` to any future `target="_blank"` links
      (the current LinkedIn link already has `rel="noopener"` — keep this
      pattern for new external links).

## Placeholders with security relevance

- [ ] Replace the placeholder `NOTIFY_TO` / sheet owner assumptions in
      `Code.gs` and `apps-script/README.md` once real operational email
      addresses are finalized — confirm no stale/test addresses keep
      receiving enquiry data after launch.
- [x] Replace the placeholder LinkedIn URL in `contact.html` — updated to
      `https://www.linkedin.com/company/braintrust-collectives-llp/`
      (2026-10-03).

## Out of scope but worth tracking separately

- [ ] `gh-mcp.tar.gz` and other non-site files sit in the parent
      `Brain-trust-LLP/` folder outside this repo — worth a quick check
      that nothing sensitive is bundled in there before it's ever shared or
      uploaded anywhere.
