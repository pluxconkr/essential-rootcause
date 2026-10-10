/**
 * In-memory PhotosRepo for route tests and the dev server: deterministic ids (ph_000001…), object bytes in a Map
 * keyed by storage key, rows in an array. The same key layout as the Supabase bucket (<tenant>/<photoId>/full.jpg)
 * so a test can assert what was stored, including that the bytes carry no EXIF. Server-only module.
 */
import type { AttachPhotosOpts, PhotoAnalysis, PhotoRow, PhotosRepo, PutPhotoInput, VisionFeedbackInput } from '../photos';
import { photoKeys } from '../photoKeys';
import { MEMORY_TENANT_ID } from './users';

export class MemoryPhotosRepo implements PhotosRepo {
  readonly rows: PhotoRow[] = [];
  readonly objects = new Map<string, Uint8Array>();
  /** report_photo.ai_json / model_version by photo id. */
  readonly analyses = new Map<string, PhotoAnalysis>();
  /** vision_feedback rows, in insertion order. */
  readonly feedback: VisionFeedbackInput[] = [];
  private seq = 0;

  async put(input: PutPhotoInput): Promise<PhotoRow> {
    const id = `ph_${String(++this.seq).padStart(6, '0')}`;
    const keys = photoKeys(MEMORY_TENANT_ID, id);
    this.objects.set(keys.full, new Uint8Array(input.full));
    this.objects.set(keys.thumb, new Uint8Array(input.thumb));
    const row: PhotoRow = { id, tenant_id: MEMORY_TENANT_ID, report_id: null, uploader_id: input.uploaderId, storage_key: keys.full, thumb_key: keys.thumb, phase: 'before', visibility: 'staff_only', width: input.width, height: input.height, bytes: input.full.length, created_at: input.now };
    this.rows.push(row);
    return { ...row };
  }

  async get(id: string): Promise<PhotoRow | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async read(key: string): Promise<Uint8Array | null> {
    const bytes = this.objects.get(key);
    return bytes ? new Uint8Array(bytes) : null;
  }

  async attach(ids: readonly string[], opts: AttachPhotosOpts): Promise<PhotoRow[]> {
    const out: PhotoRow[] = [];
    for (const id of ids) {
      const row = this.rows.find((r) => r.id === id && r.report_id === null);
      if (!row) continue;
      row.report_id = opts.reportId;
      row.phase = opts.phase;
      if (opts.anonymous) row.uploader_id = null;
      out.push({ ...row });
    }
    return out;
  }

  async listByReport(reportId: string): Promise<PhotoRow[]> {
    return this.rows.filter((r) => r.report_id === reportId).map((r) => ({ ...r }));
  }

  async setAnalysis(id: string, aiJson: Record<string, unknown>, modelVersion: string): Promise<void> {
    if (!this.rows.some((r) => r.id === id)) return;
    this.analyses.set(id, { ai_json: JSON.parse(JSON.stringify(aiJson)) as Record<string, unknown>, model_version: modelVersion });
  }

  async analysisOf(id: string): Promise<PhotoAnalysis | null> {
    const a = this.analyses.get(id);
    return a ? { ai_json: a.ai_json ? (JSON.parse(JSON.stringify(a.ai_json)) as Record<string, unknown>) : null, model_version: a.model_version } : this.rows.some((r) => r.id === id) ? { ai_json: null, model_version: null } : null;
  }

  async recordFeedback(input: VisionFeedbackInput): Promise<void> {
    this.feedback.push({ ...input });
  }
}
