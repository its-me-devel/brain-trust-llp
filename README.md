# Brain Trust Collectives — website

A 4-page static marketing site for Brain Trust Collectives, a Bangalore-based
professional-services LLP. Plain HTML, CSS and vanilla JS — no framework, no
build step. Built to run by opening the files directly (or via a simple
static server) and to deploy straight to Cloudflare Pages or GitHub Pages.

## Run locally

From this folder:

```bash
python3 -m http.server
```

Then open `http://localhost:8000` in a browser. (VS Code's "Live Server"
extension works the same way, or just open `index.html` directly.)

## Configure the contact form

The form on `contact.html` posts to a Google Apps Script web app (static
hosts can't receive form submissions directly). The ready-to-deploy script
and full click-by-click deployment steps are in
[`apps-script/README.md`](./apps-script/README.md) — it appends each
submission as a row in a Google Sheet.

Once deployed, open `js/main.js` and set:

```js
const APPS_SCRIPT_URL = 'PLACEHOLDER_APPS_SCRIPT_EXEC_URL';
```

to the deployed Apps Script `/exec` URL.

Until this is set, submitting the form will correctly show the "something
went wrong" error state — that's expected with the placeholder URL.

## Deploy to Cloudflare Pages (recommended for production)

This repo is currently live on GitHub Pages
(`https://its-me-devel.github.io/brain-trust-llp/`), which is fine for
quick iteration. For the real custom domain
(`braintrustcollectivesllp.com`), Cloudflare Pages is the better choice —
GitHub Pages can't set custom HTTP response headers at all, so the
`_headers` file at the repo root (a real `Content-Security-Policy`,
`X-Frame-Options`, etc. - see `SECURITY_AUDIT.md` §F for why that matters)
only takes effect on Cloudflare Pages. Cloudflare also has denser CDN
coverage in India than GitHub's, which matters for this site's actual
audience.

1. **Add the domain to Cloudflare** (free plan): Cloudflare dashboard →
   *Add a site* → `braintrustcollectivesllp.com`. Cloudflare scans the
   domain's existing DNS records automatically.
2. **Point the domain's nameservers at Cloudflare** at your registrar,
   using the two nameservers Cloudflare gives you. Propagation is usually
   minutes, can take up to 24h.
3. **Create the Pages project**: Cloudflare dashboard → *Workers & Pages*
   → *Create* → *Pages* → *Connect to Git* → select the
   `its-me-devel/brain-trust-llp` GitHub repo, branch `main`.
4. **Build settings**: this is a plain static site, no build step —
   leave the build command empty and the output directory as `/` (repo
   root).
5. **Deploy.** Cloudflare builds and serves it at a free
   `*.pages.dev` URL first — confirm it loads correctly there (all 4
   pages, the contact form) before attaching the real domain.
6. **Attach the custom domain**: in the Pages project → *Custom domains*
   → add `braintrustcollectivesllp.com` and `www.braintrustcollectivesllp.com`.
   Cloudflare creates the needed DNS records automatically since the zone
   is already on Cloudflare. Mark one (apex or `www`) as primary; Pages
   redirects the other to it.
7. **SSL/TLS**: Cloudflare Pages provisions a free certificate
   automatically. In the Cloudflare dashboard, under *SSL/TLS* →
   *Edge Certificates*, turn on **Always Use HTTPS**.
8. **Every subsequent `git push origin main` auto-deploys** — same
   workflow as today, just a different host picking up the same repo.
9. **Decide on the old GitHub Pages URL**: either leave it running as a
   free fallback, or turn it off (GitHub repo → Settings → Pages →
   disable) once the custom domain is confirmed working, to avoid two
   live copies of the same content.

Nothing in `apps-script/Code.gs` or `js/main.js` needs to change for this
move — the contact form posts to a fixed Apps Script URL regardless of
what domain the static frontend is served from.

### Deploy to GitHub Pages (current / fallback)

```bash
git init
git add .
git commit -m "Initial site"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

Then in the GitHub repo: **Settings → Pages → Source: `main` / root → Save**.
The site goes live at `https://<username>.github.io/<repo>/` within about a
minute.

For a custom domain here instead, add a `CNAME` file at the repo root
containing just the domain, and point DNS at GitHub Pages (a `CNAME`
record to `<username>.github.io` for a subdomain, or GitHub's documented
`A`/`ALIAS` records for an apex domain). Note: GitHub Pages cannot set
custom response headers, so `_headers` has no effect here — only on
Cloudflare Pages.

## Content still needed

Several placeholders are marked inline in the code (search for
`PLACEHOLDER`) and need real content before launch:

- **Legal entity name** — site currently says "Brain Trust Collectives"
  everywhere (matches the logo); confirm this matches the registered LLP
  name exactly for the footer legal line.
- **Team bios** — `team.html` has placeholder cards for the Industrial
  Project Management, IT Services, and Legal Services vertical leads
  (30+ years profile each, per the original brief).
- **Contact details** — confirm the email, phone, and office address in
  `contact.html` and the footer on every page are final before launch.
- **Apps Script `/exec` URL** — see "Configure the contact form" above.
- **Layered logo (optional, later)** — if a transparent/layered version of
  the logo becomes available, `js/hero.js` has a comment marking where to
  split it into two planes for real parallax depth.

## Structure

```
index.html          Home + 2.5D scroll hero
services.html        5 verticals, each an anchor target (#hr, #ipm, etc.)
team.html            Vertical-lead bios + associates
contact.html         Enquiry form
css/styles.css       Shared styles, design tokens as CSS variables
js/main.js           Nav toggle, form submit, scroll-reveal
js/hero.js           2.5D scroll effect (home only)
assets/              Logo (placeholder until real asset is supplied)
apps-script/         Contact form backend (Google Apps Script + deploy steps)
_headers             Cloudflare Pages response headers (CSP etc.) - no effect on GitHub Pages
```

Header and footer markup is repeated identically across the 4 pages (no
templating available without a build step) — if you edit nav links or
footer content, update all 4 files.
