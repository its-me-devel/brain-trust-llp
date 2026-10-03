# Security hardening TODO

Findings from a review of `contact.html`, `js/main.js`, `apps-script/Code.gs`,
and the rest of the static site (2026-09-28). Grouped by area, roughly in
priority order within each group.

## Contact form backend (`apps-script/Code.gs`)

- [ ] Validate `vertical` server-side against the fixed option list from
      `contact.html` (`General enquiry`, `Industrial Project Management`,
      `Legal Services`, `Core HR / HR Facilitation`, `Counselling & Coaching`,
      `IT Services`). Currently only constrained client-side by the
      `<select>` — the `/exec` URL is public and can be POSTed to directly,
      bypassing the dropdown entirely.
- [ ] Add a length cap to `company` (and `message`) — nothing currently stops
      a POST with a multi-MB field value.
- [ ] Add basic rate limiting per IP/time-window (e.g. `CacheService` counter
      keyed by a coarse identifier, or Apps Script quota-aware throttling) —
      right now there's no limit on submission volume beyond the honeypot,
      so the endpoint can be spammed to flood the Sheet and the notification
      inbox.
- [ ] Consider adding a lightweight CAPTCHA/challenge (e.g. Cloudflare
      Turnstile or hCaptcha) if spam gets past the honeypot in practice —
      honeypots stop simple bots but not targeted abuse of a known public
      endpoint.
- [ ] Re-confirm `sheetSafe()` and `singleLine()` stay applied to *any* new
      field added later — both are field-by-field opt-in, not automatic, so
      a future field is unsafe by default until someone remembers to wire it
      in.

## Contact form frontend (`contact.html`, `js/main.js`)

- [ ] Add a `maxlength` attribute to `company`, `name`, `email`, and
      `message` inputs to match whatever cap is added server-side (defense
      in depth, also improves UX).
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

## Hosting / transport (GitHub Pages)

- [ ] Confirm **Enforce HTTPS** is checked in GitHub Pages settings once a
      custom domain is attached — GitHub Pages defaults to allowing HTTP
      until this is explicitly turned on for custom domains.
- [ ] Add a `Content-Security-Policy` via `<meta http-equiv>` in each page
      (GitHub Pages can't set custom HTTP response headers) restricting
      script/style/connect sources to `'self'`, `fonts.googleapis.com`,
      `fonts.gstatic.com`, and the Apps Script `script.google.com` origin —
      reduces damage if any third-party script is ever added carelessly.
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
