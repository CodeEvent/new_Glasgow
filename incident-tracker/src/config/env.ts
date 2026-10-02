import { z } from 'zod';

export const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
] as const;
// Plus at least one destination for alerts: WHATSAPP_GROUP_ID and/or WHATSAPP_SUPERVISOR_NUMBERS.

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

const envObject = z.object({
  DATABASE_URL: nonBlank,
  WHATSAPP_ACCESS_TOKEN: nonBlank,
  WHATSAPP_PHONE_NUMBER_ID: nonBlank,
  WHATSAPP_VERIFY_TOKEN: nonBlank,
  // Alert destinations: a WhatsApp group (Cloud API Groups) and/or individual supervisor numbers.
  WHATSAPP_GROUP_ID: z.preprocess(blankToUndefined, z.string().trim().optional()),
  WHATSAPP_SUPERVISOR_NUMBERS: phoneList,
  // Approved template used when Meta refuses free-form text (recipient silent for 24h+). Body must have one {{1}}.
  WHATSAPP_ALERT_TEMPLATE: z.preprocess(blankToUndefined, z.string().trim().optional()),
  WHATSAPP_TEMPLATE_LANG: z.string().trim().default('en_GB'),

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
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  OFFLINE_SYNC_INTERVAL_MS: z.coerce.number().int().min(500).default(15_000),
  TZ_DISPLAY: z.string().trim().default('Europe/London'),
});

const envSchema = envObject.superRefine((v, ctx) => {
  if (!v.WHATSAPP_GROUP_ID && v.WHATSAPP_SUPERVISOR_NUMBERS.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['WHATSAPP_GROUP_ID'],
      message: 'set WHATSAPP_GROUP_ID and/or WHATSAPP_SUPERVISOR_NUMBERS so alerts have somewhere to go',
    });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

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
