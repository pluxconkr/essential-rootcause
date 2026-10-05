/**
 * /api/v1/reports/[id]/comments (plan §7 "POST · resident / staff · 20/h · is_internal staff only · domain/moderation
 * filter"; spec R7 "comments (public record)").
 *   GET  → CommentsResponse: the visible, non-internal comments oldest first. Public like the report itself; internal
 *          notes never leave through this route (plan §12).
 *   POST CommentInput {body, isInternal?} → 201 {comment}. Needs a session and the `comment` capability; the body
 *          passes domain/moderation (400 with the reason the phone already showed); isInternal needs the `triage`
 *          capability (inspector and up) and is stored as a staff-only note "still subject to records requests".
 * Author display never reveals an email: staff by name or "City staff", a reporter commenting on their own report
 * per that report's identity choice (named → name, initials → "J.D."), every other resident by initials, and a
 * deleted account as "Former user" (plan §12). Expo Router API route: no React Native imports; never throws.
 */
import { moderateComment } from '@/domain/moderation';
import { can, isStaff, type Action } from '@/domain/roles';
import { CommentInputSchema, type Comment } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { initials } from '@/server/public';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { getEngagementRepo, type CommentRow } from '@/server/repos/engagement';
import { getRepos, type ReportRow } from '@/server/repos/types';

export const COMMENT_LIMIT = {
  perWindow: 20, // spec: plan §7 POST /api/v1/reports/:id/comments 20/h
  windowSec: 3600,
} as const;

export const COMMENT_ACTION: Action = 'comment';

/** Internal notes are for staff who run triage — inspector and up (plan §7 "is_internal staff only"; spec §11). */
export const INTERNAL_ACTION: Action = 'triage';

export function commentAuthorDisplay(c: Pick<CommentRow, 'user_id' | 'author_display_name' | 'is_staff'>, report: Pick<ReportRow, 'reporter_id' | 'reporter_display'>): string {
  if (c.user_id === null) return 'Former user'; // plan §12: DELETE /me leaves comments attributed to "former user"
  const name = c.author_display_name?.trim() || null;
  if (c.is_staff) return name ?? 'City staff';
  if (report.reporter_id === c.user_id && report.reporter_display === 'named') return name ?? 'Reporter';
  return initials(name) ?? 'Resident';
}

export function toPublicComment(c: CommentRow, report: Pick<ReportRow, 'reporter_id' | 'reporter_display'>): Comment {
  return { id: c.id, body: c.body, authorDisplay: commentAuthorDisplay(c, report), isStaff: c.is_staff, at: c.created_at };
}

const handleGet = withTiming('GET /api/v1/reports/[id]/comments', async (_request, { params }) => {
  const id = params.id?.trim() ?? '';
  const row = id ? await getRepos().reports.getPublicById(id) : null;
  if (!row) return error(404, 'not_found', 'No such report.');
  const rows = await getEngagementRepo().listComments(row.id, { includeInternal: false });
  return json({ comments: rows.map((c) => toPublicComment(c, row)) });
});

const handlePost = withTiming('POST /api/v1/reports/[id]/comments', async (request, { params }) => {
  const repos = getRepos();
  const user = await requireUser(request, repos);
  if (user instanceof Response) return user;
  const denied = requireCapability(user, COMMENT_ACTION);
  if (denied) return denied;
  const parsed = await parseJson(request, CommentInputSchema);
  if (!parsed.ok) return parsed.response;
  const verdict = moderateComment(parsed.data.body);
  if (!verdict.ok) return error(400, 'bad_request', verdict.message);
  const internal = parsed.data.isInternal === true;
  if (internal && !can(user.role, INTERNAL_ACTION)) return error(403, 'forbidden', 'Only city staff can add internal notes.');
  const allowed = await getRateLimiter().hit(keyFor(['comments', user.userId]), COMMENT_LIMIT.perWindow, COMMENT_LIMIT.windowSec);
  if (!allowed) return error(429, 'rate_limited', 'You have commented many times this hour. Try again later.', { headers: { 'retry-after': String(COMMENT_LIMIT.windowSec) } });
  const id = params.id?.trim() ?? '';
  const row = id ? await repos.reports.getPublicById(id) : null;
  if (!row) return error(404, 'not_found', 'No such report.');
  const comment = await getEngagementRepo().addComment({ report_id: row.id, user_id: user.userId, body: parsed.data.body.trim(), is_staff: isStaff(user.role), is_internal: internal, hidden: false, created_at: new Date().toISOString() });
  return json({ comment: toPublicComment(comment, row) }, { status: 201 });
});

export async function GET(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handleGet(request, params);
}

export async function POST(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePost(request, params);
}
