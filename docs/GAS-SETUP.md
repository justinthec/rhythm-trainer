# Cloud sync setup (Google Apps Script + Google Sheets)

One-time setup, about 5 minutes, completely free. Your stats live in your own
Google Sheet; the app talks to a tiny Apps Script web app in front of it.

## 1. Create the Sheet + script

1. Go to [sheets.new](https://sheets.new) and create a blank spreadsheet
   (name it e.g. "Rhythm Trainer Data").
2. In the Sheet: **Extensions → Apps Script**. A script editor opens.
3. Delete the placeholder code and paste the full contents of
   [`gas/Code.gs`](../gas/Code.gs) from this repo.
4. Near the top, change `SECRET` to a long random string of your own
   (this is the only thing protecting your data — make it unguessable).
5. Save (💾 or Ctrl+S).

## 2. Deploy as a web app

1. Click **Deploy → New deployment**.
2. Click the gear next to "Select type" → **Web app**.
3. Settings:
   - Description: anything
   - **Execute as: Me**
   - **Who has access: Anyone** (the secret in the request body is the auth)
4. Click **Deploy**, authorize the script when prompted
   (it only touches this one spreadsheet).
5. Copy the **Web app URL** — it ends in `/exec`.

## 3. Connect the app

1. Open Rhythm Trainer → **Settings → Cloud sync**.
2. Paste the Web app URL and the same secret you set in step 1.4.
3. Click **Test connection** — you should see "Connected".

That's it. From now on:

- Every session you finish is pushed automatically (debounced ~3s).
- On app load, the newest copy wins — play on your laptop, then your phone,
  and the data follows you.

The script populates these tabs in your Sheet:

- **`state`** — the complete backup: the entire app state as a JSON blob
  (every setting, custom song, and session). Restoring from this brings
  back *everything*. Not meant for human reading.
- **`sessions`** — append-only, human-readable log: one row per finished
  session with grade, accuracy, score, timing (mean/σ/drift), the
  perfect/good/okay/miss/extra counts, and Flying-Blind stats incl. beats
  survived. Chart it with normal spreadsheet tools.
- **`songs`** — your custom songs (title, artist, BPM, start timestamp,
  video ID), rewritten on each sync.
- **`settings`** — your preferences (input offset, anchor taps, last blind
  mode, polyrhythm, clap sensitivity, last calibration) and counts of
  custom songs / sessions / overrides. API keys and the sync secret are
  kept out of this readable tab (they still live in `state`).

## Updating the script later

If you ever paste a newer `Code.gs`: **Deploy → Manage deployments → ✏️ Edit
→ Version: New version → Deploy**. Do NOT create a brand-new deployment —
that generates a different URL and you'd have to update Settings.

## Troubleshooting

- **"Bad secret"** — the secret in Settings doesn't match `SECRET` in Code.gs.
- **"Connection failed: Failed to fetch"** — usually the deployment is not
  set to "Anyone", or you copied the `/dev` URL instead of `/exec`.
- **Changed the code but behavior didn't change** — you deployed a new
  version? See "Updating the script later" above.
- Sync failures never block the app: everything is saved to localStorage
  first, and you can always **Export JSON** from Settings as a backup.
