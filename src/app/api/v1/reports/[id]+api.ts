/**
 * /api/v1/reports/[id] (plan §7)
 *   GET   → {report}: the public projection through toPublicReport() (plan §12); 404 when unknown.
 *           Staff get the full projection in M2.
 *   PATCH → 501 until M2, when status / severity / mitigation changes are validated by domain/status.transition()
 *           (capability, from→to, after-photo for `completed`), appended to report_event and pushed to followers
 *           (plan §4 flow 6).
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { error, json, withTiming } from '@/server/http';
import { toPublicReport } from '@/server/public';
import { getRepos } from '@/server/repos/types';

const handleGet = withTiming('GET /api/v1/reports/[id]', async (_request, { params }) => {
  const id = params.id?.trim() ?? '';
  const row = id ? await getRepos().reports.getPublicById(id) : null;
  if (!row) return error(404, 'not_found', 'No such report.');
  return json({ report: toPublicReport(row) });
});

const handlePatch = withTiming('PATCH /api/v1/reports/[id]', async () => {
  // TODO(M2): requireUser + requireCapability (inspector: status/severity/mitigation, supervisor: schedule), zod body,
  // domain/status.transition(), report_event append, WorkOrderSync.onStatusChange(), pushes (plan §4 flow 6).
  return error(501, 'not_implemented', 'Status changes arrive in M2.');
});

export async function GET(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handleGet(request, params);
}

export async function PATCH(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePatch(request, params);
}
