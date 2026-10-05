/**
 * Shared handler for POST /api/v1/reports/:id/flag and POST /api/v1/comments/:id/flag (plan §7 "resident · 10/d ·
 * moderation queue"; §12 "resident flag"; App Store 1.2). One content_flag row per call: target, the flagging account
 * (so staff can spot abuse of the flag itself), FlagInput.reason on the first line and the optional note after it.
 * The daily limit is per account across both targets. The target must exist (404) — a flag on a hidden comment is
 * still accepted, since hiding is exactly what the flag asks for. Server-only module, used only by the two routes.
 */
import type { Action } from '@/domain/roles';
import { FlagInputSchema } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, type RouteContext } from '@/server/http';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { getEngagementRepo } from '@/server/repos/engagement';
import { getRepos } from '@/server/repos/types';

export const FLAG_LIMIT = {
  perWindow: 10, // spec: plan §7 flag routes 10/d
  windowSec: 86_400,
} as const;

export const FLAG_ACTION: Action = 'flag';

export type FlagTarget = 'report' | 'comment';

export async function handleFlag(target: FlagTarget, request: Request, ctx: RouteContext): Promise<Response> {
  const repos = getRepos();
  const user = await requireUser(request, repos);
  if (user instanceof Response) return user;
  const denied = requireCapability(user, FLAG_ACTION);
  if (denied) return denied;
  const parsed = await parseJson(request, FlagInputSchema);
  if (!parsed.ok) return parsed.response;
  const allowed = await getRateLimiter().hit(keyFor(['flags', user.userId]), FLAG_LIMIT.perWindow, FLAG_LIMIT.windowSec);
  if (!allowed) return error(429, 'rate_limited', 'You have flagged many posts today. Try again tomorrow.', { headers: { 'retry-after': String(FLAG_LIMIT.windowSec) } });
  const id = ctx.params.id?.trim() ?? '';
  const engagement = getEngagementRepo();
  const exists = id ? (target === 'report' ? (await repos.reports.getPublicById(id)) !== null : (await engagement.getComment(id)) !== null) : false;
  if (!exists) return error(404, 'not_found', target === 'report' ? 'No such report.' : 'No such comment.');
  const note = parsed.data.note?.trim();
  const flag = await engagement.addFlag({ target_type: target, target_id: id, reporter_id: user.userId, reason: note ? `${parsed.data.reason}\n${note}` : parsed.data.reason, created_at: new Date().toISOString() });
  return json({ flagId: flag.id, status: flag.status }, { status: 201 });
}
