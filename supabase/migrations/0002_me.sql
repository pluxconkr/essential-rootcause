/**
 * Profile and account deletion support for the /api/v1/me routes (plan §7 /me rows, §12 "Deletion vs retention",
 * §23.C). Expand-only (runbook §2): two columns and two generated columns on watch_area, one RPC.
 *
 *   - watch_area.label: the resident's name for the area (src/domain/types.ts WatchAreaSchema.label, ≤ 60 chars);
 *     0001 had no label column.
 *   - watch_area.lat / lng: the stored point as plain numbers, like report.lat/lng, so the API reads watch areas
 *     without decoding EWKB (contract of src/server/repos/supabase/me.ts WATCH_COLUMNS). v1 stores every kind as a
 *     Point (one lat/lng per WatchAreaInput); st_centroid keeps the expression valid when a route LineString arrives later.
 *   - deidentify_user(p_user, p_now): DELETE /me in one transaction, in the plan §23.C order — the semantic oracle is
 *     src/server/repos/memory/me.ts deidentify(). Returns jsonb counts, never ids.
 */

alter table watch_area add column label text not null default '';
alter table watch_area add column lat double precision generated always as (st_y(st_centroid(geom::geometry))) stored;
alter table watch_area add column lng double precision generated always as (st_x(st_centroid(geom::geometry))) stored;

-- DELETE /api/v1/me (plan §23.C, §12): the account's votes are summed into report.orphan_vote_weight and removed
-- (vote_count unchanged, the community term keeps counting them); reports and photos lose the reporter link; comments
-- are attributed to "former user" (user_id NULL); follows, devices and watch areas go; app_user becomes a tombstone
-- (deleted_at) with every personal column cleared. report_event stays untouched: it is append-only and carries no PII.
-- The route calls auth.admin.deleteUser() only after this function returned, so a failure here deletes nothing.
create or replace function public.deidentify_user(p_user uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_reports int;
  v_photos int;
  v_comments int;
  v_votes int;
  v_follows int;
  v_devices int;
  v_watch int;
  v_orphan numeric;
begin
  with mine as (
    select report_id, sum(weight) as w
    from report_vote
    where user_id = p_user
    group by report_id
  ),
  moved as (
    update report r
    set orphan_vote_weight = r.orphan_vote_weight + mine.w
    from mine
    where r.id = mine.report_id
    returning mine.w
  )
  select coalesce(sum(w), 0) into v_orphan from moved;

  delete from report_vote where user_id = p_user;
  get diagnostics v_votes = row_count;

  update report set reporter_id = null, reporter_display = 'anonymous' where reporter_id = p_user;
  get diagnostics v_reports = row_count;

  update report_photo set uploader_id = null where uploader_id = p_user;
  get diagnostics v_photos = row_count;

  update report_comment set user_id = null where user_id = p_user;
  get diagnostics v_comments = row_count;

  delete from report_follow where user_id = p_user;
  get diagnostics v_follows = row_count;

  delete from device where user_id = p_user;
  get diagnostics v_devices = row_count;

  delete from watch_area where user_id = p_user;
  get diagnostics v_watch = row_count;

  update app_user
  set display_name = null,
      home_geom = null,
      phone_e164 = null,
      phone_verified_at = null,
      sms_opt_in = false,
      quiet_hours = null,
      apple_refresh_token = null,
      blocked_by = '{}',
      deleted_at = p_now
  where id = p_user;

  return jsonb_build_object(
    'reports', v_reports,
    'photos', v_photos,
    'comments', v_comments,
    'votes', v_votes,
    'follows', v_follows,
    'devices', v_devices,
    'watch_areas', v_watch,
    'orphan_vote_weight', v_orphan
  );
end
$$;

-- Service role only, like every RPC in 0001 section 10 (the default-privileges block there already covers new functions;
-- the explicit revoke survives a later `create or replace`).
revoke execute on function public.deidentify_user(uuid, timestamptz) from public, anon, authenticated;
