/**
 * Supabase PhotosRepo over Storage bucket PHOTO_BUCKET (private; plan §3.2, §12) and the report_photo table (plan §6).
 * Uploads go through the service client with `upsert: false` so a key is never overwritten; a failed second upload
 * removes the first object so no orphan bytes are left behind. Attaching is one UPDATE restricted to pending rows
 * (`report_id is null`), which is also what makes a replayed create harmless. Reads throw on a database error so the
 * route answers 500. Server-only module.
 */
import type { PhotoPhase } from '@/domain/types';

import type { ServiceClient } from '../../db';
import { logEvent } from '../../log';
import type { AttachPhotosOpts, PhotoRow, PhotosRepo, PutPhotoInput } from '../photos';
import { photoKeys } from '../photos';
import { PHOTO_BUCKET } from './reports';
import type { SupabaseUsersRepo } from './users';

const PHOTO_COLUMNS = 'id, tenant_id, report_id, uploader_id, storage_key, thumb_key, phase, visibility, width, height, bytes, created_at';

interface DbPhotoRow {
  id: string;
  tenant_id: string;
  report_id: string | null;
  uploader_id: string | null;
  storage_key: string;
  thumb_key: string;
  phase: PhotoPhase;
  visibility: 'staff_only' | 'public';
  width: number | null;
  height: number | null;
  bytes: number | null;
  created_at: string;
}

function fromDb(r: DbPhotoRow): PhotoRow {
  return { ...r, width: Number(r.width ?? 0), height: Number(r.height ?? 0), bytes: Number(r.bytes ?? 0) };
}

export class SupabasePhotosRepo implements PhotosRepo {
  constructor(
    private readonly client: ServiceClient,
    private readonly users: SupabaseUsersRepo,
  ) {}

  async put(input: PutPhotoInput): Promise<PhotoRow> {
    const tenant_id = await this.users.pilotTenantId();
    const id = crypto.randomUUID();
    const keys = photoKeys(tenant_id, id);
    const bucket = this.client.storage.from(PHOTO_BUCKET);
    const full = await bucket.upload(keys.full, input.full, { contentType: 'image/jpeg', upsert: false });
    if (full.error) throw new Error(`photo upload failed: ${full.error.message}`);
    const thumb = await bucket.upload(keys.thumb, input.thumb, { contentType: 'image/jpeg', upsert: false });
    if (thumb.error) {
      await bucket.remove([keys.full]).catch(() => {});
      throw new Error(`thumbnail upload failed: ${thumb.error.message}`);
    }
    const row = { id, tenant_id, report_id: null, uploader_id: input.uploaderId, storage_key: keys.full, thumb_key: keys.thumb, phase: 'before' as const, visibility: 'staff_only' as const, width: input.width, height: input.height, bytes: input.full.length, created_at: input.now };
    const { error } = await this.client.from('report_photo').insert(row);
    if (error) {
      await bucket.remove([keys.full, keys.thumb]).catch(() => {});
      throw new Error(`report_photo insert failed: ${error.message}`);
    }
    return { ...row };
  }

  async get(id: string): Promise<PhotoRow | null> {
    const { data, error } = await this.client.from('report_photo').select(PHOTO_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw new Error(`report_photo read failed: ${error.message}`);
    return data ? fromDb(data as unknown as DbPhotoRow) : null;
  }

  async read(key: string): Promise<Uint8Array | null> {
    const { data, error } = await this.client.storage.from(PHOTO_BUCKET).download(key);
    if (error || !data) {
      if (error) logEvent('warn', 'photos.download_failed', { message: error.message });
      return null;
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  async attach(ids: readonly string[], opts: AttachPhotosOpts): Promise<PhotoRow[]> {
    if (ids.length === 0) return [];
    const patch = opts.anonymous ? { report_id: opts.reportId, phase: opts.phase, uploader_id: null } : { report_id: opts.reportId, phase: opts.phase };
    const { data, error } = await this.client.from('report_photo').update(patch).in('id', [...ids]).is('report_id', null).select(PHOTO_COLUMNS);
    if (error) throw new Error(`report_photo attach failed: ${error.message}`);
    return ((data ?? []) as unknown as DbPhotoRow[]).map(fromDb);
  }

  async listByReport(reportId: string): Promise<PhotoRow[]> {
    const { data, error } = await this.client.from('report_photo').select(PHOTO_COLUMNS).eq('report_id', reportId).order('created_at', { ascending: true });
    if (error) throw new Error(`report_photo list failed: ${error.message}`);
    return ((data ?? []) as unknown as DbPhotoRow[]).map(fromDb);
  }
}
