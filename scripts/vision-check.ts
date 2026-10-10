/**
 * Live check of src/server/vision.ts against the real Claude API (owner brief 2026-10-09: "verify Anthropic Vision
 * works for real"). Reads ANTHROPIC_API_KEY and the VISION_* switches from .env (server values only, never printed),
 * sends each JPEG given on the command line exactly as the analyze route would — the EXIF-stripped bytes, no hint
 * unless --hint <subtype> is given — and prints the proposal, the reason, the latency and the token usage.
 * Costs money (Haiku 4.5: about a cent per photo). Jest cannot do this: its environment mocks fetch.
 *
 *   npx tsx scripts/vision-check.ts path/to/photo.jpg [more.jpg …] [--hint root_heave]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SUBTYPE_IDS, type Subtype } from '../src/domain/taxonomy';
import { setLogSink } from '../src/server/log';
import { VISION, analyzePhoto, visionEnabled } from '../src/server/vision';

function loadDotenv(path: string): void {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  loadDotenv(join(process.cwd(), '.env'));
  const args = process.argv.slice(2);
  const hintIdx = args.indexOf('--hint');
  let hint: Subtype | undefined;
  if (hintIdx >= 0) {
    const v = args[hintIdx + 1];
    if (!SUBTYPE_IDS.includes(v as Subtype)) {
      console.error(`--hint must be one of ${SUBTYPE_IDS.join(', ')}`);
      process.exit(2);
    }
    hint = v as Subtype;
    args.splice(hintIdx, 2);
  }
  if (args.length === 0) {
    console.error('usage: npx tsx scripts/vision-check.ts <photo.jpg> [more.jpg …] [--hint <subtype>]');
    process.exit(2);
  }
  if (!visionEnabled()) {
    console.error(`Vision is off: needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, VISION_ENABLED=true and VISION_MODEL=${VISION.model} in .env.`);
    process.exit(1);
  }
  setLogSink((line) => process.stderr.write(`${line}\n`));
  let failures = 0;
  for (const path of args) {
    const bytes = new Uint8Array(readFileSync(path));
    const started = Date.now();
    const r = await analyzePhoto({ bytes, subtypeHint: hint });
    const audit = (r.audit ?? {}) as { usage?: unknown; status?: unknown; message?: unknown; stop_reason?: unknown; model?: unknown };
    console.log(JSON.stringify({ photo: path.split('/').pop(), bytes: bytes.length, ms: Date.now() - started, reason: r.reason, model: audit.model ?? r.model, stop_reason: audit.stop_reason ?? null, proposals: r.proposals, usage: audit.usage ?? null, status: audit.status ?? null, message: audit.message ?? null }, null, 2));
    if (r.reason === 'error' || r.reason === 'timeout') failures++;
  }
  process.exit(failures ? 1 : 0);
}

void main();
