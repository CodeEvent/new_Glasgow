---
type: doc
status: active
tags: [gatekeeper-app, stewards, termux, cloudflare-tunnel, roles, events]
relatedTo: [whatsapp-group-bot, gatekeeper-android-deploy]
---

# Gatekeeper app guide

The Gatekeeper app replaces the WhatsApp bot. Supervisors log refusals, people sent away for 30 minutes and ejections with a few taps. Everyone sees the live feed, and senior supervisors see the dashboard and the final numbers for each event. It runs on the Android phone in Termux, for free.

## Set up (once)

1. On the Android phone, in Termux: `gk-update` (or a fresh install, see [WHATSAPP_GROUP_BOT.md](WHATSAPP_GROUP_BOT.md)).
2. On that phone, open Chrome: `http://localhost:3000/app/`
3. Enter the **admin key** (`gk-key` shows it), your name and a **6-digit PIN**. You are the **superadmin**.
4. **People:** add everyone with a name, a role and a 6-digit PIN. Give each person their PIN face to face.
5. **Settings:**
   - the venue name;
   - the refusal policy (shown on the logging screen);
   - the AI helper on or off;
   - the seating plan: upload a picture, then tap where each section is.
6. Run `gk-url` on the phone, or open **Settings → Share the app**. Supervisors scan the QR code, log in, and use **Add to Home Screen**.

## Who can do what

| | Area supervisor | Senior supervisor | Superadmin |
|---|---|---|---|
| Log refused / 30 min / ejected | own area only | any area | any area |
| Check a seat, live feed | ✅ all areas | ✅ | ✅ |
| Change a record | only records only they logged, and only more serious | anything, clear, delete | anything, clear, delete |
| Dashboard, events, reports, spreadsheet | ❌ | ✅ | ✅ |
| Settings, people, PINs | ❌ | ❌ | ✅ |

## On the night

- **Start the event:** Events & reports → Start, e.g. *Celtic v Rangers*. The dashboard counts from that moment.
- **Log someone:** tap Refused, 30 min or Ejected, enter the seat, then your area, the reasons and the description.
  - **Seat:** type it (`313` `YY` `56`), or tap **📷 Scan ticket**. For a group in one row, type several seats: `205 206 207` or `205-207`.
  - **Area:** set already for area supervisors.
  - **Description:** optional buttons, or one sentence if the AI is on.
  - **⚠️ Warning:** if the seat is already on record, it appears as you type. Saving logs a re-entry attempt.
- **No signal:** the log is kept on the phone ("1 waiting") and sent automatically later. Only the person who wrote it can send it.
- **Live feed:** every log as it happens.
  - **Re-entry:** a red banner with sound and vibration on every phone.
  - **Cool-off over:** a yellow banner says "may now be readmitted if fit".
- **End the event:** Events & reports → End. Its final numbers are kept for good. The report has a **Download spreadsheet** button.

## Logging in

- **Name and PIN:** each person logs in with their name and a 6-digit PIN. A login lasts one shift (16 hours).
- **Wrong PINs:** after 5 wrong tries the name is locked on that phone for 15 minutes. After 20 from any phones it's locked everywhere, and each new lock lasts longer. The superadmin can **Unlock** someone in People.
- **Trusted phones:** a phone that has logged in before keeps working even if someone else is guessing at that name.
- **Lost phones and leavers:** give the person a new PIN, or switch them off in People. That logs them out everywhere and cancels their trusted phones.

## The address other phones open

- **Default:** the phone runs a free Cloudflare quick tunnel. The address looks like `https://xxxx.trycloudflare.com/app/` and **changes when the phone restarts**. After a restart, run `gk-url` and share the new address or QR code. Supervisors then log in again and re-add the home-screen icon.
- **Fixed address (optional):** this needs your own domain on Cloudflare. Create a tunnel in the Cloudflare dashboard, pointed at `http://localhost:3000`, then run:
  - `gk-set TUNNEL_TOKEN <token>` (the token is kept hidden);
  - `gk-set TUNNEL_URL https://gatekeeper.yourdomain.com`.
- **This phone only:** `gk-set GK_TUNNEL off`.

## Records and privacy

- **Records:** with descriptions, kept **30 days**, then deleted automatically. Change this with `gk-set RETENTION_HOURS`.
- **Event numbers:** each event's final numbers are counts only, and are kept for good.
- **Audit log:** every change to a record, a person or the settings is written to it.
- **Photos:** ticket photos are only read for the seat number, and aren't stored.

## Phone commands

| Command | What it does |
|---|---|
| `gk-status` | is it running? |
| `gk-url` | the address and QR code for other phones |
| `gk-key` | the admin key (first-time setup) |
| `gk-log` | the last lines of the log |
| `gk-update` | update to the latest version |
| `gk-set NAME value` / `gk-unset NAME` | change a setting (restarts) |
| `gk-stop` / `gk-start` | stop / start |

## The WhatsApp bot

It's switched off now. To switch it back on as a backup, run `gk-set WA_LINKED_ENABLED true`. It still works as described in [WHATSAPP_GROUP_BOT.md](WHATSAPP_GROUP_BOT.md).
