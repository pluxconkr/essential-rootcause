/**
 * GET /api/v1/me/reports (plan §7 /me rows; spec R13 "my reports"): {reports: PublicReport[]} — the account's reports
 * filed as Named or Initials, newest first, each through toPublicReport() (plan §12: the public projection is the
 * only shape that leaves, even to the reporter). Anonymous reports are not here by design: the server holds no link
 * (plan §3.4), the phone keeps its own (myReportsRepo). Needs a session.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { requireUser } from '@/server/auth';
import { json, withTiming } from '@/server/http';
import { toPublicReport } from '@/server/public';
import { getMeRepo } from '@/server/repos/me';
import { getRepos } from '@/server/repos/types';

export const MY_REPORTS_LIMIT = 50; // plenty for one resident; each report is read in full (photos, timeline)

const handleGet = withTiming('GET /api/v1/me/reports', async (request) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const rows = await getMeRepo().listOwnReports(user.userId, MY_REPORTS_LIMIT);
  return json({ reports: rows.map(toPublicReport) });
});

export async function GET(request: Request): Promise<Response> {
  return handleGet(request);
}
