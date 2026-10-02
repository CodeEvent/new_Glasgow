import fs from 'fs';
import path from 'path';
import axios, { AxiosError } from 'axios';
import { getConfig } from '../config/env';

export type MessagePriority = 'standard' | 'high' | 'critical';

export interface OutboundTextPayload {
  messaging_product: 'whatsapp';
  recipient_type?: string;
  to: string;
  type: 'text';
  text: { preview_url: false; body: string };
}

export interface SendResult {
  ok: boolean;
  mocked: boolean;
  messageId?: string;
  attempts: number;
  error?: string;
}

/** WhatsApp caps text bodies at 4096 characters. */
const MAX_BODY = 4096;
const MAX_ATTEMPTS = 4;
const FAILED_ALERTS_LOG = 'failed_whatsapp_alerts.log';

/** Captured outbound messages when MOCK_WHATSAPP_API=true (used by tests and the simulator). */
export const mockOutbox: Array<OutboundTextPayload & { priority: MessagePriority; sent_at: string }> = [];

export function graphMessagesUrl(): string {
  const cfg = getConfig();
  return `${cfg.WHATSAPP_GRAPH_BASE_URL.replace(/\/+$/, '')}/${cfg.WHATSAPP_API_VERSION}/${cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

export function buildTextPayload(body: string, to = getConfig().WHATSAPP_GROUP_ID): OutboundTextPayload {
  const cfg = getConfig();
  const trimmed = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 20)}\n…(truncated)` : body;
  return {
    messaging_product: 'whatsapp',
    ...(cfg.WHATSAPP_RECIPIENT_TYPE ? { recipient_type: cfg.WHATSAPP_RECIPIENT_TYPE } : {}),
    to,
    type: 'text',
    text: { preview_url: false, body: trimmed },
  };
}

function isRetryable(err: unknown): boolean {
  const ax = err as AxiosError;
  if (!ax.isAxiosError) return false;
  if (!ax.response) return true; // network error / timeout
  const s = ax.response.status;
  return s === 429 || s >= 500;
}

function describeError(err: unknown): string {
  const ax = err as AxiosError<{ error?: { message?: string; code?: number } }>;
  if (ax.isAxiosError) {
    const metaErr = ax.response?.data?.error;
    return ax.response
      ? `HTTP ${ax.response.status}${metaErr ? ` (Meta ${metaErr.code}: ${metaErr.message})` : ''}`
      : `${ax.code ?? 'NETWORK'}: ${ax.message}`;
  }
  return (err as Error)?.message ?? String(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a text message to the supervisors' group via the Meta Cloud API, with
 * exponential backoff on 429/5xx/network failures. Never throws.
 */
export async function sendGroupMessage(
  body: string,
  priority: MessagePriority = 'standard',
  to?: string,
): Promise<SendResult> {
  const cfg = getConfig();
  const payload = buildTextPayload(body, to);

  if (cfg.MOCK_WHATSAPP_API) {
    mockOutbox.push({ ...payload, priority, sent_at: new Date().toISOString() });
    if (cfg.NODE_ENV !== 'test') {
      const bar = '─'.repeat(60);
      console.log(`\n┌${bar}\n│ [MOCK WHATSAPP] priority=${priority.toUpperCase()} to=${payload.to}\n├${bar}`);
      for (const line of payload.text.body.split('\n')) console.log(`│ ${line}`);
      console.log(`└${bar}\n`);
    }
    return { ok: true, mocked: true, attempts: 0 };
  }

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post<{ messages?: Array<{ id: string }> }>(graphMessagesUrl(), payload, {
        headers: {
          Authorization: `Bearer ${cfg.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 8_000,
      });
      return { ok: true, mocked: false, attempts: attempt, messageId: res.data?.messages?.[0]?.id };
    } catch (err) {
      lastError = describeError(err);
      console.error(`[whatsapp] send attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError}`);
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
      // Critical alerts retry faster.
      const base = priority === 'critical' ? 250 : 500;
      await sleep(base * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
    }
  }

  // Dead-letter so no alert silently disappears.
  try {
    fs.appendFileSync(
      path.resolve(FAILED_ALERTS_LOG),
      JSON.stringify({ failed_at: new Date().toISOString(), priority, error: lastError, payload }) + '\n',
    );
  } catch (e) {
    console.error('[whatsapp] could not write dead-letter log:', (e as Error).message);
  }
  return { ok: false, mocked: false, attempts: MAX_ATTEMPTS, error: lastError };
}

/** Fire-and-forget wrapper for request handlers: never blocks the response, never rejects. */
export function dispatchAlert(body: string, priority: MessagePriority = 'standard'): Promise<SendResult> {
  return sendGroupMessage(body, priority).catch((err) => {
    console.error('[whatsapp] unexpected dispatch failure:', err);
    return { ok: false, mocked: false, attempts: 0, error: String(err) };
  });
}
