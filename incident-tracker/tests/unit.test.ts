import { describe, expect, it } from 'vitest';
import { loadConfig, EnvValidationError } from '../src/config/env';
import { parseCommand } from '../src/services/commandParser';
import { buildTextPayload, flattenForTemplate, graphMessagesUrl } from '../src/services/whatsapp';
import { extractTextMessages, isFromDesignatedGroup } from '../src/routes/whatsappWebhook';

describe('environment validation', () => {
  it('lists every missing required variable', () => {
    try {
      loadConfig({ WHATSAPP_GROUP_ID: 'x' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const msg = (err as Error).message;
      for (const k of ['DATABASE_URL', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN']) {
        expect(msg).toContain(`${k} is required`);
      }
      expect(msg).not.toContain('WHATSAPP_GROUP_ID');
    }
  });

  it('needs a group or supervisor numbers as the alert destination', () => {
    const base = { DATABASE_URL: 'x', WHATSAPP_ACCESS_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: 'b', WHATSAPP_VERIFY_TOKEN: 'd' };
    expect(() => loadConfig(base)).toThrow(/WHATSAPP_SUPERVISOR_NUMBERS/);
    const cfg = loadConfig({ ...base, WHATSAPP_SUPERVISOR_NUMBERS: '+44 7700 900123, 447700900456' });
    expect(cfg.WHATSAPP_SUPERVISOR_NUMBERS).toEqual(['447700900123', '447700900456']);
    expect(cfg.WHATSAPP_GROUP_ID).toBeUndefined();
    loadConfig(); // restore test config
  });

  it('treats blank values as missing and parses the mock flag', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: '  ', WHATSAPP_ACCESS_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: 'b', WHATSAPP_GROUP_ID: 'c', WHATSAPP_VERIFY_TOKEN: 'd' }),
    ).toThrow(/DATABASE_URL/);
    const cfg = loadConfig({ ...process.env, MOCK_WHATSAPP_API: 'TRUE' });
    expect(cfg.MOCK_WHATSAPP_API).toBe(true);
  });
});

describe('command parser', () => {
  it.each([
    ['Check TM-847294-X', 'TM-847294-X'],
    ['check tm-847294-x', 'tm-847294-x'],
    ['  CHECK:  TM 847294 X  ', 'TM847294X'],
    ['Check #ABC123', 'ABC123'],
  ])('%s -> %s', (text, id) => {
    expect(parseCommand(text)).toEqual({ kind: 'check', ticketId: id });
  });

  it.each([
    ['Check Section 112 Row F Seat 14', '112', 'F', '14'],
    ['check sec 112, row f, seat 14', '112', 'f', '14'],
    ['CHECK Block H2 Row K Seat 7', 'H2', 'K', '7'],
    ['Check 112 F 14', '112', 'F', '14'],
    ['check 112/F/14', '112', 'F', '14'],
  ])('%s -> seat %s/%s/%s', (text, section, row, seat) => {
    expect(parseCommand(text)).toMatchObject({ kind: 'check_seat', section, row, seat });
  });

  it('keeps dashed and long codes as ticket IDs', () => {
    expect(parseCommand('Check TM-847294-X')).toEqual({ kind: 'check', ticketId: 'TM-847294-X' });
    expect(parseCommand('CHECK TM 847294 X')).toEqual({ kind: 'check', ticketId: 'TM847294X' });
  });

  it('flattens alerts for WhatsApp templates', () => {
    expect(flattenForTemplate('🚨 *ALERT*\n\n_Ticket_ X\n  Seat 14  ')).toBe('🚨 ALERT · Ticket X · Seat 14');
  });

  it('ignores ordinary chat and flags empty checks', () => {
    expect(parseCommand('checking the south gate now')).toBeNull();
    expect(parseCommand('Can someone check TM-1?')).toBeNull();
    expect(parseCommand('Check')).toMatchObject({ kind: 'invalid_check' });
    expect(parseCommand('help')).toEqual({ kind: 'help' });
  });
});

describe('outbound payload', () => {
  it('matches the Meta Cloud API text message contract', () => {
    expect(graphMessagesUrl()).toBe('https://graph.facebook.com/v25.0/1234567890/messages');
    expect(buildTextPayload('hello')).toEqual({
      messaging_product: 'whatsapp',
      to: 'GROUP-SUPERVISORS',
      type: 'text',
      text: { preview_url: false, body: 'hello' },
    });
    expect(buildTextPayload('x'.repeat(5000)).text.body.length).toBeLessThanOrEqual(4096);
  });
});

describe('inbound payload extraction', () => {
  const body = (groupId?: string, from = '447700900000') => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.1', from, type: 'text', group_id: groupId, text: { body: 'Check A1' } }] } }] }],
  });

  it('only accepts the designated group', () => {
    const [ok] = extractTextMessages(body('GROUP-SUPERVISORS'));
    expect(isFromDesignatedGroup(ok)).toBe(true);
    const [other] = extractTextMessages(body('SOME-OTHER-GROUP'));
    expect(isFromDesignatedGroup(other)).toBe(false);
    const [direct] = extractTextMessages(body(undefined));
    expect(isFromDesignatedGroup(direct)).toBe(false);
  });

  it('survives junk payloads', () => {
    expect(extractTextMessages(null)).toEqual([]);
    expect(extractTextMessages({ entry: 'nope' })).toEqual([]);
    expect(extractTextMessages({ entry: [{ changes: [{ value: { statuses: [] } }] }] })).toEqual([]);
  });
});
