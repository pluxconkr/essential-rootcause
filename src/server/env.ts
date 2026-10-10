/**
 * Server environment (plan Appendix C, §3.10, §12). Reads the server-only variables of .env.example. The two Supabase
 * values are required: `getServerEnv()` throws a typed ConfigError when they are missing so every route fails closed
 * with 503 instead of silently falling back (§3.10 "no silent memory fallback outside tests"). Values are never
 * logged — only the names of the missing ones travel in the error. Server-only module: imported from src/app/api/**.
 */

export class ConfigError extends Error {
  readonly code = 'misconfigured' as const;
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Server is not configured: missing ${missing.join(', ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

export interface ServerEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  anthropicApiKey: string | null;
  visionModel: string;
  visionEnabled: boolean;
  visionDailyMax: number;
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioMessagingServiceSid: string | null;
  twilioVerifyServiceSid: string | null;
  twilioWebhookUrl: string | null;
  smsEnabled: boolean;
  /** SMS_ALLOWLIST: E.164 numbers that may receive texts while the list is non-empty (preview testers, plan §23.H); empty = everyone. */
  smsAllowlist: readonly string[];
  resendApiKey: string | null;
  staffEmailFrom: string | null;
  jobSecret: string | null;
  open311ApiKeys: readonly string[];
  nwsUserAgent: string;
  sentryDsnServer: string | null;
  expoAccessToken: string | null;
}

export const ENV_DEFAULTS = {
  visionModel: 'claude-haiku-4-5', // spec: plan §3.6 model `claude-haiku-4-5` (env VISION_MODEL)
  visionEnabled: true, // spec: plan §3.6 behind a flag
  visionDailyMax: 500, // spec: plan §3.6 VISION_DAILY_MAX default 500/day
  smsEnabled: false, // spec: .env.example SMS_ENABLED=false until 10DLC approval (plan §3.12)
  nwsUserAgent: 'RootCause/1.0 (rootcause; contact: contact@example.org)', // spec: plan §2 NWS client with required User-Agent
} as const;

function str(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  const t = str(v)?.toLowerCase();
  if (t === null || t === undefined) return fallback;
  return t === 'true' || t === '1' || t === 'on' || t === 'yes';
}

function int(v: string | undefined, fallback: number): number {
  const t = str(v);
  if (t === null) return fallback; // Number(null) is 0, which would silently turn an unset VISION_DAILY_MAX into "off"
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Names of the required variables that are absent. Empty when the server can talk to Supabase. */
export function missingServerEnv(): string[] {
  const missing: string[] = [];
  if (!str(process.env.SUPABASE_URL)) missing.push('SUPABASE_URL');
  if (!str(process.env.SUPABASE_SERVICE_ROLE_KEY)) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  return missing;
}

export function isConfigured(): boolean {
  return missingServerEnv().length === 0;
}

/** Throws ConfigError when a required variable is missing; the caller (a route) answers 503. */
export function getServerEnv(): ServerEnv {
  const missing = missingServerEnv();
  if (missing.length > 0) throw new ConfigError(missing);
  return {
    supabaseUrl: str(process.env.SUPABASE_URL)!.replace(/\/+$/, ''),
    supabaseServiceRoleKey: str(process.env.SUPABASE_SERVICE_ROLE_KEY)!,
    anthropicApiKey: str(process.env.ANTHROPIC_API_KEY),
    visionModel: str(process.env.VISION_MODEL) ?? ENV_DEFAULTS.visionModel,
    visionEnabled: bool(process.env.VISION_ENABLED, ENV_DEFAULTS.visionEnabled),
    visionDailyMax: int(process.env.VISION_DAILY_MAX, ENV_DEFAULTS.visionDailyMax),
    twilioAccountSid: str(process.env.TWILIO_ACCOUNT_SID),
    twilioAuthToken: str(process.env.TWILIO_AUTH_TOKEN),
    twilioMessagingServiceSid: str(process.env.TWILIO_MESSAGING_SERVICE_SID),
    twilioVerifyServiceSid: str(process.env.TWILIO_VERIFY_SERVICE_SID),
    twilioWebhookUrl: str(process.env.TWILIO_WEBHOOK_URL),
    smsEnabled: bool(process.env.SMS_ENABLED, ENV_DEFAULTS.smsEnabled),
    smsAllowlist: (str(process.env.SMS_ALLOWLIST) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    resendApiKey: str(process.env.RESEND_API_KEY),
    staffEmailFrom: str(process.env.STAFF_EMAIL_FROM),
    jobSecret: str(process.env.JOB_SECRET),
    open311ApiKeys: (str(process.env.OPEN311_API_KEYS) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    nwsUserAgent: str(process.env.NWS_USER_AGENT) ?? ENV_DEFAULTS.nwsUserAgent,
    sentryDsnServer: str(process.env.SENTRY_DSN_SERVER),
    expoAccessToken: str(process.env.EXPO_ACCESS_TOKEN),
  };
}
