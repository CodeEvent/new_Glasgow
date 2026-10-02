import { z } from 'zod';

export const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_GROUP_ID',
  'WHATSAPP_VERIFY_TOKEN',
] as const;

const boolFlag = z
  .string()
  .optional()
  .transform((v) => ['true', '1', 'yes'].includes((v ?? '').trim().toLowerCase()));

const nonBlank = z.string().trim().min(1);

const envSchema = z.object({
  DATABASE_URL: nonBlank,
  WHATSAPP_ACCESS_TOKEN: nonBlank,
  WHATSAPP_PHONE_NUMBER_ID: nonBlank,
  WHATSAPP_GROUP_ID: nonBlank,
  WHATSAPP_VERIFY_TOKEN: nonBlank,

  // Optional tuning / hardening.
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().default('development'),
  MOCK_WHATSAPP_API: boolFlag,
  WHATSAPP_API_VERSION: z.string().trim().default('v21.0'),
  WHATSAPP_GRAPH_BASE_URL: z.string().trim().default('https://graph.facebook.com'),
  // Set to "group" if your Cloud API account uses the Groups API recipient model.
  WHATSAPP_RECIPIENT_TYPE: z.string().trim().optional(),
  // When set, inbound webhooks must carry a valid X-Hub-Signature-256.
  WHATSAPP_APP_SECRET: z.string().trim().optional(),
  DATABASE_SSL: boolFlag,
  OFFLINE_LOG_PATH: z.string().trim().default('offline_incidents.log'),
  COOL_OFF_MINUTES: z.coerce.number().int().positive().default(30),
  TZ_DISPLAY: z.string().trim().default('Europe/London'),
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
