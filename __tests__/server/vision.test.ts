/**
 * src/server/vision.ts without a network: the interpretation rules (spec §8 guardrails, plan §3.6/§23.I) — confidence
 * floor → unclear, the sub-type decides the category, bands clamp to 1–3, a hazardous-plant claim loses its species
 * and gains a staff-confirmation note, anything but end_turn is unclear — then analyzePhoto() with a fake SDK client:
 * ok / unclear / timeout / error outcomes, the audit record, and the request shape (structured output, image first,
 * hint in the text, no thinking). The prompt lists every taxonomy sub-type so a new one needs no prompt edit.
 */
import Anthropic from '@anthropic-ai/sdk';

import { CATEGORIES, SUBTYPE_IDS } from '@/domain/taxonomy';
import { setLogSink } from '@/server/log';
import { VISION, analyzePhoto, interpretVisionOutput, setVisionClient, toBase64, visionEnabled, visionOutputFormat, visionSystemPrompt, type VisionClient, type VisionOutput } from '@/server/vision';

const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const answer = (over: Partial<VisionOutput> = {}): VisionOutput => ({
  hazard_visible: true,
  category: 'vegetation',
  subtype: 'root_heave',
  confidence: 0.91,
  severity_band: 3,
  severity_confidence: 0.8,
  species_guess: 'Silver maple',
  species_confidence: 0.75,
  notes: 'Panel lifted by a root at the curb side.',
  ...over,
});

beforeAll(() => setLogSink(() => {}));
afterAll(() => setLogSink(null));
afterEach(() => setVisionClient(null));

describe('interpretVisionOutput', () => {
  test('a confident visible hazard becomes a proposal; the sub-type decides the category', () => {
    const r = interpretVisionOutput(answer({ category: 'roadway' }), 'end_turn');
    expect(r.reason).toBe('ok');
    expect(r.proposals).toMatchObject({ category: 'vegetation', subtype: 'root_heave', confidence: 0.91, severityBand: 3, severityConfidence: 0.8, speciesGuess: 'Silver maple', speciesConfidence: 0.75 });
  });

  test('below the floor, no hazard, no sub-type, or a stop reason other than end_turn → unclear', () => {
    expect(interpretVisionOutput(answer({ confidence: VISION.confidenceFloor - 0.01 }), 'end_turn')).toEqual({ proposals: null, reason: 'unclear' });
    expect(interpretVisionOutput(answer({ hazard_visible: false }), 'end_turn').proposals).toBeNull();
    expect(interpretVisionOutput(answer({ subtype: null }), 'end_turn').proposals).toBeNull();
    expect(interpretVisionOutput(answer(), 'max_tokens').proposals).toBeNull();
    expect(interpretVisionOutput(answer(), 'refusal').proposals).toBeNull();
    expect(interpretVisionOutput(null, 'end_turn').proposals).toBeNull();
  });

  test('bands clamp to 1–3 and never carry a measurement; a confidence off the 0–1 scale is uncalibrated, never a 100 % proposal', () => {
    expect(interpretVisionOutput(answer({ severity_band: 4, severity_confidence: 1.7 }), 'end_turn').proposals).toMatchObject({ severityBand: 3, severityConfidence: 0 });
    expect(interpretVisionOutput(answer({ severity_band: 0 }), 'end_turn').proposals).toMatchObject({ severityBand: null, severityConfidence: null });
    expect(interpretVisionOutput(answer({ confidence: 7 }), 'end_turn')).toEqual({ proposals: null, reason: 'unclear' });
    expect(interpretVisionOutput(answer({ confidence: 85 }), 'end_turn')).toEqual({ proposals: null, reason: 'unclear' });
    expect(interpretVisionOutput(answer({ confidence: -0.2 }), 'end_turn')).toEqual({ proposals: null, reason: 'unclear' });
    expect(interpretVisionOutput(answer({ species_confidence: 3 }), 'end_turn').proposals).toMatchObject({ speciesGuess: 'Silver maple', speciesConfidence: 0 });
  });

  test('the output format carries the taxonomy as grammar and its parse never throws', () => {
    const format = visionOutputFormat() as unknown as { schema: { properties: Record<string, { anyOf?: { type?: string; enum?: string[]; description?: string }[] }> }; parse: (text: string) => VisionOutput | null };
    const subtype = format.schema.properties.subtype.anyOf?.find((v) => v.type === 'string');
    const category = format.schema.properties.category.anyOf?.find((v) => v.type === 'string');
    expect(subtype?.enum).toEqual([...SUBTYPE_IDS]);
    expect(category?.enum).toEqual([...CATEGORIES]);
    expect(subtype?.description).toBeUndefined();
    const good = JSON.stringify(answer());
    expect(format.parse(good)).toMatchObject({ subtype: 'root_heave' });
    expect(format.parse(JSON.stringify(answer({ subtype: 'Root_Heave' as never, category: 'VEGETATION' as never })))).toMatchObject({ subtype: 'root_heave', category: 'vegetation' });
    expect(format.parse(JSON.stringify({ ...answer(), subtype: 'cracked_sidewalk' }))).toBeNull();
    expect(format.parse('{"hazard_visible": true, "cat')).toBeNull();
  });

  test('a hazardous plant is never auto-confirmed: species dropped, staff-confirmation note added', () => {
    const r = interpretVisionOutput(answer({ subtype: 'toxic_plant', species_guess: 'Giant hogweed', species_confidence: 0.9, notes: 'Tall umbels by the fence.' }), 'end_turn');
    expect(r.proposals).toMatchObject({ subtype: 'toxic_plant', speciesGuess: null, speciesConfidence: null });
    expect(r.proposals?.notes).toMatch(/^Possible hazardous plant — needs confirmation by city staff/);
    expect(r.proposals?.notes).toContain('Tall umbels');
    const viaNotes = interpretVisionOutput(answer({ species_guess: null, notes: 'Looks like poison hemlock.' }), 'end_turn');
    expect(viaNotes.proposals?.notes).toMatch(/^Possible hazardous plant/);
  });

  test('the prompt names every taxonomy sub-type and forbids measurements', () => {
    const prompt = visionSystemPrompt();
    for (const id of SUBTYPE_IDS) expect(prompt).toContain(`- ${id} (`);
    expect(prompt).toMatch(/Never estimate a measurement/);
    expect(prompt).toMatch(/hogweed/);
  });

  test('toBase64 matches Buffer for small and multi-chunk inputs', () => {
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    const big = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(toBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});

describe('analyzePhoto with a fake client', () => {
  type ParseArgs = Parameters<VisionClient['parse']>[0];
  function fake(impl: (args: ParseArgs) => Promise<unknown>): { calls: ParseArgs[] } {
    const calls: ParseArgs[] = [];
    setVisionClient({
      parse: (async (args: ParseArgs) => {
        calls.push(args);
        return impl(args);
      }) as unknown as VisionClient['parse'],
    });
    return { calls };
  }
  const reply = (over: Record<string, unknown> = {}) => ({ model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', parsed_output: answer(), usage: { input_tokens: 1500, output_tokens: 90 }, ...over });

  test('an injected client switches the feature on and a confident answer comes back as a proposal with an audit record', async () => {
    expect(visionEnabled()).toBe(false);
    const { calls } = fake(async () => reply());
    expect(visionEnabled()).toBe(true);
    const r = await analyzePhoto({ bytes, subtypeHint: 'uneven_sidewalk' });
    expect(r.reason).toBe('ok');
    expect(r.proposals).toMatchObject({ category: 'vegetation', subtype: 'root_heave', confidence: 0.91 });
    expect(r.model).toBe(VISION.model);
    expect(r.audit).toMatchObject({ model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 90 }, reason: 'ok' });
    expect((r.audit as { output: VisionOutput }).output.subtype).toBe('root_heave');
    // Request shape: Haiku, structured output, no thinking / effort, image first then the text with the hint.
    const args = calls[0] as unknown as Record<string, unknown> & { messages: { role: string; content: { type: string; text?: string; source?: { media_type: string; data: string } }[] }[] };
    expect(args.model).toBe('claude-haiku-4-5');
    expect(args.max_tokens).toBe(VISION.maxTokens);
    expect(args).not.toHaveProperty('thinking');
    expect(args.output_config).toBeTruthy();
    expect(typeof args.system).toBe('string');
    const content = args.messages[0].content;
    expect(content[0].type).toBe('image');
    expect(content[0].source).toMatchObject({ media_type: 'image/jpeg', data: toBase64(bytes) });
    expect(content[1].text).toContain('uneven_sidewalk');
  });

  test('a low-confidence or cut-off answer is unclear, with the raw answer still kept for audit', async () => {
    fake(async () => reply({ parsed_output: answer({ confidence: 0.4 }) }));
    const low = await analyzePhoto({ bytes });
    expect(low).toMatchObject({ proposals: null, reason: 'unclear' });
    expect((low.audit as { output: VisionOutput }).output.confidence).toBe(0.4);
    fake(async () => reply({ stop_reason: 'max_tokens', parsed_output: null }));
    expect((await analyzePhoto({ bytes })).reason).toBe('unclear');
    // An answer the schema rejected: parsed_output is null (the format's parse never throws) and the raw text is kept for audit.
    fake(async () => reply({ parsed_output: null, content: [{ type: 'text', text: '{"hazard_visible":true,"subtype":"cracked_sidewalk"}' }] }));
    const rejected = await analyzePhoto({ bytes });
    expect(rejected.reason).toBe('unclear');
    expect(rejected.audit).toMatchObject({ output: null, raw: '{"hazard_visible":true,"subtype":"cracked_sidewalk"}' });
  });

  test('a timeout is reported as timeout, any other SDK error as error; nothing throws', async () => {
    fake(async () => {
      throw new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out.' });
    });
    const t = await analyzePhoto({ bytes });
    expect(t).toMatchObject({ proposals: null, reason: 'timeout' });
    fake(async () => {
      throw new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers());
    });
    const e = await analyzePhoto({ bytes });
    expect(e).toMatchObject({ proposals: null, reason: 'error' });
    expect(e.audit).toMatchObject({ status: 429 });
    fake(async () => {
      throw new Error('socket hang up');
    });
    expect((await analyzePhoto({ bytes })).reason).toBe('error');
  });
});
