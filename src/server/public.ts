/**
 * Public projection (plan §12): every non-staff view of a report — /v1/reports, /r/[id], Open311, exports — goes
 * through toPublicReport(), an allow-list serializer. It emits the stored public point (geom_public: deterministic
 * 50 m snap/jitter for reporter-linked reports, computed at insert; precise for anonymous reports until the day-30
 * coarsening — spec §12/§13), the reporter name per identity choice, public photos only, and never home_geom, watch
 * areas, phone numbers, internal notes, install ids, uploader ids, the client draft id or the precise point.
 * PUBLIC_FIELDS is the whole allow-list; __tests__/routes/public-projection.test.ts pins it. Server-only module.
 */
import { effectiveSeverity } from '@/domain/score';
import { subtypeDef } from '@/domain/taxonomy';
import type { PublicReport, ReportEvent, ReportPhoto } from '@/domain/types';

import type { ReportPhotoRow, ReportRow } from './repos/types';

export const PUBLIC_FIELDS = [
  'id',
  'category',
  'subtype',
  'status',
  'title',
  'addressText',
  'addressConfidence',
  'lat',
  'lng',
  'severity',
  'severityConfirmed',
  'emergencyRequested',
  'score',
  'scoreTerms',
  'stormMultiplier',
  'voteCount',
  'createdAt',
  'updatedAt',
  'reporterDisplay',
  'reporterName',
  'stormSensitivity',
  'photos',
  'timeline',
  'commentCount',
  'summary',
] as const satisfies readonly (keyof PublicReport)[];

/** "Jane Q. Doe" → "J.D."; null when there is no name to abbreviate. */
export function initials(name: string | null): string | null {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return `${first.toUpperCase()}.${last ? `${last.toUpperCase()}.` : ''}`;
}

function reporterName(row: ReportRow): string | null {
  if (row.reporter_display === 'anonymous' || row.reporter_id === null) return null;
  const name = row.reporter_display_name?.trim() || null;
  return row.reporter_display === 'initials' ? initials(name) : name;
}

function toPublicPhoto(p: ReportPhotoRow): ReportPhoto {
  return { id: p.id, url: p.url, thumbUrl: p.thumb_url, phase: p.phase };
}

function toPublicEvent(e: ReportRow['events'][number]): ReportEvent {
  return { id: e.id, kind: e.kind, fromStatus: e.from_status, toStatus: e.to_status, note: e.note, at: e.created_at };
}

export function toPublicReport(row: ReportRow): PublicReport {
  return {
    id: row.id,
    category: row.category,
    subtype: row.subtype,
    status: row.status,
    title: subtypeDef(row.subtype).label,
    addressText: row.address_text,
    addressConfidence: row.address_confidence,
    lat: row.public_lat,
    lng: row.public_lng,
    severity: effectiveSeverity({ confirmed: row.severity_confirmed, ai: row.severity_ai, resident: row.severity_resident }),
    severityConfirmed: row.severity_confirmed !== null,
    emergencyRequested: row.emergency_requested,
    score: row.score,
    scoreTerms: { ...row.score_terms },
    stormMultiplier: row.storm_multiplier,
    voteCount: row.vote_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reporterDisplay: row.reporter_id === null ? 'anonymous' : row.reporter_display,
    reporterName: reporterName(row),
    stormSensitivity: [...row.storm_sensitivity],
    photos: row.photos.filter((p) => p.visibility === 'public').map(toPublicPhoto),
    timeline: row.events.map(toPublicEvent),
    commentCount: row.comment_count,
    // The resident's intake note is stored as the `created` event's note (repos/derive.ts); lists carry no events, so it is null there.
    summary: row.events.find((e) => e.kind === 'created')?.note ?? null,
  };
}
