# Going live: text Gatekeeper from your own WhatsApp

About 45 minutes. When you finish, you will text **Check 112 F 14** from your phone and get the ticket profile back, and every refusal, hub-hop and breach logged on the steward form will land on your WhatsApp.

You need three free accounts: **Meta for Developers** (the WhatsApp number), **Supabase** (the database) and **Render** (the server with an https address Meta can reach).

Do the steps in order. Each step lists the values to copy into the next one.

---

## 1. Database (Supabase), 5 minutes

1. Go to supabase.com and create a project. Choose region **London (eu-west-2)** and save the database password somewhere safe.
2. Open **Connect** (top of the project page) → **Session pooler**, and copy the URI. It looks like
   `postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`
3. Replace `[YOUR-PASSWORD]` with your password. This is your **DATABASE_URL**.

You don't need to create any tables. The server applies the migrations every time it starts.

> Use the *Session pooler* address, not "Direct connection". Render can't reach Supabase's direct (IPv6-only) address.

## 2. WhatsApp number (Meta), 15 minutes

1. Go to developers.facebook.com → **My Apps** → **Create app**. Pick the WhatsApp use case ("Connect with customers through WhatsApp"), then create or choose a Business portfolio.
2. In the app, open **WhatsApp → API Setup**. Meta gives you a free **test phone number**. Copy:
   - **Phone number ID**: your **WHATSAPP_PHONE_NUMBER_ID**
   - **Temporary access token**: your **WHATSAPP_ACCESS_TOKEN** for today (it expires after 24 hours; step 6 replaces it)
3. In the **To** box on the same page, choose **Manage phone number list**, add **your own mobile number** and enter the code WhatsApp sends you. The test number can only message numbers on this list (up to 5).
4. Open **App settings → Basic**, click **Show** next to App secret and copy it. This is your **WHATSAPP_APP_SECRET**.
5. Save the test number in your phone's contacts as "Gatekeeper".

## 3. Server (Render), 10 minutes

1. Merge the `claude/inspiring-fermi-ujdf1c` branch into your main branch on GitHub, or pick that branch when Render asks.
2. Go to render.com → **New** → **Blueprint**, connect GitHub and choose the **new_Glasgow** repository. Render reads `render.yaml` and creates the **gatekeeper** service.
3. Fill in the values it asks for:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase URI from step 1 |
   | `WHATSAPP_ACCESS_TOKEN` | the token from step 2 |
   | `WHATSAPP_PHONE_NUMBER_ID` | the phone number ID from step 2 |
   | `WHATSAPP_APP_SECRET` | the app secret from step 2 |
   | `WHATSAPP_SUPERVISOR_NUMBERS` | your mobile with country code, e.g. `+44 7700 900123` (comma-separate more people) |
   | `WHATSAPP_GROUP_ID` | leave blank (see "Group chat" below) |
   | `WHATSAPP_ALERT_TEMPLATE` | leave blank for now (step 7) |

   Render generates `WHATSAPP_VERIFY_TOKEN` and `STEWARD_API_KEY` for you.
4. Click **Apply**. When the deploy is green, copy the service address, e.g. `https://gatekeeper-x1y2.onrender.com`. Open `https://…/healthz`; it should show `{"ok":true}`.
5. In the service's **Environment** tab, reveal and copy `WHATSAPP_VERIFY_TOKEN` and `STEWARD_API_KEY`.

> The blueprint uses the **Starter** plan (about $7/month). The free plan sleeps after 15 minutes without traffic, and the first WhatsApp message after that waits for the server to wake up.

## 4. Connect WhatsApp to the server (Meta), 3 minutes

1. Back in the Meta app: **WhatsApp → Configuration → Webhook → Edit**.
2. **Callback URL**: `https://<your-render-address>/api/whatsapp/incoming`
3. **Verify token**: the `WHATSAPP_VERIFY_TOKEN` from Render. Click **Verify and save**. If it fails, check the address has no trailing slash and the token matches exactly.
4. Under **Webhook fields**, click **Subscribe** next to **messages**.

## 5. Test it from your phone

1. **Text the bot.** In WhatsApp, send `Help` to the Gatekeeper contact. You should get the command list back within a couple of seconds.
2. **Log a refusal like a steward.** On your phone, open `https://<your-render-address>/`:
   - enter your name, pick **West Hub**, paste the `STEWARD_API_KEY` into *Access key*, and tap **Start shift**;
   - tap **📷 Scan QR** and point it at a Ticketmaster ticket (or any QR code), or skip the scan;
   - enter **Section 112, Row F, Seat 14**, choose **Sent away (30 min)**, add a description and submit.

   An orange **COOL-OFF LOGGED** alert arrives on your WhatsApp.
3. **Be the hub hopper.** Tap *Change name / hub*, choose **South Hub**, enter the same seat (no scan needed) and submit. The phone shows **DO NOT ADMIT — HUB HOPPER** and WhatsApp gets **🚨 CRITICAL RE-SCAN DETECTED**.
4. **Ask the bot.** Text `Check 112 F 14` or `Check Section 112 Row F Seat 14`. You get the full profile with both gates in the history.
5. **Breach.** Choose **Hospitality Hub**, the same seat, **Admitted**. You get the critical **UNAUTHORIZED ADMISSION** alert naming the steward.

## 6. Make the access token permanent

The token from step 2 expires after 24 hours. To get one that doesn't:

1. Go to **business.facebook.com → Settings → Users → System users → Add**, with the Admin role.
2. Click **Assign assets**. Give it your app and your WhatsApp account with full control.
3. Click **Generate token**. Pick the app, set expiry to **Never**, and tick `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Paste the new token into `WHATSAPP_ACCESS_TOKEN` on Render. The service redeploys by itself.

## 7. The 24-hour rule (read before event night)

WhatsApp only lets a business send a normal message to someone who has messaged it in the last 24 hours. Outside that window it only accepts pre-approved **templates**. For Gatekeeper this means:

- **Simple fix:** every supervisor texts `Help` to the bot at the start of each shift. Alerts then arrive in full for the next 24 hours.
- **Safety net:** create a template so an alert still arrives if someone forgot.
  1. In **WhatsApp Manager → Message templates**, create a template named `gatekeeper_alert`, category **Utility**, language **English (UK)**, body `Gatekeeper alert: {{1}}`.
  2. Once Meta approves it, set `WHATSAPP_ALERT_TEMPLATE=gatekeeper_alert` on Render.

  When Meta refuses a normal message, the server resends the alert as a one-line template message.

## Group chat

To post into a real WhatsApp **group** instead of individual chats, your WhatsApp Business account needs access to the Cloud API Groups feature. Meta limits which accounts get it. If yours has it:

1. Set `WHATSAPP_GROUP_ID` to the group's ID.
2. If Meta asks for it, also set `WHATSAPP_RECIPIENT_TYPE=group`.

You can keep `WHATSAPP_SUPERVISOR_NUMBERS` as well, so people can text the bot privately. Until then, listing every supervisor's number gives the same live feed, one chat each.

## Before real attendees

- Replace the test number with your venue's own number (WhatsApp Manager → Phone numbers), and complete **Business verification** in Business settings. The test number only reaches the 5 numbers on its list.
- Give each steward the form address and the `STEWARD_API_KEY`. Change the key after the event.
- Render's disk is reset on every deploy, so `offline_incidents.log` survives restarts but not redeploys. Don't deploy during an event.

## Ticketmaster QR codes: what the scan can and can't do

- The scan reads whatever the QR code contains. It uses the phone's built-in barcode reader on Android Chrome (QR, PDF417, Aztec) and a bundled decoder on iPhone and Firefox. The camera needs the https address, which Render provides.
- **SafeTix codes change every few seconds**, so the same person shows a different code at the next gate. That's why the form asks for **section, row and seat**. Gatekeeper matches a new code to an existing record by seat, and the alert says "Matched by seat".
- Codes longer than 64 characters are stored as a short fingerprint (`QR-…`).
- Stewards can log by seat alone when a code won't scan.

## When something doesn't work

| Symptom | Where to look |
|---|---|
| Meta says "Verify and save" failed | The URL must end in `/api/whatsapp/incoming`, with the exact `WHATSAPP_VERIFY_TOKEN`, and the service must be live (`/healthz`). |
| You text the bot and get nothing back | Render → **Logs**. `ignored message from 44…` means that number isn't in `WHATSAPP_SUPERVISOR_NUMBERS`; add it exactly as shown. No log line at all means the **messages** webhook field isn't subscribed. |
| Logs show `Meta 131047` | The 24-hour rule (step 7). Text `Help` to the bot, or set up the template. |
| Logs show `Meta 190` or `HTTP 401` | The access token expired. Do step 6. |
| Logs show `HTTP 401` on inbound webhooks | `WHATSAPP_APP_SECRET` doesn't match the app's secret. |
| The camera won't open | Use the https address, and allow camera access for the site in the phone's browser settings. |
| Server won't start, `[FATAL] Invalid environment configuration` | The log lists exactly which variable is missing. |
