/**
 * Vision seam for POST /api/v1/vision/analyze (plan §3.6, §23.I). M1: `analyzePhoto()` returns null and no model is
 * called, so the route answers `{proposals: null, reason: 'disabled'}` and the flow continues with the manual form
 * (plan §15 M1 "vision flag off → identical flow"). The route already applies the per-user daily limit and returns
 * duplicate candidates. Everything below the TODO is the contract M3 implements; nothing here imports the SDK yet.
 *
 * TODO(M3) — implement with the official TypeScript SDK (`@anthropic-ai/sdk`), per plan §3.6/§23.I:
 *   - `new Anthropic({ apiKey: env.anthropicApiKey, timeout: VISION.timeoutMs, maxRetries: 0 })` per request;
 *   - `client.messages.parse({ model: VISION.model, max_tokens: VISION.maxTokens, output_config: { format: <zod → JSON
 *     schema of VisionProposalSchema, taxonomy enums only, severity_band 1–3> }, messages: [image (base64 JPEG from
 *     photos.read(storage_key)) + instruction] })` — no `thinking`, no `effort` (not supported on Haiku 4.5);
 *   - read `stop_reason` before `parsed_output`: anything other than `end_turn`, a null `parsed_output` or a zod
 *     failure → `{ proposals: null, reason: 'unclear' }`, logged with `response.model`, `stop_reason` and `usage`;
 *   - a timeout → reason 'timeout'; any other SDK error → 'error'; confidence < VISION.confidenceFloor → 'unclear';
 *   - hazardous taxa (toxic_plant: hogweed, hemlock) are never auto-confirmed; no displacement/mm output ever;
 *   - store raw content + usage in report_photo.ai_json with model_version; count the day's analyses against
 *     tenant.vision_daily_max and `VISION_ENABLED` (both required — AND).
 * Server-only module.
 */
import type { Subtype, VisionProposal } from '@/domain/types';

import { getServerEnv, isConfigured } from './env';

export const VISION = {
  model: 'claude-haiku-4-5', // spec: plan §3.6 model `claude-haiku-4-5` (VISION_MODEL enum, §23.I)
  timeoutMs: 8_000, // spec: plan §3.6 request timeout 8 s after which S-05 proceeds without proposals
  maxTokens: 600, // spec: plan §3.6 max_tokens ≈ 600
  confidenceFloor: 0.7, // spec: plan §3.6 confidence floor 0.70 below which the UI says "unclear"
  perUserPerDay: 20, // spec: plan §7 POST /api/v1/vision/analyze 20/d
} as const;

export interface AnalyzePhotoInput {
  photoId: string;
  lat: number;
  lng: number;
  subtypeHint?: Subtype;
}

/** Server-side kill switch (plan §23.I). Fails closed: without a configured env the model is off. */
export function visionEnabled(): boolean {
  if (!isConfigured()) return false;
  const env = getServerEnv();
  return env.visionEnabled && env.visionModel === VISION.model && env.anthropicApiKey !== null;
}

/** M1: no model call; always null so the route reports `disabled` and S-05 falls back to the manual flow. */
export async function analyzePhoto(_input: AnalyzePhotoInput): Promise<VisionProposal | null> {
  // TODO(M3): see the module header for the request shape and the response-handling rules.
  return null;
}
