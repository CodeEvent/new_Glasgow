# Handoff: Gatekeeper WhatsApp group bot

Read this first if you're picking up the work in a new Claude Code session.

## Current state (latest)

The **simple WhatsApp-only flow is built and tested** (58 tests pass). It hasn't been run against real WhatsApp yet: the build sandbox blocks web.whatsapp.com.

**How it works** (`src/services/stewardBot.ts`, class `StewardBot`, wired into `src/channels/linkedWhatsApp.ts`):
- **Log:** a steward sends a photo, of the Ticketmaster QR (decoded by `src/services/qrImage.ts`: jimp + jsQR; long payloads stored as `QR-<sha256>`) or of the customer (stored in `ticket_photos`), and/or text such as `REFUSED BB 212 100 West green hat, very drunk` or `30 BB 212 100 West`.
  - Missing decision, seat, hub or reason is asked for, one question at a time.
  - The time is the message time, and each steward's hub is remembered for 12 hours.
  - Saving goes through the existing `processScan`, so hub-hop detection works: a log at a second hub replies "🚨 ALREADY …".
- **Check:** `BB 212 100` returns `formatQuickCheck` output plus the latest photo.
- `UNDO` removes your last new record (within 15 min), `CANCEL` drops a half-finished log, and `HELP` shows the commands.
- **Where:** the groups ticked on `/admin/whatsapp`, plus private chats from members of those groups. Ordinary chat and photos without a QR or caption are ignored.
- **Retention:** `src/services/retention.ts` deletes tickets untouched for `RETENTION_HOURS` (default 24) every 15 minutes, which cascades to events and photos. It's started in `server.ts`.
- **Migration `004_ticket_photos`:** photos table plus an index on `tickets.updated_at`.
- **Tests:** `tests/stewardBot.test.ts` (parsing, QR decode, full conversation flows, hub-hop, undo, retention), `tests/linkedWhatsApp.test.ts` (routing with a fake WhatsApp socket, photo download mocked) and `tests/pgAuthState.test.ts` (session round-trip with real Baileys `BufferJSON`).
- **Docs:** `WHATSAPP_GROUP_BOT.md` is the owner's setup guide. `render.yaml` defaults to the group bot (`WA_LINKED_ENABLED=true`, `ADMIN_API_KEY` generated, one instance).
- **Demo:** the chat pane now runs `StewardBot` (text only; jimp is stubbed in the browser build). Hosted demo: https://claude.ai/artifact/CZtyogYLfedr13bK7q2xpF

**Next:** deploy (Supabase plus a Render blueprint), link the spare phone at `/admin/whatsapp`, tick the work group, and test in the real group. Watch Render logs for `[linked-wa]` lines.

**Known limits:**
- Ticketmaster SafeTix QR codes rotate, so matching across gates relies on the seat.
- The linked-device approach is unofficial, and the spare number could be banned.
- Half-finished conversations and remembered hubs live in memory and are lost on restart.

---

## Earlier notes


Read this first if you're picking up the work in a new Claude Code session.

## The goal

Stewards type a seat into the **existing work WhatsApp group**, e.g. `BB 212 100` (section, row, seat). Gatekeeper replies in the group with whether that person was refused or is cooling off.

The owner has **no registered business**, so Meta's official WhatsApp Cloud API can't be verified. Their test account was also locked (error 131031). The chosen approach is a **spare phone number linked as a WhatsApp "linked device"** using the Baileys library, added to the work group like a colleague.

The owner accepted the risk: this is unofficial, WhatsApp's terms don't allow it, and the spare number could be banned. The official Cloud API code stays in place as an optional alternative.

## Done (committed, typechecks, 38 tests pass)

- `migrations/003_linked_whatsapp.*.sql`: `wa_session` (Baileys session keys) and `app_settings` (selected groups).
- `src/config/env.ts`:
  - only `DATABASE_URL` is required now;
  - the Cloud API vars are all-or-nothing;
  - new `WA_LINKED_ENABLED`, `WA_LINKED_POST_ALERTS` and `ADMIN_API_KEY` (required when the group bot is on);
  - `cloudApiEnabled()` helper.
- `src/services/whatsapp.ts`:
  - Cloud API sends are skipped when it isn't configured;
  - `registerAlertSink()`, so other channels receive alerts too.
- `src/services/commandParser.ts`: `parseGroupMessage()` accepts bare seats (`BB 212 100`, `BB/212/100`, `Section BB Row 212 Seat 100`) and ignores normal chat. A message counts as a seat only if it has three parts, the last is a number, and either two parts contain digits or the letters are capitals.
- `src/services/quickCheck.ts`: `formatQuickCheck()` gives the short group reply (🔴 REFUSED / 🟠 COOLING OFF / 🟡 COOL-OFF ENDED / 🟢 ADMITTED / ✅ NOT REFUSED).
- `src/channels/baileys.ts`: loads ESM-only Baileys v7 from this CommonJS app.
- `src/channels/pgAuthState.ts`: Baileys session stored in Postgres, so the link survives Render redeploys; settings helpers.
- `src/channels/linkedWhatsApp.ts`: the bot.
  - Connects, reconnects, and handles unlink and "replaced by another instance" (the old instance stands down during a deploy).
  - Reads only the selected groups, ignores backlog older than 2 minutes, replies quoting the steward's message, and paces replies per group.
  - Admin actions: pairing code, list groups, choose groups, test message, logout.
- `src/routes/admin.ts` + `src/middleware/adminAuth.ts`: `/admin/whatsapp` page route and JSON API under `/admin/api/whatsapp/*` (`status` with QR as data URL, `pair`, `groups` GET/POST, `test`, `logout`), protected by header `x-admin-key`.
- `src/server.ts`: starts the bot when `WA_LINKED_ENABLED=true`.

## Update (later session)

- `public/admin-whatsapp.html` now exists: admin key, live status, QR or pairing code, group picker, test message, unlink. It loads and the admin key check works. It was not tested against real WhatsApp, because the build sandbox's network blocks web.whatsapp.com.
- `linkedWhatsApp.ts` now logs every connection close with its code and reason (`[linked-wa] connection closed (code …)`).
- **Direction change pending:** the owner wants the simplest possible WhatsApp-only flow.
  - Stewards log a person by sending a photo with a caption like `REFUSED BB 212 100` or `30 BB 212 100`.
  - Anyone checks a person by sending the seat.
  - Waiting on the owner's answers to five questions: group or private chat, caption vs step-by-step logging, optional gate, retention (suggested 24 h auto-delete), free-text notes.

## Still to do (original list; item 1 is done)

1. ~~**`public/admin-whatsapp.html`**~~ Done, see above. Original spec: A mobile-friendly setup page:
   - field for the admin key (keep it in `sessionStorage`), sent as `x-admin-key`;
   - poll `GET /admin/api/whatsapp/status` every 3 s and show the status;
   - while `waiting_for_link`, show the QR (`qr` is a data URL), with instructions: on the spare phone, WhatsApp → Settings → Linked devices → Link a device;
   - alternative: phone-number field → `POST /pair` shows the 8-character code, with instructions "Link with phone number instead";
   - when `connected`: show the number, list groups from `GET /groups` with checkboxes, save with `POST /groups {groups:[{jid,subject}]}`, a "Send test" button per selected group (`POST /test {jid}`), and an "Unlink" button (`POST /logout`).
2. **Tests:**
   - `parseGroupMessage`: `BB 212 100`, `bb 212 100`, `A F 14` match; `see you 10`, `back in 5`, `Gate A 12` don't;
   - `formatQuickCheck`: each status, plus not found;
   - `answerGroupMessage` against the test DB;
   - `messageText` unwrapping of ephemeral and extended text messages;
   - `usePostgresAuthState` round-trip with Buffers (use `BufferJSON` from Baileys);
   - the `003` migration up/down.
3. **Docs:**
   - a `WHATSAPP_GROUP_BOT.md` setup guide: Supabase, Render with `WA_LINKED_ENABLED=true` and `ADMIN_API_KEY`, put WhatsApp on the spare SIM and add it to the work group, open `/admin/whatsapp`, link, pick the group, send a test, then try `BB 212 100`;
   - ban-risk tips: use the number normally for a few days first, one group only, keep `WA_LINKED_POST_ALERTS` off at first, keep the spare phone charged (linked devices drop after about 14 days without the phone online), and tell colleagues a bot is in the group;
   - update `render.yaml` (add `WA_LINKED_ENABLED`, `ADMIN_API_KEY` with `generateValue`; make the Cloud API vars optional), `.env.example`, the README and `GO_LIVE.md` (point no-business users to the group bot).
4. **Demo** (`demo/ui.html`, `src/demo/engine.ts`): make the chat pane behave like the work group, with bare-seat messages answered via `answerGroupMessage`. Rebuild with `npm run demo:web`.
5. Optional: let stewards **log** refusals from the group too (e.g. `REFUSED BB 212 100 green hat`). Today refusals are logged on the web steward form at `/`.

## Running locally

```bash
cd incident-tracker
npm install
npm run demo                       # control room at http://localhost:3000/demo (embedded Postgres, mock WhatsApp)
TEST_DATABASE_URL=postgres://user@localhost:5432/gatekeeper_test npm test   # needs a local Postgres
```

To try the real group bot locally, set `DATABASE_URL`, `WA_LINKED_ENABLED=true` and `ADMIN_API_KEY=something` in `.env`, run `npm run migrate:up && npm run dev`, and open `http://localhost:3000/admin/whatsapp` (once the page exists).
