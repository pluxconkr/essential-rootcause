/**
 * DPW console stand-in for the demo (docs/gap-analysis.md headline 2; docs/QA.md T13): moves one report through the
 * status machine exactly as PATCH /api/v1/reports/:id does — domain/status.transition() validates the move and its
 * evidence, a `status` report_event is appended, the reporter and followers are pushed (server/notify.ts) — by
 * calling the same server/lifecycle.changeStatus() core with a supervisor actor and no user id (the event's actor_id
 * is NULL, like a system move). Server-side only: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment,
 * as for grant-role.ts; EXPO_ACCESS_TOKEN is optional and only affects the push leg.
 *
 *   npx tsx scripts/set-status.ts <reportId> <toStatus> [--note "…"] [--after-photo <photoId>] [--severity 1|2|3|4]
 *
 *   <toStatus>      triaged · assessed · mitigated · scheduled · completed · rejected, in the order the machine allows
 *                   (new → triaged → assessed → mitigated|scheduled → completed; rejected from any open status).
 *   --note          Shown on the resident's timeline. Required for `rejected` ("Not city-owned — here's who owns it").
 *   --after-photo   `completed` needs an after-photo: the id of a pending upload (POST /api/v1/photos) or of a photo
 *                   already attached to the report with phase `after`.
 *   --severity      The inspector's confirmed band (writes severity_audit and rescores the severity term).
 *
 *   `verified` and the reopen to `assessed` are resident moves (POST /api/v1/reports/:id/verify, or the autoVerify
 *   job after 14 days) — the script refuses them, as the route does.
 */
import { REPORT_STATUSES, type ReportStatus, type SeverityBand, type StatusPatchInput } from '../src/domain/types';
import { changeStatus } from '../src/server/lifecycle';

function usage(): never {
  console.error(`usage: set-status.ts <reportId> <${REPORT_STATUSES.join('|')}> [--note "…"] [--after-photo <photoId>] [--severity 1|2|3|4]`);
  process.exit(2);
}

function parseArgs(argv: string[]): { reportId: string; input: StatusPatchInput } {
  const [reportId, to, ...rest] = argv;
  if (!reportId || !to || !REPORT_STATUSES.includes(to as ReportStatus)) usage();
  const input: StatusPatchInput = { to: to as ReportStatus };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) usage();
    if (flag === '--note') input.note = value;
    else if (flag === '--after-photo') input.afterPhotoId = value;
    else if (flag === '--severity') {
      const band = Number(value);
      if (![1, 2, 3, 4].includes(band)) usage();
      input.severityConfirmed = band as SeverityBand;
    } else usage();
  }
  return { reportId, input };
}

async function main() {
  const { reportId, input } = parseArgs(process.argv.slice(2));
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server env only).');
    process.exit(2);
  }
  const result = await changeStatus(reportId, input, { role: 'supervisor', userId: null });
  if (!result.ok) {
    console.error(`${result.status} ${result.code}: ${result.message}`);
    process.exit(1);
  }
  const last = result.row.events[result.row.events.length - 1];
  console.log(`${reportId}: ${result.from} → ${result.row.status}${input.note ? ` — “${input.note}”` : ''} (event ${last?.id ?? '?'}; followers and the reporter were notified where a device is registered)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
