# Contact form backend (Google Apps Script)

Static hosts can't receive form POSTs, so the contact form on `contact.html`
posts to a Google Apps Script Web App, which appends each submission as a
row in a Google Sheet.

## 1. Create the Sheet

1. Log into **braintrustllp@gmail.com**.
2. Go to [sheets.google.com](https://sheets.google.com) → **Blank spreadsheet**.
3. Name it something like `Brain Trust - Contact Submissions`.

## 2. Add the script

1. In the Sheet, go to **Extensions → Apps Script**.
2. Delete the placeholder `Code.gs` content and paste in the contents of
   [`Code.gs`](./Code.gs) from this repo.
3. Save the project (⌘S / Ctrl+S). Name it e.g. `contact-form-endpoint`.

You don't need to create the `Submissions` tab or header row yourself - the
script creates both on the first real submission.

## 3. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" → **Web app**.
3. Settings:
   - **Execute as:** Me (braintrustllp@gmail.com)
   - **Who has access:** Anyone
4. Click **Deploy**.
5. Google will prompt an authorization flow (this is your own script asking
   permission to write to your own Sheet) - click through it, choosing the
   braintrustllp@gmail.com account.
6. Copy the **Web app URL** - it ends in `/exec`.

## 4. Wire it into the site

Open `js/main.js` and replace the placeholder:

```js
const APPS_SCRIPT_URL = 'PLACEHOLDER_APPS_SCRIPT_EXEC_URL';
```

with the `/exec` URL you copied, then commit and deploy.

## 5. Authorize the email notification

Every submission also emails a copy to `NOTIFY_TO` at the top of `Code.gs`
(`braintrustllp@gmail.com` by default - comma-separate to add recipients).
Sending mail needs a scope the Sheet-writing steps above didn't already grant,
so before relying on it:

1. In the Apps Script editor, select the `testNotification` function from the
   function dropdown (next to Run/Debug) and click **Run**.
2. Google will prompt a second authorization flow for the Gmail send scope -
   click through it, choosing the braintrustllp@gmail.com account.
3. Confirm the test email arrives at `NOTIFY_TO`.

If you skip this, real submissions still get written to the Sheet - the
notification email just silently fails and gets logged (it can never fail
the actual submission), until this authorization step is done.

## 6. Test it

1. Open `contact.html` (locally or on the live site) and submit the form.
2. Confirm a new row appears in the `Submissions` tab, and that the
   notification email arrived.
3. Leave the honeypot field alone - it's hidden from real users - a real bot
   filling it will get a silent "ok" response with no row written and no
   email sent.

## Updating the script later

If you edit `Code.gs` in the Apps Script editor after the first deploy, the
`/exec` URL only picks up the change once you **Deploy → Manage deployments
→ Edit (pencil) → New version → Deploy**. Saving alone is not enough.
