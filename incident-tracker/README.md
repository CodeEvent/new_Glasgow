# 🛡️ Gatekeeper — Proactive Entry Sync Engine

Stops intoxicated patrons "hub-hopping" between the **East**, **West**, **South** and **Hospitality** screening hubs. It connects a steward's phone form, a PostgreSQL (Supabase-compatible) database and the supervisors' WhatsApp group in both directions:

- **Push:** refusals, cool-offs, hub-hop intercepts and unauthorized admissions are posted to the group as they happen.
- **Pull:** a supervisor types `Check TM-847294-X` in the group and gets the ticket's full profile and scan history back.

```
Steward phone (public/index.html) ──POST /api/scan──▶ Express API ──txn──▶ PostgreSQL
                                                         │
                                                         └──▶ Meta Cloud API ──▶ WhatsApp group
WhatsApp group ──"Check X"──▶ POST /api/whatsapp/incoming ──▶ lookup ──▶ reply to group
```

## Quick start

```bash
cd incident-tracker
npm install
cp .env.example .env          # fill in values; keep MOCK_WHATSAPP_API=true for local work
npm run migrate:up            # creates enums, tables, indexes, trigger
npm run dev                   # http://localhost:3000  (steward form at /)
npm run simulate              # in another terminal: runs all 3 scenarios + a "Check" command
```

With `MOCK_WHATSAPP_API=true`, every outgoing group message is printed to the server console instead of being sent to Meta.

Production: `npm run build && npm start`.

## Scan rules (`POST /api/scan`)

Payload:

```json
{
  "ticket_id": "TM-847294-X",
  "hub_location": "West Hub",
  "latitude": 55.8497, "longitude": -4.2055,
  "steward_name": "Supervisor Dave",
  "action_logged": "cool_off",          // cool_off | refused | admitted
  "party_size": 4,                      // optional, default 1
  "description": "Male, 6ft, neon green hat",
  "indicators": ["Slurred speech", "Stumbling"],
  "reasoning": "Combative with line stewards",
  "occurred_at": "2026-10-02T17:45:00Z" // optional; used by queued/offline scans
}
```

Each scan runs in one transaction with the ticket row locked (`SELECT … FOR UPDATE`), so two hubs scanning the same ticket at the same moment are handled one after the other. WhatsApp alerts are sent only **after COMMIT**, so a rolled-back scan never produces a message.

| Situation | Result | `scan_events.action_logged` | Alert |
|---|---|---|---|
| **A** – unknown ticket, `cool_off` / `refused` | Ticket created; `cool_down_until = now + 30 min` for cool-off | `initial_cool_off` / `initial_refusal` | Standard |
| **B** – flagged ticket scanned at a **different hub** than where the incident was logged | Status **unchanged**; steward screen blocked | `bypass_attempt`, `is_breach_event = true` | 🚨 High: "CRITICAL RE-SCAN DETECTED" |
| **C** – flagged ticket marked `admitted` | Status → `admitted` | `unauthorized_admission`, `is_breach_event = true` | 🚨🚨 Critical, names the steward and the gate |
| Cool-off has **expired**, then `admitted` | Status → `admitted` | `cleared_admission` | Standard |
| Same hub re-scans a flagged ticket | The latest call applies (e.g. escalate to refused, restart cool-off) | `repeat_scan` | Standard |
| Unknown ticket, `admitted` | Nothing stored | — | None |

**Precedence:** C is checked before B. If a flagged ticket is admitted at another hub, the person is already inside, so it's logged as a breach rather than an attempt.

The response includes a `screen` object (`level`, `block_entry`, `headline`, `message`) that the form shows full-screen.

`GET /api/tickets/:id` is a read-only pre-check. The form calls it as soon as a QR code is read, so the steward sees the warning before submitting.

## WhatsApp

**Outbound** (`src/services/whatsapp.ts`): `POST https://graph.facebook.com/{WHATSAPP_API_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages` with `Authorization: Bearer $WHATSAPP_ACCESS_TOKEN` and the standard `messaging_product / to / type / text` body. Failed sends are retried with exponential backoff on 429, 5xx and network errors. Messages that still fail are written to `failed_whatsapp_alerts.log`.

**Inbound** (`src/routes/whatsappWebhook.ts`):

- `GET /api/whatsapp/incoming` handles Meta's verification handshake. It returns `hub.challenge` as `text/plain` with HTTP 200 when `hub.verify_token` matches.
- `POST /api/whatsapp/incoming` replies 200 straight away, then:
  - ignores anything not from `WHATSAPP_GROUP_ID`;
  - skips Meta's retried deliveries, so each message is answered once;
  - parses `Check <ID>` (case-insensitive, spaces inside the ID are stripped) and `Help`;
  - replies with the ticket profile and scan history, or `❌ *No Database Record Extracted for Ticket ID:* …`.
- Set `WHATSAPP_APP_SECRET` to require a valid `X-Hub-Signature-256` on every inbound call. Without it, anyone who finds the URL can post fake messages, so set it in production.

Meta setup: in your Meta app, add the WhatsApp product. Set the callback URL to `https://<host>/api/whatsapp/incoming` and the verify token to `WHATSAPP_VERIFY_TOKEN`, then subscribe to the `messages` field. Group messaging uses the Cloud API Groups feature. If your account requires `recipient_type: "group"`, set `WHATSAPP_RECIPIENT_TYPE=group`.

## Resilience

- **Server offline buffer.** If PostgreSQL is unreachable (connection-class errors only), the scan is appended as one JSON line to `offline_incidents.log` and the steward gets HTTP 202. An "⚠️ DATABASE OFFLINE" notice still goes to WhatsApp so supervisors keep seeing the live feed.
- **Automatic re-sync.** A watchdog checks every 15 s. Once the database answers, it replays the log in original scan order, using the original timestamps, so cool-off windows stay correct. Replayed alerts are marked "⏪ DELAYED SYNC".
  - The log is renamed before replay, so scans arriving during a sync are never lost.
  - Synced entries are archived to `offline_incidents.synced.log`.
  - Invalid entries go to `offline_incidents.rejected.log`.
  - Manual replay: `npm run resync` (add `-- --no-alerts` to replay without sending messages).
- **Device queue.** If the phone has no signal, the form saves the submission on the phone and sends it automatically when signal returns. It keeps the original scan time.
- **Startup checks.** The server exits with code 1 and lists every problem if `DATABASE_URL`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GROUP_ID` or `WHATSAPP_VERIFY_TOKEN` is missing or blank.
- **Health endpoints.** `GET /healthz` (liveness). `GET /readyz` (database status and whether an offline backlog exists).
- **Steward auth.** Set `STEWARD_API_KEY` and the form/API require it as `x-api-key`. The Meta webhook is never behind this key.

## Database

`migrations/001_init_incident_schema.{up,down}.sql` contains the schema you specified, plus:

- constraints: allowed `action_logged` values, breach flag must match the action, cool-off requires a deadline, lat/long ranges;
- a covering `(ticket_id, timestamp)` index for origin-hub lookups;
- a partial index for the breach feed and one for active cool-offs;
- an `updated_at` trigger.

Run `npm run migrate:up` / `npm run migrate:down`, or paste the `.up.sql` into the Supabase SQL editor. For Supabase, set `DATABASE_SSL=true`.

## Tests

```bash
TEST_DATABASE_URL=postgres://postgres@localhost:5432/gatekeeper_test npm test
```

Unit tests always run. Integration tests run against a real PostgreSQL when `TEST_DATABASE_URL` is set; that database is truncated. They cover:

- scenarios A, B and C, and cleared admission;
- two hubs scanning the same ticket at once;
- the bot replies, the webhook handshake and signature check;
- steward auth;
- a full database outage → offline log → re-sync round trip.

## Operational notes

- **Ticketmaster SafeTix:** SafeTix barcodes **rotate every few seconds** (they're time-based codes), so the raw QR string from a phone screen is not a stable ticket key. The same person would look like a new ticket at the next hub, and hub-hop detection would silently fail. Before rollout, confirm what your scanners actually read. Use a stable value: the printed ticket/order number, or the static part of the barcode your ticketing team can identify. `ticket_id` is capped at 64 characters by the schema.
- Supervisors receive descriptions of individuals. Agree a retention period and purge old `tickets` rows after each event (deleting a ticket cascades to its `scan_events`).
