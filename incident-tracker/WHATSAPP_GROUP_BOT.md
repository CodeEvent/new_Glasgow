# Gatekeeper on WhatsApp: setup guide

Stewards log and check refused patrons entirely inside your **work WhatsApp group**. A spare phone number sits in the group as the bot.

| A steward sends | Gatekeeper replies |
|---|---|
| `REFUSED 52 YY 14 West`, or a photo of the customer or their Ticketmaster QR captioned `52 YY 14`, or just `LOG` | asks the questions below, then ✅ Logged 🔴 REFUSED · 52 YY 14 · West Hub 18:45 |
| `30 52 YY 14 West 1 3 M 3 2 adult green hat` (all in one go) | ✅ Logged 🟠 SENT AWAY 30 MIN · 52 YY 14 · back after 19:15 |
| `52 YY 14` | 🔴 REFUSED … with the reasons, description, who logged it, where and when, plus the photo |
| `52 YY 14` (nothing logged) | ✅ NOT REFUSED |
| a log for a seat already flagged at another hub | 🚨 ALREADY REFUSED … second attempt, ⛔ do not admit |

The bot asks for anything missing, one question at a time, with numbered options:

1. **Refused entry, or sent away for 30 minutes?** 1 Refused entry · 2 Sent away 30 min
2. **Seat**, e.g. `52 YY 14` (section, row, seat), and **hub** (remembered for the night)
3. **Reasons** (one or more, e.g. `1 3 5`): 1 Intoxicated · 2 Abusive · 3 Under the influence · 4 Intoxicated minor · 5 Found in possession · 6 Other. If 6 is picked, the bot asks "What happened?" and records the answer.
4. **Male or female:** M or F
5. **Height:** 1 Short · 2 Average · 3 Tall
6. **Build:** 1 Slim · 2 Average · 3 Heavy
7. **Minor or adult:** 1 Adult · 2 Minor (under 18)
8. **What they're wearing:** free text

Reply `-` to skip a description question (4 to 8). Quick stewards can put it all on one line in that order: decision, seat, hub, reasons, M/F, height, build, adult/minor, clothing, e.g. `REFUSED 52 YY 14 West 1 3 M 3 2 adult green hat`. The time is added automatically. `UNDO` removes your last record, `CANCEL` stops a half-finished log, and `HELP` shows the commands.

**Everything is deleted automatically after 24 hours.**

> **Read this first.** The bot runs on an ordinary WhatsApp account linked to the server (like WhatsApp Web). WhatsApp's terms don't allow automating a normal account, so **WhatsApp could ban the spare number** without warning. Your own and your colleagues' numbers are not at risk. Don't use a number you can't afford to lose.

---

## Free option: run it on your laptop

No accounts and no cost. The bot connects out to WhatsApp like WhatsApp Web, so it doesn't need a website. It answers while the laptop is **on, awake and online**.

1. **Get the code (once).** In a terminal:
   ```bash
   cd ~
   git clone https://github.com/codeevent/new_glasgow.git
   cd new_glasgow
   git checkout claude/inspiring-fermi-ujdf1c
   cd incident-tracker
   npm install
   ```
   Already cloned? Run `cd ~/new_glasgow && git pull && cd incident-tracker && npm install` instead.
2. **Start it**, from inside `incident-tracker`:
   ```bash
   npm run local
   ```
   It prints the setup-page address and your **admin key**.
3. **Link the phone.** Open `http://localhost:3000/admin/whatsapp` on the laptop, paste the admin key, and scan the QR with the spare phone (WhatsApp → Settings → Linked devices → Link a device). Then tick your work group, **Save**, **Send test**.
4. **Leave the terminal window open.** `Ctrl+C` stops the bot. Next time, run `npm run local` again; the phone stays linked.

**See and manage everything logged** at `http://localhost:3000/admin/records` (same admin key; use the port you started with):
- live list of refused and sent-away people, updating every 5 seconds, with the reason, description, hub, steward, time and photo;
- search by seat (`52 YY 14`), reason or clothing, and filter by hub, status, or "tried another hub";
- tap a record to see its history and photos, change it to refused / sent away / admitted, fix the reason or description, or delete it;
- **Export CSV** for an end-of-night report, before the 24-hour auto-delete.

**Keep the laptop awake** on event days:
- Plug it in.
- Ubuntu: Settings → Power → set **Automatic Suspend** to **Off**.
- Keep the lid open, or set it to do nothing when closed.
- Or start it with `systemd-inhibit --what=sleep:idle npm run local`, which blocks sleep while the bot runs.

Records and photos are saved in `incident-tracker/local-data/` and deleted automatically after 24 hours. If the laptop sleeps or loses internet, the bot reconnects by itself when it's back.

Want it running even when your laptop is off? Use the cloud setup below.

---

## Cloud setup (always on)

## What you need

- A **spare phone number** (a cheap SIM) in a phone you can leave charged. An old phone is fine.
- Free accounts on **GitHub** (you have one), **Supabase** (database) and **Render** (server, about $7/month on the Starter plan).
- About 30 minutes.

## 1. Spare phone (start today, link later)

1. Put the SIM in a phone and install **WhatsApp** (or WhatsApp Business) with that number.
2. Set a name and profile photo, e.g. "Gatekeeper".
3. **Use it normally for a few days**: message a few people, and get a colleague to add it to your **work group**. Brand-new numbers that start automating immediately are the most likely to be banned.

## 2. Database (Supabase), 5 minutes

1. supabase.com → **New project** → region **London**. Save the database password.
2. **Connect → Session pooler** → copy the URI and put your password in it. This is your `DATABASE_URL`.

The server creates its tables itself.

## 3. Server (Render), 10 minutes

1. render.com → **New → Blueprint** → choose the **new_glasgow** repository and the `claude/inspiring-fermi-ujdf1c` branch, or merge it into main first.
2. When asked, paste your `DATABASE_URL`. Everything else is pre-filled.
3. Click **Apply** and wait for the deploy to go green.
4. In the service's **Environment** tab, reveal and copy **`ADMIN_API_KEY`**.

**Run exactly one instance.** Two servers would fight over the same WhatsApp link.

## 4. Link the spare phone, 3 minutes

1. On your laptop, open `https://<your-app>.onrender.com/admin/whatsapp` and enter the `ADMIN_API_KEY`.
2. A QR code appears. On the **spare phone**: WhatsApp → **Settings → Linked devices → Link a device** → scan it.
   - Only have the spare phone with you? Type its number on the page and tap **Get code**. Then, on the spare phone, choose **Link with phone number instead** and enter the 8-character code.
3. The page shows **Connected**. Under "Which groups…", tick your **work group** and click **Save**.
4. Click **Send test**. Gatekeeper says hello in the group.

The link is stored in the database, so it survives restarts and redeploys. You only do this once.

## 5. Try it in the group

1. `HELP` shows the commands.
2. `30 52 YY 14 West 1 -` (`-` skips the description): you should get ✅ Logged 🟠 SENT AWAY.
3. `52 YY 14`: you should get 🟠 SENT AWAY with minutes left.
4. `UNDO` removes the test record.

Then show your colleagues the table at the top of this page.

## Keeping the ban risk down

- **One group only**, and keep the spare number out of other groups.
- **Leave alerts off** (`WA_LINKED_POST_ALERTS=false`, the default). The bot then only ever replies to stewards and never posts first.
- The bot already ignores ordinary chat and random photos, and paces its replies.
- **Keep the spare phone charged and online now and then.** Linked devices are dropped if the main phone is offline for about 14 days.
- **Tell your colleagues** a bot is in the group and that it reads seat checks and logs.

## If something goes wrong

| Symptom | What to do |
|---|---|
| The setup page says "Wrong admin key" | Copy `ADMIN_API_KEY` again from Render → Environment. |
| The page shows "Switched off" | Set `WA_LINKED_ENABLED=true` on Render. |
| The QR never appears | Render → **Logs**. Look for `[linked-wa] connection closed (code …)` and the reason. |
| "Taken over by another server" | Two copies are running. Make sure Render runs one instance, then restart the service. |
| The bot doesn't answer in the group | On the setup page, check the group is **ticked and saved**. In Render's logs, messages from unticked groups are ignored. |
| The spare number was banned | Link a different spare number (step 4), or move to the official WhatsApp API later (`GO_LIVE.md`) once a verified business owns it. |
| The phone shows "logged out" | It was unlinked from the phone. Open the setup page and link it again. |

## Settings (Render → Environment)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none | Supabase connection string (required). |
| `WA_LINKED_ENABLED` | `true` | Turns the WhatsApp group bot on. |
| `ADMIN_API_KEY` | generated | Protects the setup page. |
| `WA_LINKED_POST_ALERTS` | `false` | Also post alerts from the web steward form into the group. |
| `RETENTION_HOURS` | `24` | Records and photos older than this are deleted. |
| `COOL_OFF_MINUTES` | `30` | Length of a "sent away" cool-off. |
| `TZ_DISPLAY` | `Europe/London` | Time zone used in replies. |
