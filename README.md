# Brain Trust Collectives — website

A 4-page static marketing site for Brain Trust Collectives, a Bangalore-based
professional-services LLP. Plain HTML, CSS and vanilla JS — no framework, no
build step. Built to run by opening the files directly (or via a simple
static server) and to deploy straight to GitHub Pages.

## Run locally

From this folder:

```bash
python3 -m http.server
```

Then open `http://localhost:8000` in a browser. (VS Code's "Live Server"
extension works the same way, or just open `index.html` directly.)

## Configure the contact form

The form on `contact.html` posts to a Google Apps Script web app (static
hosts can't receive form submissions directly). Open `js/main.js` and set:

```js
const APPS_SCRIPT_URL = 'PLACEHOLDER_APPS_SCRIPT_EXEC_URL';
```

to the deployed Apps Script `/exec` URL. To deploy the script:

1. In the target Google Sheet, add header row: `timestamp | name | email | company | vertical | message`.
2. Extensions → Apps Script, add a `doPost(e)` function that appends
   `e.parameter` values as a new row and returns a JSON success response.
3. Deploy → New deployment → Web app. Execute as **you**, access **Anyone**.
4. Copy the `/exec` URL into `APPS_SCRIPT_URL` above.

Until this is set, submitting the form will correctly show the "something
went wrong" error state — that's expected with the placeholder URL.

## Deploy to GitHub Pages

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

### Custom domain (optional)

Add a `CNAME` file at the repo root containing just your domain
(e.g. `www.braintrustcollectives.com`), and point your DNS at GitHub Pages
(a `CNAME` record to `<username>.github.io` for a subdomain, or the GitHub
Pages `A` records for an apex domain).

## Content still needed

Several placeholders are marked inline in the code (search for
`PLACEHOLDER`) and need real content before launch:

- **Legal entity name** — site currently says "Brain Trust Collectives"
  everywhere (matches the logo); confirm this matches the registered LLP
  name exactly for the footer legal line.
- **Logo** — `assets/logo-placeholder.svg` is a stand-in. Replace with the
  real `assets/logo.jpg` (or an SVG/PNG equivalent) and update the
  `<img src>` references in all 4 HTML files plus `css/styles.css`/`hero.js`
  if the format changes.
- **Team bios** — `team.html` has placeholder cards for the Industrial
  Project Management, IT Services, and Legal Services vertical leads
  (30+ years profile each, per the original brief).
- **Contact details** — `contact.html` and the footer on every page use
  placeholder email, phone, office address and LinkedIn URL.
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
```

Header and footer markup is repeated identically across the 4 pages (no
templating available without a build step) — if you edit nav links or
footer content, update all 4 files.
