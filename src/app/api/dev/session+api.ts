/**
 * POST /api/dev/session — developer sign-in for the simulator and rehearsals (src/server/devSession.ts): a 404 unless
 * the dev-memory server runs with ROOTCAUSE_DEV_SESSION=1, and only for throwaway addresses under e2e.rootcause.app.
 * Body {email?, displayName?} → {accessToken, refreshToken, email}; the phone hands the tokens to supabase.auth.setSession.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { z } from 'zod';

import { error, json, parseJson, withTiming } from '@/server/http';
import { DEV_SESSION_DEFAULT_EMAIL, devSessionEnabled, mintDevSession } from '@/server/devSession';

export const DevSessionInputSchema = z.object({
  email: z.string().trim().toLowerCase().max(120).optional(),
  displayName: z.string().trim().max(60).optional(),
});

const handlePost = withTiming('POST /api/dev/session', async (request) => {
  if (!devSessionEnabled()) return error(404, 'not_found', 'Not found.');
  const parsed = await parseJson(request, DevSessionInputSchema);
  if (!parsed.ok) return parsed.response;
  const result = await mintDevSession(parsed.data.email ?? DEV_SESSION_DEFAULT_EMAIL, parsed.data.displayName ?? 'Sim Tester');
  if (!result.ok) return error(result.status, result.status === 400 ? 'bad_request' : 'misconfigured', result.message);
  return json({ accessToken: result.accessToken, refreshToken: result.refreshToken, email: result.email });
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
