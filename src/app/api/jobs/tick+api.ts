/**
 * POST /api/jobs/tick (plan §7, §11): pg_cron → pg_net calls this every minute with the `x-job-secret` header
 * (supabase/seed.sql); a GitHub Actions schedule is the fallback caller. The secret is compared in constant time
 * (SHA-256 of both sides, then a fixed-length XOR fold); 401 when it does not match, 503 when JOB_SECRET or the
 * Supabase env is unset so a misconfigured deploy shows up in the uptime check instead of silently idling. Runs
 * src/server/jobs/tick.ts and answers {ran, skipped, tookMs}; the tick returns within TICK_DEADLINE_MS (plan §23.G).
 * Expo Router API route: no React Native imports; the handler returns a Response and never throws (withTiming).
 */
import { getServerEnv } from '@/server/env';
import { error, json, withTiming } from '@/server/http';
import { tick } from '@/server/jobs/tick';
import { getJobsStore } from '@/server/repos/jobs';

export const JOB_SECRET_HEADER = 'x-job-secret'; // spec: plan §7 route table; supabase/seed.sql cron headers

/** Constant-time equality: both sides are hashed to a fixed length first, so neither the length nor the position of a mismatch leaks. */
export async function secretMatches(given: string | null, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given ?? '')), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const handlePost = withTiming('POST /api/jobs/tick', async (request, ctx) => {
  const env = getServerEnv();
  if (!env.jobSecret) return error(503, 'misconfigured', 'JOB_SECRET is not set; the job tick is disabled.');
  if (!(await secretMatches(request.headers.get(JOB_SECRET_HEADER), env.jobSecret))) return error(401, 'unauthenticated', 'Missing or wrong job secret.');
  const result = await tick({ store: getJobsStore(), requestId: ctx.requestId });
  return json(result);
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
