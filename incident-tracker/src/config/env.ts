import { z } from 'zod';

export const REQUIRED_ENV_VARS = ['DATABASE_URL'] as const;

/**
 * The official WhatsApp Cloud API is optional (it needs a Meta business account).
 * If any of these is set, all of them are required, plus an alert destination
 * (WHATSAPP_GROUP_ID and/or WHATSAPP_SUPERVISOR_NUMBERS).
 */
export const CLOUD_API_VARS = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN'] as const;

const boolFlag = z
  .string()
  .optional()
  .transform((v) => ['true', '1', 'yes'].includes((v ?? '').trim().toLowerCase()));

const nonBlank = z.string().trim().min(1);

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** "+44 7700 900123, 447700900456" -> ["447700900123", "447700900456"] (Meta's wa_id format). */
const phoneList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(/[,;\n]+/)
      .map((n) => n.replace(/\D/g, ''))
      .filter((n) => n.length >= 7),
  );

const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());
// On unless set to false/0/no/off.
const onByDefault = z
  .string()
  .optional()
  .transform((v) => !['false', '0', 'no', 'off'].includes((v ?? '').trim().toLowerCase()));

const envObject = z.object({
  DATABASE_URL: nonBlank,

  // ---- Official WhatsApp Cloud API (optional) ----
  WHATSAPP_ACCESS_TOKEN: optionalText,
  WHATSAPP_PHONE_NUMBER_ID: optionalText,
  WHATSAPP_VERIFY_TOKEN: optionalText,
  // Alert destinations: a WhatsApp group (Cloud API Groups) and/or individual supervisor numbers.
  WHATSAPP_GROUP_ID: z.preprocess(blankToUndefined, z.string().trim().optional()),
  WHATSAPP_SUPERVISOR_NUMBERS: phoneList,
  // Approved template used when Meta refuses free-form text (recipient silent for 24h+). Body must have one {{1}}.
  WHATSAPP_ALERT_TEMPLATE: z.preprocess(blankToUndefined, z.string().trim().optional()),
  WHATSAPP_TEMPLATE_LANG: z.string().trim().default('en_GB'),

  // ---- Linked-device group bot (a spare WhatsApp number that sits in your work group) ----
  WA_LINKED_ENABLED: boolFlag,
  // Also post refusal / hub-hop / breach alerts into the selected groups (off = answer checks only).
  WA_LINKED_POST_ALERTS: boolFlag,
  // Group bot extras (each can be switched off with "off"):
  // post 🚨 when someone tries a second hub, and 🟡 when a sent-away person may come back.
  WA_HUBHOP_ALERTS: onByDefault,
  WA_READMIT_REMINDERS: onByDefault,
  // CLEAR and REPORT only for WhatsApp admins of a selected group ("off" = anyone in the group).
  WA_SUPERVISOR_ONLY: onByDefault,
  // Private messages to group admins: the CSV at SUMMARY_TIME, and "online" / battery alerts.
  WA_NIGHTLY_BACKUP: onByDefault,
  WA_HEALTH_ALERTS: onByDefault,
  // Optional AI helper (plain-English questions and logs). Off unless a key is set.
  ANTHROPIC_API_KEY: optionalText,
  AI_MODEL: z.string().trim().default('claude-opus-5-5'),
  // Most AI messages per day for everyone together (keeps the bill predictable).
  AI_DAILY_LIMIT: z.coerce.number().int().min(0).default(200),
  // End-of-night summary posted to the groups at this time (HH:MM, TZ_DISPLAY), or "off".
  SUMMARY_TIME: z
    .string()
    .trim()
    .default('23:30')
    .refine((v) => /^off$/i.test(v) || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'SUMMARY_TIME must be HH:MM (e.g. 23:30) or off'),
  // Protects /admin (linking the phone, choosing groups). Required when WA_LINKED_ENABLED.
  ADMIN_API_KEY: optionalText,

  // Optional tuning / hardening.
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().default('development'),
  MOCK_WHATSAPP_API: boolFlag,
  // Suppress the console box print in mock mode (the demo UI shows messages instead).
  MOCK_WHATSAPP_QUIET: boolFlag,
  WHATSAPP_API_VERSION: z.string().trim().default('v25.0'),
  WHATSAPP_GRAPH_BASE_URL: z.string().trim().default('https://graph.facebook.com'),
  // Set to "group" if your Cloud API account uses the Groups API recipient model.
  WHATSAPP_RECIPIENT_TYPE: z.string().trim().optional(),
  // When set, inbound webhooks must carry a valid X-Hub-Signature-256.
  WHATSAPP_APP_SECRET: z.string().trim().optional(),
  DATABASE_SSL: boolFlag,
  OFFLINE_LOG_PATH: z.string().trim().default('offline_incidents.log'),
  COOL_OFF_MINUTES: z.coerce.number().int().positive().default(30),
  // Records (and photos) untouched for this long are deleted automatically.
  RETENTION_HOURS: z.coerce.number().int().positive().default(24),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  OFFLINE_SYNC_INTERVAL_MS: z.coerce.number().int().min(500).default(15_000),
  TZ_DISPLAY: z.string().trim().default('Europe/London'),
});

const envSchema = envObject.superRefine((v, ctx) => {
  const cloudSet = CLOUD_API_VARS.filter((k) => v[k]);
  if (cloudSet.length > 0) {
    for (const k of CLOUD_API_VARS) {
      if (!v[k]) ctx.addIssue({ code: 'custom', path: [k], message: `required when the WhatsApp Cloud API is configured (${cloudSet.join(', ')} set)` });
    }
    if (!v.WHATSAPP_GROUP_ID && v.WHATSAPP_SUPERVISOR_NUMBERS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_GROUP_ID'],
        message: 'set WHATSAPP_GROUP_ID and/or WHATSAPP_SUPERVISOR_NUMBERS so Cloud API alerts have somewhere to go',
      });
    }
  }
  if (v.WA_LINKED_ENABLED && !v.ADMIN_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['ADMIN_API_KEY'], message: 'required when WA_LINKED_ENABLED=true (it protects the phone-linking page)' });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

/** True when the official Meta WhatsApp Cloud API is configured. */
export function cloudApiEnabled(cfg: AppConfig = getConfig()): boolean {
  return Boolean(cfg.WHATSAPP_ACCESS_TOKEN && cfg.WHATSAPP_PHONE_NUMBER_ID && cfg.WHATSAPP_VERIFY_TOKEN);
}

let cached: AppConfig | null = null;

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Parses process.env. Throws EnvValidationError listing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => {
      const key = i.path.join('.');
      const missing = (REQUIRED_ENV_VARS as readonly string[]).includes(key) && !env[key]?.trim();
      return missing ? `${key} is required but missing` : `${key}: ${i.message}`;
    });
    throw new EnvValidationError(problems);
  }
  cached = result.data;
  return cached;
}

export function getConfig(): AppConfig {
  return cached ?? loadConfig();
}

/** Test hook: forget the cached config so the next getConfig() re-reads process.env. */
export function resetConfigCache(): void {
  cached = null;
}

/** Startup gate: validate or terminate the process with a non-zero exit code. */
export function validateEnvOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[FATAL] ${(err as Error).message}`);
    console.error('[FATAL] Refusing to start. Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
}
