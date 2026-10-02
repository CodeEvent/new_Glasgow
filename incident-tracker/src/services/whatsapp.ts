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

export interface OutboundTemplatePayload {
  messaging_product: 'whatsapp';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components: Array<{ type: 'body'; parameters: Array<{ type: 'text'; text: string }> }>;
  };
}

export interface SendResult {
  ok: boolean;
  mocked: boolean;
  messageId?: string;
  attempts: number;
  error?: string;
  /** True when Meta refused free-form text and the approved template was sent instead. */
  viaTemplate?: boolean;
}

/** WhatsApp caps text bodies at 4096 characters. */
const MAX_BODY = 4096;
const MAX_ATTEMPTS = 4;
const FAILED_ALERTS_LOG = 'failed_whatsapp_alerts.log';

/** Captured outbound messages when MOCK_WHATSAPP_API=true (used by tests and the simulator). */
export type MockMessage = OutboundTextPayload & { priority: MessagePriority; sent_at: string };
export const mockOutbox: MockMessage[] = [];

type MockListener = (msg: MockMessage) => void;
const mockListeners = new Set<MockListener>();

/** Subscribe to mock-mode sends (demo UI live feed). Returns an unsubscribe function. */
export function onMockMessage(listener: MockListener): () => void {
  mockListeners.add(listener);
  return () => mockListeners.delete(listener);
}

export function graphMessagesUrl(): string {
  const cfg = getConfig();
  return `${cfg.WHATSAPP_GRAPH_BASE_URL.replace(/\/+$/, '')}/${cfg.WHATSAPP_API_VERSION}/${cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

/** Everyone an alert goes to: the group (if configured) plus each supervisor number. */
export function alertRecipients(): string[] {
  const cfg = getConfig();
  return [...(cfg.WHATSAPP_GROUP_ID ? [cfg.WHATSAPP_GROUP_ID] : []), ...cfg.WHATSAPP_SUPERVISOR_NUMBERS];
}

export function buildTextPayload(body: string, to = alertRecipients()[0]): OutboundTextPayload {
  const cfg = getConfig();
  const trimmed = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 20)}\n…(truncated)` : body;
  const isGroup = cfg.WHATSAPP_GROUP_ID !== undefined && to === cfg.WHATSAPP_GROUP_ID;
  return {
    messaging_product: 'whatsapp',
    ...(isGroup && cfg.WHATSAPP_RECIPIENT_TYPE ? { recipient_type: cfg.WHATSAPP_RECIPIENT_TYPE } : {}),
    to,
    type: 'text',
    text: { preview_url: false, body: trimmed },
  };
}

/**
 * Template messages may not contain newlines, tabs or formatting runs, and a
 * parameter is capped at 1024 characters, so the alert is flattened to one line.
 */
export function flattenForTemplate(body: string): string {
  const flat = body
    .replace(/[*_~`]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' · ')
    .replace(/\s{2,}/g, ' ');
  return flat.length > 1000 ? `${flat.slice(0, 999)}…` : flat;
}

export function buildTemplatePayload(body: string, to: string): OutboundTemplatePayload {
  const cfg = getConfig();
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: cfg.WHATSAPP_ALERT_TEMPLATE ?? '',
      language: { code: cfg.WHATSAPP_TEMPLATE_LANG },
      components: [{ type: 'body', parameters: [{ type: 'text', text: flattenForTemplate(body) }] }],
    },
  };
}

function isRetryable(err: unknown): boolean {
  const ax = err as AxiosError;
  if (!ax.isAxiosError) return false;
  if (!ax.response) return true; // network error / timeout
  const s = ax.response.status;
  return s === 429 || s >= 500;
}

type MetaErrorBody = { error?: { message?: string; code?: number } };

function metaErrorCode(err: unknown): number | undefined {
  return (err as AxiosError<MetaErrorBody>).response?.data?.error?.code;
}

function describeError(err: unknown): string {
  const ax = err as AxiosError<MetaErrorBody>;
  if (ax.isAxiosError) {
    const metaErr = ax.response?.data?.error;
    return ax.response
      ? `HTTP ${ax.response.status}${metaErr ? ` (Meta ${metaErr.code}: ${metaErr.message})` : ''}`
      : `${ax.code ?? 'NETWORK'}: ${ax.message}`;
  }
  return (err as Error)?.message ?? String(err);
}

/** Meta 131047: free-form text refused because the recipient has not messaged the business in 24 hours. */
const META_REENGAGEMENT_REQUIRED = 131047;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postToGraph(payload: OutboundTextPayload | OutboundTemplatePayload) {
  return axios.post<{ messages?: Array<{ id: string }> }>(graphMessagesUrl(), payload, {
    headers: {
      Authorization: `Bearer ${getConfig().WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 8_000,
  });
}

/**
 * Sends one text message via the Meta Cloud API, with exponential backoff on
 * 429/5xx/network failures and a template fallback outside the 24-hour window.
 * Defaults to the first alert recipient. Never throws.
 */
export async function sendGroupMessage(
  body: string,
  priority: MessagePriority = 'standard',
  to?: string,
): Promise<SendResult> {
  const cfg = getConfig();
  const payload = buildTextPayload(body, to);

  if (cfg.MOCK_WHATSAPP_API) {
    const sent: MockMessage = { ...payload, priority, sent_at: new Date().toISOString() };
    mockOutbox.push(sent);
    for (const l of mockListeners) {
      try {
        l(sent);
      } catch (e) {
        console.error('[whatsapp] mock listener failed:', e);
      }
    }
    if (cfg.NODE_ENV !== 'test' && !cfg.MOCK_WHATSAPP_QUIET) {
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
      const res = await postToGraph(payload);
      return { ok: true, mocked: false, attempts: attempt, messageId: res.data?.messages?.[0]?.id };
    } catch (err) {
      lastError = describeError(err);
      console.error(`[whatsapp] send to ${payload.to} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError}`);

      if (metaErrorCode(err) === META_REENGAGEMENT_REQUIRED) {
        if (!cfg.WHATSAPP_ALERT_TEMPLATE) {
          console.error(
            `[whatsapp] ${payload.to} has not messaged the bot in 24h, so Meta only allows template messages. ` +
              'Ask them to text "Help" to the bot, or set WHATSAPP_ALERT_TEMPLATE to an approved template.',
          );
          break;
        }
        try {
          const res = await postToGraph(buildTemplatePayload(body, payload.to));
          return { ok: true, mocked: false, attempts: attempt, viaTemplate: true, messageId: res.data?.messages?.[0]?.id };
        } catch (tplErr) {
          lastError = `template fallback failed: ${describeError(tplErr)}`;
          console.error(`[whatsapp] ${lastError}`);
          break;
        }
      }

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

/** Sends an alert to every recipient in parallel. Never rejects. */
export async function broadcastAlert(body: string, priority: MessagePriority = 'standard'): Promise<SendResult> {
  const results = await Promise.all(alertRecipients().map((to) => sendGroupMessage(body, priority, to)));
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    mocked: results.every((r) => r.mocked),
    attempts: Math.max(0, ...results.map((r) => r.attempts)),
    error: failed.length ? failed.map((r) => r.error).join('; ') : undefined,
  };
}

/** Fire-and-forget wrapper for request handlers: never blocks the response, never rejects. */
export function dispatchAlert(body: string, priority: MessagePriority = 'standard'): Promise<SendResult> {
  return broadcastAlert(body, priority).catch((err) => {
    console.error('[whatsapp] unexpected dispatch failure:', err);
    return { ok: false, mocked: false, attempts: 0, error: String(err) };
  });
}
