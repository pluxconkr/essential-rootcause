/**
 * /api/v1/reports/[id] (plan §7)
 *   GET   → {report}: the public projection through toPublicReport() (plan §12); 404 when unknown.
 *           Staff get the full projection in M2.
 *   PATCH → staff status move (plan §4 flow 6; spec status table): StatusPatchInput {to, note?, afterPhotoId?,
 *           severityConfirmed?} → 200 {report}. Session + the capability the target status needs (domain/roles), then
 *           server/lifecycle.changeStatus(): domain/status.transition() validates from→to and the evidence
 *           (after-photo for `completed`, a reason for `rejected`), the row and a `status` report_event are written,
 *           the reporter and followers are pushed. 409 invalid_transition when the move is not open from the
 *           current status, 422 invalid_transition when evidence is missing; `verified` and the reopen are resident
 *           moves (…/verify) and answer 409 here. scripts/set-status.ts calls the same core for the demo.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { StatusPatchInputSchema, type ReportStatus } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { changeStatus } from '@/server/lifecycle';
import { toPublicReport } from '@/server/public';
import { getRepos } from '@/server/repos/types';

/** The capability each target status needs (spec §11; domain/status STAFF_MOVES). `new` and `verified` are never staff targets: the gate is the inspector's, the 409 comes from transition(). */
export const STATUS_ACTION: Record<ReportStatus, Action> = {
  new: 'triage',
  triaged: 'triage',
  assessed: 'confirm_severity',
  mitigated: 'mitigate',
  scheduled: 'schedule',
  completed: 'complete',
  verified: 'triage',
  rejected: 'triage',
};

const handleGet = withTiming('GET /api/v1/reports/[id]', async (_request, { params }) => {
  const id = params.id?.trim() ?? '';
  const row = id ? await getRepos().reports.getPublicById(id) : null;
  if (!row) return error(404, 'not_found', 'No such report.');
  return json({ report: toPublicReport(row) });
});

const handlePatch = withTiming('PATCH /api/v1/reports/[id]', async (request, { params }) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const parsed = await parseJson(request, StatusPatchInputSchema);
  if (!parsed.ok) return parsed.response;
  const denied = requireCapability(user, STATUS_ACTION[parsed.data.to]);
  if (denied) return denied;
  const result = await changeStatus(params.id?.trim() ?? '', parsed.data, { role: user.role, userId: user.userId });
  if (!result.ok) return error(result.status, result.code, result.message);
  return json({ report: toPublicReport(result.row) });
});

export async function GET(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handleGet(request, params);
}

export async function PATCH(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePatch(request, params);
}
