/**
 * Drives a running server through the three stadium scenarios plus a WhatsApp
 * "Check" command. Run the server with MOCK_WHATSAPP_API=true to see the
 * outgoing group messages printed in its console.
 *
 *   npm run simulate                    # against http://localhost:3000
 *   BASE_URL=https://... npm run simulate
 */
import 'dotenv/config';

const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const GROUP = process.env.WHATSAPP_GROUP_ID ?? 'GROUP';
const ticket = `TM-${Math.floor(100000 + Math.random() * 900000)}-X`;

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.STEWARD_API_KEY ? { 'x-api-key': process.env.STEWARD_API_KEY } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function show(step: string, r: { status: number; body: any }) {
  console.log(`\n=== ${step} → HTTP ${r.status}`);
  if (typeof r.body === 'object') {
    console.log(`scenario=${r.body.scenario ?? (r.body.buffered ? 'BUFFERED' : '-')} block_entry=${r.body.screen?.block_entry}`);
    console.log(`screen: ${r.body.screen?.headline} — ${r.body.screen?.message}`);
  } else {
    console.log(r.body);
  }
}

async function main() {
  console.log(`Simulating against ${BASE} with ticket ${ticket}`);

  show('1. West Hub: sent away for 30 min cool-off', await post('/api/scan', {
    ticket_id: ticket, hub_location: 'West Hub', steward_name: 'Supervisor Dave', action_logged: 'cool_off',
    party_size: 4, description: 'Male, 6ft, neon green hat', indicators: ['Slurred speech', 'Stumbling'],
    latitude: 55.8497, longitude: -4.2055,
  }));

  show('2. South Hub: same ticket re-scanned (hub hopper)', await post('/api/scan', {
    ticket_id: ticket, hub_location: 'South Hub', steward_name: 'Steward Sarah', action_logged: 'cool_off',
  }));

  show('3. Hospitality Hub: line steward admits flagged ticket (breach)', await post('/api/scan', {
    ticket_id: ticket, hub_location: 'Hospitality Hub', steward_name: 'Steward John', action_logged: 'admitted',
  }));

  const hook = await post('/api/whatsapp/incoming', {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { messages: [{
      id: `wamid.sim.${Date.now()}`, from: '447700900123', type: 'text', group_id: GROUP, text: { body: `Check ${ticket}` },
    }] } }] }],
  });
  console.log(`\n=== 4. Supervisor types "Check ${ticket}" in WhatsApp → webhook HTTP ${hook.status}`);
  console.log('(The bot reply appears in the server console when MOCK_WHATSAPP_API=true.)');
}

main().catch((err) => {
  console.error('Simulation failed — is the server running?', err.message);
  process.exit(1);
});
