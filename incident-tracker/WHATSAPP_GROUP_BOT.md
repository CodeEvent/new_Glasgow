# Gatekeeper on WhatsApp: setup guide

Stewards log and check refused patrons entirely inside your **work WhatsApp group**. A spare phone number sits in the group as the bot.

| A steward sends | Gatekeeper replies |
|---|---|
| `REFUSED 52 YY 14 West`, or a photo of the customer or their Ticketmaster QR captioned `52 YY 14`, or just `LOG` | asks the questions below, then ✅ Logged 🔴 REFUSED · 52 YY 14 · West Hub 18:45 |
| `30 52 YY 14 West 1 3 M 3 2 adult green hat` (all in one go) | ✅ Logged 🟠 SENT AWAY 30 MIN · 52 YY 14 · back after 19:15 |
| `52 YY 14` | 🔴 REFUSED … with the reasons, description, who logged it, where and when, plus the photo |
| `52 YY 14` (nothing logged) | ✅ NOT REFUSED |
| `LIST` | everyone refused or sent away right now: seat, reasons, hub and time, description, 🚨 if they tried another hub |
| `HUB WEST` (or `HUB 2`) | 🏟️ sets your hub for the shift (12 h): no more hub question. `HUB` shows it, `HUB OFF` clears it. For someone **already refused or sent away**, the bot still asks *which hub are they trying to get in at?* |
| a seat that's already refused/sent away | ⚠️ flagged straight away; the record gets the reason **"Already refused, tried re-entry"** (or "Already sent away, …") plus any new reasons, and 🚨 if it's another hub |
| `STATS` | tonight's numbers: refused, ejected, sent away, cleared, hub-hops, by reason, by hub, minors, people in groups |
| `313 L` or `234 O` (section and row), `313` or `SECTION 313` (whole section) | 🔎 everyone on record there, in seat order. A bare number only gets a reply if something is on record, so normal chat like "10" is ignored. |
| `FIND green hat` | searches tonight's descriptions, reasons and notes; for when you see someone but don't know their seat |
| `NOTE 52 YY 14 came back calm` | 🗒️ adds a note to a saved record; checks show the latest notes |
| `REFUSED 300 L 205 206 207 West` (also `205,206,207`, `205, 206 and 207`, `205-207`) | 👥 logs a **group**: one record per seat, the questions asked once for everyone, marked "group of 3". Up to 20 seats. `UNDO` removes the whole group; `EDIT 300 L 206` changes one person. Write the hub after the seats: in `300 L 205 1 2`, the 1 and 2 are read as reasons. |
| `300 L 205 206 207` | 🔎 checks every seat in one reply |
| a photo/screenshot of the **ticket** captioned `REFUSED` (or `30`, `EJECTED`, or sent when the bot asks "Which seat?") | 🎫 reads section, row and seat from the ticket **on the phone** (nothing is uploaded). If it shows several seats, the bot lists them: reply `1 3` or `ALL`. Seats can be in different rows; each gets its own record. |
| a ticket photo captioned `SCAN` | 🔎 reads the seats and checks them; send `REFUSED West 1 -` (or `30`/`EJECTED`) within 5 minutes to log them |
| `PARTY 52 YY 14 3` | 👥 sets the group size. Or add `x3` / `party of 3` to the log line: `REFUSED 52 YY 14 West x3` |
| `EJECTED 52 YY 14 West` | ⛔ logs someone removed from **inside** the venue (or answer *3* to the first question). Treated as refused at every gate. |
| `EDIT 52 YY 14` | ✏️ re-asks the reasons and description of a saved record. Your own last log, or any record for group admins. `CANCEL` keeps it as it was. |
| `CLEAR 52 YY 14` (**group admins only**) | 🟢 marks that person as allowed in now, noting who and when |
| a photo captioned `PHOTO 52 YY 14` | 📷 adds the photo to an already saved record |
| `REPORT` (**group admins only**, in a **private chat** with the bot) | the spreadsheet (CSV) of everything on record |

**Supervisors = WhatsApp admins of the work group.** Make a supervisor a group admin (Group info → tap them → Make group admin) and they can use `CLEAR` and `REPORT`. Everyone else can log, check, `LIST` and `STATS`.

**The bot also posts on its own** (each can be switched off, see Settings):
- 🚨 **Hub-hop alert**: when someone already refused or sent away tries another hub, the alert goes to every selected group (and to the group if the log came from a private chat).
- 🟡 **Readmit reminder**: when a sent-away person's 30 minutes are up: "52 YY 14 may now be readmitted if fit".
- 🌙 **End-of-night summary** at 23:30 (only if anything was logged that night).
- 🗂️ **Nightly backup**: at the same time, each **group admin** gets the spreadsheet in a private chat, before the 24-hour auto-delete.
- ✅ **Health**: group admins get a private "Gatekeeper is online" after the bot starts, and on the Android phone 🔌 / 🪫 alerts when it's unplugged or below 20% battery. Battery alerts need the free **Termux:API** app (F-Droid, same source as Termux).
| a log for a seat already flagged at another hub | 🚨 ALREADY REFUSED … second attempt, ⛔ do not admit |

The bot asks for anything missing, one question at a time, with numbered options:

1. **Refused entry, or sent away for 30 minutes?** 1 Refused entry · 2 Sent away 30 min
2. **Seat**, e.g. `52 YY 14` (section, row, seat), and **hub**: 1 East · 2 West · 3 South · 4 Hospitality (asked every time; the bot shows your last hub as a hint)
3. **Reasons** (one or more, e.g. `1 3 5`): 1 Intoxicated · 2 Abusive · 3 Under the influence · 4 Intoxicated minor · 5 Found in possession · 6 Other. If 6 is picked, the bot asks "What happened?" and records the answer.
4. **Male or female:** M or F
5. **Height:** 1 Short · 2 Average · 3 Tall
6. **Build:** 1 Slim · 2 Average · 3 Heavy
7. **Minor or adult:** 1 Adult · 2 Minor (under 18)
8. **What they're wearing:** free text

Reply `-` to skip a description question (4 to 8). Quick stewards can put it all on one line in that order: decision, seat, hub, reasons, M/F, height, build, adult/minor, clothing, e.g. `REFUSED 52 YY 14 West 1 3 M 3 2 adult green hat`. The time is added automatically. `BACK` reopens the previous question so you can change your answer, `CANCEL` stops a half-finished log, `UNDO` removes your last saved record (within 15 minutes), and `HELP` shows the commands.

**Everything is deleted automatically after 24 hours.**

> **Read this first.** The bot runs on an ordinary WhatsApp account linked to the server (like WhatsApp Web). WhatsApp's terms don't allow automating a normal account, so **WhatsApp could ban the spare number** without warning. Your own and your colleagues' numbers are not at risk. Don't use a number you can't afford to lose.

---

## Seating map (records page)

On the records page (`http://localhost:3000/admin/records`), tap **Map**:
1. **Upload plan image**: a seating plan you're allowed to use (e.g. from the venue). PNG, JPEG, WebP or GIF, up to 10 MB. It's stored only in the phone's database, never online or in the code.
2. **Place blocks**: type a block number (e.g. `313`), tap where it is on the plan. Numbers count up after each tap (313 → 314), so you can go along a row quickly. Tap a marker to remove it. **Done** when finished.
3. Each placed block shows a live marker: 🔴 refused, ⛔ ejected, 🟠 sent away, ⚫ cool-off ended, with counts. Tap a block to see its records. Blocks with records but no position are listed under the plan.

Markers are per **block** (section), not per seat: seat-by-seat positions aren't published for the arena.

---

## Optional: AI helper (plain English)

Off until you add an API key. Then stewards can:
- **ask questions**: start with `GK` or @mention the bot, e.g. `GK anyone in a red coat sent away in the last hour?`, `GK how many refused at West?`. In a private chat with the bot, just type.
- **log in plain English**: `GK refused a drunk lad in a green hat, swearing at staff, 313 YY 56 West`. The bot shows what it understood (*Check this before I save it*) and asks for anything missing. **Nothing is saved until the steward replies YES.**

Ordinary group chat is never sent to the AI: only messages starting with `GK`, @mentions, private chats, and log lines the bot can't read itself.

**What leaves the phone:** the steward's message and the matching records (seat, status, reasons, description, hub and time, notes). **Never** photos, steward names, phone numbers or ticket/QR codes. The AI can only read records; saving, clearing and deleting stay with the normal commands. `AI_DAILY_LIMIT` (default 200 a day, 30 per steward per hour) caps use; each call's tokens show in `gk-log` as `[ai] …`.

### Faster reporting with the AI on

- **One description question:** instead of five numbered questions, *Describe them*: `tall heavy lad about 20, green hat` (short codes like `M 3 2 adult green hat` still work, `-` skips). If the AI is busy, the numbered questions come back.
- **Ticket photo + a few words:** photo of the ticket captioned `drunk, swearing, tall lad green hat, West`. The seat is read **on the phone**; only the words go to the AI. You confirm with **YES**.
- **Voice notes** (private chat with the bot only, under a minute): say *"Refused, 101 A 4, very drunk and abusive, tall guy in a blue cap, South hub"*, then **YES**. The recording goes to Google; voice notes in the group are never downloaded.
- **Advice from your policy:** an admin sends `POLICY Refuse if aggressive or can't stand; 30 minutes if mildly drunk and calm…`; stewards send `ADVICE slurring, unsteady, polite`. When a plain-English report doesn't say refused or sent away, the bot shows the policy suggestion and **asks**; the AI never decides that for you.

### Free: Google Gemini (recommended to start)

1. On any device, go to **https://aistudio.google.com**, sign in with a Google account, and click **Get API key → Create API key**. No card needed.
2. On the Android, in Termux: `gk-set GEMINI_API_KEY <your key>` (stored only on the phone, never shown again). `gk-log` shows `AI helper on (gemini-flash-lite-latest, …)`.
3. Send `HELP` in the group: the AI part is listed at the end.

**Free tier limits:** the bot uses **Flash-Lite**, whose free quota is much bigger than Flash's (Flash allowed only **20 requests a day**). Brief Google overloads are retried automatically. Google allows a limited number of requests per minute and per day; when they run out, the bot says the AI is busy and the normal commands keep working. **Privacy:** on the free tier Google may use what's sent to improve its products (and people at Google may review it). The bot only sends descriptions and reasons, never photos or names, but **mention Google as a processor in your privacy notice.** A paid Google plan or Claude avoids this.

### Paid: Claude (Anthropic)

Better answers; paid per use (about 1–3p a question), not used for training. Create a key at https://console.anthropic.com (add a card and a **monthly spend limit**), then `gk-set ANTHROPIC_API_KEY <your key>`. If both keys are set, Gemini is used; switch with `gk-set AI_PROVIDER claude` (or `gemini`, or `auto`).

**Other settings:** `gk-set AI_MODEL gemini-2.5-flash` picks a specific model; `gk-set AI_DAILY_LIMIT 50` lowers the cap. **To switch the AI off:** `sed -i '/_API_KEY=/d' ~/gatekeeper-data/settings.env && gk-stop && gk-start`.

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

## Free option: run it on an Android phone (always on)

Any Android phone that stays **plugged in and online** can run the bot all the time, for free. It doesn't have to be the phone with the bot's WhatsApp number: it links to that number the same way the laptop does. An iPhone can't do this (iOS doesn't allow it).

**You need** two free apps from the **same place** (both from F-Droid, or both from GitHub; Android rejects a mix):
- **Termux**: https://f-droid.org/packages/com.termux/
- **Termux:Boot**, which restarts the bot after the phone reboots: https://f-droid.org/packages/com.termux.boot/ (open it once after installing)

If Termux came from the Play Store and the install below fails at the first step, reinstall Termux from F-Droid.

**1. Stop the laptop bot first**, or both will answer every message: on the laptop's setup page click **Unlink**, then `Ctrl+C` in its terminal.

**2. Install**: open Termux on the Android phone and paste these three lines:
```bash
pkg install -y git
git clone --depth 1 -b claude/inspiring-fermi-ujdf1c https://github.com/CodeEvent/new_Glasgow.git ~/new_glasgow
bash ~/new_glasgow/incident-tracker/scripts/android/install.sh
```
If the first line fails, run `termux-change-repo`, pick another mirror, and try again. If `git clone` can't connect, switch between Wi-Fi and mobile data.
It takes about 5–10 minutes the first time. At the end it prints the **admin key**.

**3. Link**: in Chrome on the Android phone, open `http://localhost:3000/admin/whatsapp`, paste the admin key, and scan the QR with the phone that has the bot's WhatsApp number (WhatsApp → Settings → Linked devices → Link a device). Tick the work group, **Save**, **Send test**. The records page is `http://localhost:3000/admin/records` on the same phone.

**4. Keep it awake** (this matters; Android otherwise stops the bot after a while):
- Settings → Apps → **Termux** → Battery → **Unrestricted** (on some phones: "Don't optimise" or "Allow background activity"). Do the same for **Termux:Boot**.
- Samsung: also Settings → Battery → Background usage limits → add Termux to **Never sleeping apps**.
- Keep the phone **charging** and on Wi-Fi or mobile data. Turn off any automatic restart schedule.

**Everyday commands** (type them in Termux):

| Command | What it does |
|---|---|
| `gk-status` | Is the bot running? |
| `gk-key` | Show the admin key |
| `gk-log` | The last lines of the bot's log (`[linked-wa]` lines show the WhatsApp connection) |
| `gk-stop` / `gk-start` | Stop / start it |
| `gk-update` | Get the latest version and restart; records and the WhatsApp link are kept |
| `gk-set` | Show the settings; `gk-set SUMMARY_TIME 22:45` changes one and restarts (see Settings below) |

The bot restarts by itself if it crashes, and after the phone reboots (thanks to Termux:Boot). Records, photos and the link are kept in `~/gatekeeper-data` on the phone.

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
- **Keep the bot's own posts few.** It posts unprompted only for hub-hop alerts, readmit reminders and the nightly summary. If you're worried about the number being banned, switch the reminders off first (`WA_READMIT_REMINDERS=off`); they're the most frequent. Leave `WA_LINKED_POST_ALERTS` off (the default).
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
| `WA_HUBHOP_ALERTS` | on | 🚨 Post hub-hop alerts to the selected groups. `off` to stop. |
| `WA_READMIT_REMINDERS` | on | 🟡 Post when a sent-away person may come back. `off` to stop. |
| `SUMMARY_TIME` | `23:30` | 🌙 Time of the end-of-night summary (`HH:MM`), or `off`. |
| `WA_NIGHTLY_BACKUP` | on | 🗂️ Send the spreadsheet privately to group admins at `SUMMARY_TIME`. `off` to stop. |
| `WA_HEALTH_ALERTS` | on | ✅ "online" message and 🔌/🪫 battery alerts to group admins. `off` to stop. |
| `OCR_ENABLED` | on | 🎫 Read seats from ticket photos on the phone. `off` to stop (saves battery). Ticketmaster's mobile QR codes are encrypted, so the seat is read from the printed text. |
| `WA_SUPERVISOR_ONLY` | on | `CLEAR` and `REPORT` only for group admins. `off` lets anyone in the group use them (not recommended: anyone could let a refused person in, or download everyone's descriptions). |

On the Android phone, change these with `gk-set`, e.g. `gk-set SUMMARY_TIME 22:45` or `gk-set WA_READMIT_REMINDERS off`. On Render, use the Environment tab.
