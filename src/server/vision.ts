/**
 * Vision for POST /api/v1/vision/analyze (spec §8 "a photo is a measurement", R4; plan §3.6, §23.I; owner decision D4:
 * on, Haiku). One request per photo to the Claude API through the official SDK: the EXIF-stripped JPEG the resident
 * uploaded plus the taxonomy as an enum, answered as structured output (zod schema → output_config.format), with no
 * thinking and no effort parameter (Haiku 4.5 takes neither). What the model says becomes a proposal only when it is
 * confident (≥ VISION.confidenceFloor — spec guardrail "below 0.70 the app says unclear rather than guessing"; a
 * confidence off the 0–1 scale is treated as uncalibrated and reported as unclear); it is
 * never a measurement (bands 1–3, no millimetres — spec §8 degrade rule), and a hazardous plant (hogweed, hemlock) is
 * never auto-confirmed (spec O7 confidence policy). A timeout, an API error, a refusal or an unparseable answer all
 * degrade to `proposals: null` with a reason, and S-05 continues with the manual form (plan §15 "vision off →
 * identical flow"). The raw answer and usage go back to the route for report_photo.ai_json (spec §6 "raw model output
 * kept for audit"), and a resident's correction of the proposal becomes a vision_feedback label at report creation
 * (spec 4.1 "every correction is a training label"). The client is built per request (workerd keeps nothing between
 * requests) and injectable for tests. Server-only module.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { CATEGORIES, SUBTYPES, SUBTYPE_IDS, subtypeDef } from '@/domain/taxonomy';
import type { Category, Subtype, VisionProposal } from '@/domain/types';

import { getServerEnv, isConfigured } from './env';
import { logEvent } from './log';
import type { PhotosRepo } from './repos/photos';

export const VISION = {
  model: 'claude-haiku-4-5', // spec: plan §3.6 model `claude-haiku-4-5` (VISION_MODEL enum, §23.I); owner decision D4
  timeoutMs: 12_000, // spec: plan §3.6 request timeout after which S-05 proceeds without proposals — 8 s in the plan, raised to 12 s after the 2026-10-10 live check measured 6 s on a cold connection
  maxTokens: 1024, // spec: plan §3.6 max_tokens ≈ 600 for the JSON answer; 1024 leaves room for the notes sentence
  confidenceFloor: 0.7, // spec: plan §3.6 confidence floor 0.70 below which the UI says "unclear"
  perUserPerDay: 20, // spec: plan §7 POST /api/v1/vision/analyze 20/d
} as const;

export type VisionReason = 'ok' | 'unclear' | 'disabled' | 'timeout' | 'error';

export interface AnalyzePhotoInput {
  /** EXIF-stripped JPEG bytes of the uploaded photo (photos repo `read`). */
  bytes: Uint8Array;
  /** The resident's own pick before analysis, when there was one. */
  subtypeHint?: Subtype;
}

export interface AnalyzePhotoResult {
  proposals: VisionProposal | null;
  reason: VisionReason;
  model: string;
  /** For report_photo.ai_json: the parsed answer (or the failure), stop reason and usage. Null when no call was made. */
  audit: Record<string, unknown> | null;
}

/** The answer the model is asked for. Enum-constrained to the taxonomy; no measurement fields anywhere (spec §8). */
export const VisionOutputSchema = z.object({
  hazard_visible: z.boolean(),
  category: z.enum(CATEGORIES).nullable(),
  subtype: z.enum(SUBTYPE_IDS).nullable(),
  confidence: z.number(),
  severity_band: z.number().int().nullable(),
  severity_confidence: z.number().nullable(),
  species_guess: z.string().nullable(),
  species_confidence: z.number().nullable(),
  notes: z.string().nullable(),
});
export type VisionOutput = z.infer<typeof VisionOutputSchema>;

/** Hazardous taxa are never auto-confirmed from a photo (spec O7 confidence policy; §8 "never auto-confirm hazardous taxa"). */
const HAZARDOUS_TAXA = /hogweed|heracleum|hemlock|conium|cicuta/i;
const NOTES_MAX = 240;

type JsonSchemaNode = { type?: string; enum?: readonly string[]; anyOf?: JsonSchemaNode[]; description?: string; properties?: Record<string, JsonSchemaNode> };

/** Put the taxonomy back as grammar: the SDK's zod → JSON-schema transform folds `enum` into prose (verified 0.132.1), which the API does not enforce. */
function constrainEnum(node: JsonSchemaNode | undefined, values: readonly string[]): void {
  if (!node) return;
  const target = node.anyOf ? node.anyOf.find((v) => v.type === 'string') : node.type === 'string' ? node : undefined;
  if (!target) return;
  target.enum = [...values];
  delete target.description;
}

/**
 * The structured-output format sent with every request, built once: the zod schema as JSON schema with the category
 * and sub-type enums enforced by the grammar, and a parse that never throws — an answer the schema rejects (a
 * truncated JSON, a casing drift) becomes `null`, which interpretVisionOutput() reports as "unclear", and the raw text
 * is kept for the audit record instead of being lost in an exception.
 */
export function visionOutputFormat(): ReturnType<typeof zodOutputFormat<typeof VisionOutputSchema>> {
  const format = zodOutputFormat(VisionOutputSchema);
  const props = (format.schema as JsonSchemaNode).properties ?? {};
  constrainEnum(props.category, CATEGORIES);
  constrainEnum(props.subtype, SUBTYPE_IDS);
  format.parse = (text: string) => {
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (typeof value.category === 'string') value.category = value.category.toLowerCase();
      if (typeof value.subtype === 'string') value.subtype = value.subtype.toLowerCase();
      const result = VisionOutputSchema.safeParse(value);
      return result.success ? result.data : (null as unknown as VisionOutput);
    } catch {
      return null as unknown as VisionOutput;
    }
  };
  return format;
}

const OUTPUT_FORMAT = visionOutputFormat();

/** The slice of the SDK this module uses, so a test can inject a fake without touching the network. */
export type VisionClient = { parse: Anthropic['messages']['parse'] };

let override: VisionClient | null = null;

/** Tests inject a fake client; null restores the per-request SDK client. */
export function setVisionClient(client: VisionClient | null): void {
  override = client;
}

function visionClient(): VisionClient {
  if (override) return override;
  const env = getServerEnv();
  const client = new Anthropic({ apiKey: env.anthropicApiKey ?? undefined, timeout: VISION.timeoutMs, maxRetries: 0 });
  return client.messages;
}

/** Server-side kill switch (plan §23.I). Fails closed: without a configured env the model is off. */
export function visionEnabled(): boolean {
  if (override) return true;
  if (!isConfigured()) return false;
  const env = getServerEnv();
  if (env.visionEnabled && env.visionModel !== VISION.model) logEvent('warn', 'vision.model_mismatch', { configured: env.visionModel, expected: VISION.model });
  return env.visionEnabled && env.visionModel === VISION.model && env.anthropicApiKey !== null;
}

/** The instruction the model sees. Generated from the taxonomy so a new sub-type is one edit in taxonomy.ts. */
export function visionSystemPrompt(): string {
  const options = SUBTYPE_IDS.map((id) => `- ${id} (${SUBTYPES[id].category}): ${SUBTYPES[id].label}`);
  return [
    'You are the photo-analysis step of RootCause, a civic app where residents of New Brunswick, New Jersey report physical hazards on public property: sidewalks, roads, storm drains, street lights and city trees.',
    'Look at the photo and classify what it shows into exactly one of these sub-types (id (category): meaning):',
    ...options,
    'Rules:',
    '- If no listed hazard is clearly visible, set hazard_visible to false, leave category and subtype null and keep confidence low.',
    '- confidence is your calibrated probability, 0 to 1, that the sub-type is right. Be honest: a confident wrong answer sends a crew on a wasted trip.',
    '- severity_band is how dangerous it looks right now: 1 = annoying (cosmetic, no trip or fall risk), 2 = risky (someone could trip or be hurt), 3 = someone will fall (a clear step or hole in a walkway, a cracked limb hanging over it, a dark crossing). Never 4. Never estimate a measurement in millimetres or inches, in any field.',
    '- species_guess: for trees and plants only, a common or Latin name; otherwise null. Never confirm giant hogweed or poison hemlock from a photo: write "possible" in notes and keep species_confidence at or below 0.6.',
    '- notes: one plain sentence for the repair crew, at most 160 characters, about the hazard and its surroundings only. Never describe people, faces, licence plates or the inside of homes.',
    '- Night, glare, snow or leaf cover make severity unreliable: lower severity_confidence and say why in notes.',
  ].join('\n');
}

/** A probability, or null when the model answered off the 0–1 scale (a percent, a stray integer): such an answer is not calibrated. */
function probability(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/**
 * From the model's answer to the app's proposal. Pure, so the rules are unit-tested without a model: anything short
 * of a clean, confident, visible hazard is "unclear"; the sub-type decides the category; bands clamp to 1–3; a
 * hazardous-plant claim loses its species and gains a staff-confirmation note.
 */
export function interpretVisionOutput(out: VisionOutput | null, stopReason: string | null): { proposals: VisionProposal | null; reason: 'ok' | 'unclear' } {
  if (!out || stopReason !== 'end_turn') return { proposals: null, reason: 'unclear' };
  if (!out.hazard_visible || !out.subtype) return { proposals: null, reason: 'unclear' };
  const confidence = probability(out.confidence);
  if (confidence === null || confidence < VISION.confidenceFloor) return { proposals: null, reason: 'unclear' };
  const subtype = out.subtype;
  const category: Category = subtypeDef(subtype).category;
  const rawBand = out.severity_band;
  const severityBand: 1 | 2 | 3 | null = rawBand === null || rawBand < 1 ? null : rawBand >= 3 ? 3 : (rawBand as 1 | 2);
  const severityConfidence = severityBand === null ? null : (probability(out.severity_confidence) ?? 0);
  let speciesGuess = out.species_guess?.trim() || null;
  let speciesConfidence = speciesGuess ? (probability(out.species_confidence) ?? 0) : null;
  let notes = out.notes?.trim().slice(0, NOTES_MAX) || null;
  if ((speciesGuess && HAZARDOUS_TAXA.test(speciesGuess)) || (notes && HAZARDOUS_TAXA.test(notes))) {
    speciesGuess = null;
    speciesConfidence = null;
    notes = `Possible hazardous plant — needs confirmation by city staff before anyone acts on it.${notes ? ` ${notes}` : ''}`.slice(0, NOTES_MAX);
  }
  return { proposals: { category, subtype, confidence, severityBand, severityConfidence, speciesGuess, speciesConfidence, notes }, reason: 'ok' };
}

/** Base64 without Buffer (workerd and Node alike), in slices so a 600 KB photo never blows the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  return btoa(binary);
}

/** One model call. Never throws: every failure is a reason the route and S-05 can show. */
export async function analyzePhoto(input: AnalyzePhotoInput): Promise<AnalyzePhotoResult> {
  const model = VISION.model;
  const hint = input.subtypeHint ? `The resident's own pick before analysis: ${input.subtypeHint} (${subtypeDef(input.subtypeHint).label}). Weigh it, but answer from the photo.\n` : '';
  const started = Date.now();
  try {
    const response = await visionClient().parse({
      model,
      max_tokens: VISION.maxTokens,
      system: visionSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: toBase64(input.bytes) } },
            { type: 'text', text: `${hint}Classify the photo.` },
          ],
        },
      ],
      output_config: { format: OUTPUT_FORMAT },
    });
    const stop = response.stop_reason;
    const parsed = stop === 'end_turn' ? (response.parsed_output ?? null) : null;
    const { proposals, reason } = interpretVisionOutput(parsed, stop);
    const usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
    // usage_in / usage_out: the log redactor masks any field named *token*, and these are counts, not secrets.
    logEvent('info', 'vision.analyzed', { model: response.model, stop_reason: stop, reason, ms: Date.now() - started, usage_in: usage.input_tokens, usage_out: usage.output_tokens });
    // The raw answer stays on the audit record when it could not be parsed (spec §6 "raw model output kept for audit").
    const rawText = parsed === null ? (response.content?.find((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')?.text.slice(0, 2000) ?? null) : null;
    return { proposals, reason, model, audit: { model: response.model, stop_reason: stop, usage, output: parsed, raw: rawText, reason, at: new Date().toISOString() } };
  } catch (e) {
    const reason: VisionReason = e instanceof Anthropic.APIConnectionTimeoutError ? 'timeout' : 'error';
    const status = e instanceof Anthropic.APIError ? (e.status ?? null) : null;
    const message = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    logEvent(reason === 'timeout' ? 'warn' : 'error', 'vision.failed', { reason, status, ms: Date.now() - started, message });
    return { proposals: null, reason, model, audit: { model, reason, status, message, at: new Date().toISOString() } };
  }
}

/**
 * Label store (spec 4.1 "every correction is a training label", plan §3.6): when a report is created with an analysed
 * photo and the resident's final category / sub-type differ from what the model answered — confident or not — a
 * vision_feedback row keeps both. Anonymous reports carry no user id (plan §23.D). Never throws.
 */
export async function recordCorrection(photos: PhotosRepo, args: { photoId: string; reportId: string; category: Category; subtype: Subtype; userId: string | null; now: string }): Promise<boolean> {
  try {
    const analysis = await photos.analysisOf(args.photoId);
    const output = analysis?.ai_json?.output as Partial<VisionOutput> | null | undefined;
    if (!output || typeof output !== 'object') return false;
    const proposedSubtype = typeof output.subtype === 'string' && (SUBTYPE_IDS as readonly string[]).includes(output.subtype) ? (output.subtype as Subtype) : null;
    // The proposal the resident saw derives its category from the sub-type (interpretVisionOutput), so only the sub-type can be corrected.
    const proposedCategory: Category | null = proposedSubtype ? subtypeDef(proposedSubtype).category : typeof output.category === 'string' ? (output.category as Category) : null;
    if (proposedSubtype === args.subtype) return false;
    await photos.recordFeedback({
      photoId: args.photoId,
      reportId: args.reportId,
      proposed: { category: proposedCategory, subtype: proposedSubtype, confidence: typeof output.confidence === 'number' ? output.confidence : null },
      corrected: { category: args.category, subtype: args.subtype },
      userId: args.userId,
      modelVersion: analysis?.model_version ?? null,
      now: args.now,
    });
    return true;
  } catch (e) {
    logEvent('warn', 'vision.feedback_failed', { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return false;
  }
}
