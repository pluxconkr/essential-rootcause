/**
 * /api/v1/reports/[id]/follow (plan §7 "POST/DELETE · resident"; spec R7 "follow"). Following subscribes the account
 * to status pushes on the report (server/notify.ts). POST → 201 {reportId, following: true} the first time, 200 on a
 * replay; DELETE → 200 {reportId, following: false} whether or not a row existed — both idempotent, because the
 * phone replays queued follow/unfollow mutations after a reconnect (plan §9.2). Expo Router API route: no React
 * Native imports; handlers return a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { requireCapability, requireUser, type AuthedUser } from '@/server/auth';
import { error, json, withTiming } from '@/server/http';
import { getEngagementRepo } from '@/server/repos/engagement';
import { getRepos, type ReportRow } from '@/server/repos/types';

export const FOLLOW_ACTION: Action = 'follow';

async function prepare(request: Request, params: Record<string, string>): Promise<{ user: AuthedUser; row: ReportRow } | Response> {
  const repos = getRepos();
  const user = await requireUser(request, repos);
  if (user instanceof Response) return user;
  const denied = requireCapability(user, FOLLOW_ACTION);
  if (denied) return denied;
  const id = params.id?.trim() ?? '';
  const row = id ? await repos.reports.getPublicById(id) : null;
  if (!row) return error(404, 'not_found', 'No such report.');
  return { user, row };
}

const handlePost = withTiming('POST /api/v1/reports/[id]/follow', async (request, { params }) => {
  const prepared = await prepare(request, params);
  if (prepared instanceof Response) return prepared;
  const created = await getEngagementRepo().follow(prepared.row.id, prepared.user.userId, new Date().toISOString());
  return json({ reportId: prepared.row.id, following: true }, { status: created ? 201 : 200 });
});

const handleDelete = withTiming('DELETE /api/v1/reports/[id]/follow', async (request, { params }) => {
  const prepared = await prepare(request, params);
  if (prepared instanceof Response) return prepared;
  await getEngagementRepo().unfollow(prepared.row.id, prepared.user.userId);
  return json({ reportId: prepared.row.id, following: false });
});

export async function POST(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePost(request, params);
}

export async function DELETE(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handleDelete(request, params);
}
