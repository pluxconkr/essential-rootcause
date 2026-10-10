/**
 * End-to-end check of the API surface against a running dev server, with real Supabase Auth tokens (owner brief
 * 2026-10-09: "re-run the functional tests from start to finish"). It walks the resident flow the phone walks —
 * health → sign-in → photo upload → vision analysis → report → feed → vote / follow / comment → profile → watch area
 * → staff status change → resident verification → alerts inbox — and prints one line per step plus a summary.
 * Each step is tolerant of routes that do not exist yet (404/501 are reported, not fatal), so the script is also the
 * progress gauge for the lifecycle work.
 *
 *   Terminal 1:  ROOTCAUSE_DEV_MEMORY=1 ROOTCAUSE_DEV_STAFF=rootcause.e2e.staff@example.com npx expo start --port 8081
 *   Terminal 2:  npx tsx scripts/e2e-check.ts [--api http://localhost:8081] [--photo path/to/hazard.jpg]
 *
 * Needs in .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (to create / reset the two test accounts through the Auth admin
 * API) and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY (to sign them in). The accounts are rootcause.e2e@example.com and
 * rootcause.e2e.staff@example.com with a fresh random password each run; nothing else is created on Supabase. With the
 * memory server the data lives in the dev server process only. Costs one vision call per run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
loadDotenv(join(process.cwd(), '.env'));

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const API = (flag('--api') ?? process.env.E2E_API_URL ?? 'http://localhost:8081').replace(/\/$/, '');
const PHOTO = flag('--photo') ?? '/private/tmp/claude-501/-Users-justiceserv-Codes-essential-congressional-apps-rootcause/59a73b6c-8cc6-431d-9649-f774dbc2a73e/scratchpad/photos/rootheave.small.jpg';
const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const PUBLISHABLE = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const RESIDENT_EMAIL = process.env.E2E_EMAIL ?? 'rootcause.e2e@example.com';
const STAFF_EMAIL = process.env.E2E_STAFF_EMAIL ?? 'rootcause.e2e.staff@example.com';
const CENTER = { lat: 40.4862, lng: -74.4518 }; // New Brunswick, NJ (src/domain/pilot.ts)

type Outcome = 'pass' | 'fail' | 'skip';
const results: { step: string; outcome: Outcome; note: string }[] = [];
function record(step: string, outcome: Outcome, note = ''): void {
  results.push({ step, outcome, note });
  console.log(`${outcome === 'pass' ? 'PASS' : outcome === 'fail' ? 'FAIL' : 'SKIP'}  ${step}${note ? ` — ${note}` : ''}`);
}

async function call(path: string, init: { method?: string; token?: string | null; body?: unknown; form?: FormData } = {}): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const headers: Record<string, string> = { accept: 'application/json', 'x-install-id': 'e2e-check' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method: init.method ?? 'GET', headers, body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}
const errCode = (r: { json: Record<string, unknown> | null }): string => String((r.json?.error as { code?: string } | undefined)?.code ?? '');
const notBuilt = (r: { status: number; json: Record<string, unknown> | null }): boolean => r.status === 404 && errCode(r) === '' || r.status === 501;

async function adminUser(email: string, fullName: string): Promise<{ token: string } | null> {
  if (!SUPABASE_URL || !SERVICE || !PUBLISHABLE) return null;
  const admin = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' };
  const password = `E2e-${crypto.randomUUID()}`;
  const list = (await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`, { headers: admin }).then((r) => r.json())) as { users?: { id: string; email?: string }[] };
  const existing = (list.users ?? []).find((u) => u.email?.toLowerCase() === email);
  const res = existing
    ? await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${existing.id}`, { method: 'PUT', headers: admin, body: JSON.stringify({ password, email_confirm: true }) })
    : await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } }) });
  if (!res.ok) {
    console.error(`auth admin ${existing ? 'update' : 'create'} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const tok = (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: PUBLISHABLE, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())) as { access_token?: string; error_description?: string; msg?: string };
  if (!tok.access_token) {
    console.error(`password sign-in failed: ${tok.error_description ?? tok.msg ?? JSON.stringify(tok).slice(0, 200)}`);
    return null;
  }
  return { token: tok.access_token };
}

async function main(): Promise<void> {
  console.log(`API ${API}`);
  const health = await call('/api/health');
  record('GET /api/health', health.status === 200 || health.status === 503 ? 'pass' : 'fail', `${health.status} ${health.text.slice(0, 160)}`);

  const resident = await adminUser(RESIDENT_EMAIL, 'E2E Resident');
  const staff = await adminUser(STAFF_EMAIL, 'E2E Supervisor');
  record('Supabase Auth: resident + staff sessions', resident && staff ? 'pass' : 'fail', resident && staff ? 'tokens issued' : 'see errors above');
  if (!resident) return summary();
  const r = resident.token;
  const s = staff?.token ?? null;

  const me = await call('/api/v1/me', { token: r });
  record('GET /api/v1/me (resident)', me.status === 200 ? 'pass' : 'fail', `${me.status} role=${String((me.json as { role?: string } | null)?.role)}`);
  if (s) {
    const meStaff = await call('/api/v1/me', { token: s });
    const role = String((meStaff.json as { role?: string } | null)?.role);
    record('GET /api/v1/me (staff via ROOTCAUSE_DEV_STAFF)', meStaff.status === 200 && role === 'supervisor' ? 'pass' : 'fail', `${meStaff.status} role=${role} (dev server needs ROOTCAUSE_DEV_STAFF=${STAFF_EMAIL})`);
  }

  const bytes = readFileSync(PHOTO);
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'full.jpg');
  const up = await call('/api/v1/photos', { method: 'POST', token: r, form });
  const photoId = String((up.json as { photoId?: string } | null)?.photoId ?? '');
  record('POST /api/v1/photos', up.status === 201 && photoId ? 'pass' : 'fail', `${up.status} ${photoId || up.text.slice(0, 160)}`);

  let category = 'vegetation';
  let subtype = 'root_heave';
  if (photoId) {
    const an = await call('/api/v1/vision/analyze', { method: 'POST', token: r, body: { photoId, lat: CENTER.lat, lng: CENTER.lng } });
    const a = an.json as { reason?: string; proposals?: { category: string; subtype: string; confidence: number; severityBand: number | null } | null; exposure?: { pedsPerDay: number; roadName: string | null }; address?: string; adaRelevant?: boolean | null } | null;
    const ok = an.status === 200 && (a?.reason === 'ok' || a?.reason === 'unclear');
    record('POST /api/v1/vision/analyze (live Claude)', ok ? 'pass' : 'fail', `${an.status} reason=${a?.reason} proposal=${a?.proposals ? `${a.proposals.subtype}@${a.proposals.confidence} band ${a.proposals.severityBand}` : 'none'} exposure=${a?.exposure?.pedsPerDay}/day ${a?.exposure?.roadName ?? ''} address="${a?.address ?? ''}" ada=${a?.adaRelevant}`);
    if (a?.proposals) {
      category = a.proposals.category;
      subtype = a.proposals.subtype;
    }
  }

  const clientDraftId = `d_e2e_${Date.now().toString(36)}`;
  const input = { clientDraftId, category, subtype, severityResident: 2, injuryFlag: 'no', reporterDisplay: 'named', lat: CENTER.lat, lng: CENTER.lng, accuracyM: 8, locationConfirmed: true, addressText: '', photoIds: photoId ? [photoId] : [], capturedAt: new Date().toISOString(), note: 'E2E check — lifted panel by the curb' };
  const created = await call('/api/v1/reports', { method: 'POST', token: r, body: input });
  const report = (created.json as { report?: { id: string; score: number; status: string } } | null)?.report;
  record('POST /api/v1/reports', created.status === 201 && report ? 'pass' : 'fail', `${created.status} ${report ? `${report.id} score ${report.score} status ${report.status}` : created.text.slice(0, 200)}`);
  if (!report) return summary();
  const replay = await call('/api/v1/reports', { method: 'POST', token: r, body: input });
  record('POST /api/v1/reports replay (same clientDraftId)', replay.status === 200 ? 'pass' : 'fail', `${replay.status}`);

  const list = await call(`/api/v1/reports?bbox=${CENTER.lng - 0.05},${CENTER.lat - 0.05},${CENTER.lng + 0.05},${CENTER.lat + 0.05}&sort=score&limit=50`);
  const ids = ((list.json as { reports?: { id: string }[] } | null)?.reports ?? []).map((x) => x.id);
  record('GET /api/v1/reports?bbox (public feed)', list.status === 200 && ids.includes(report.id) ? 'pass' : 'fail', `${list.status} ${ids.length} reports`);
  const one = await call(`/api/v1/reports/${report.id}`);
  record('GET /api/v1/reports/:id (public)', one.status === 200 && !one.text.includes('reporter_id') ? 'pass' : 'fail', `${one.status}`);

  const vote = await call(`/api/v1/reports/${report.id}/votes`, { method: 'POST', token: r, body: { lat: CENTER.lat, lng: CENTER.lng } });
  record('POST /api/v1/reports/:id/votes', [200, 201, 409].includes(vote.status) ? 'pass' : 'fail', `${vote.status} ${vote.text.slice(0, 120)}`);
  const follow = await call(`/api/v1/reports/${report.id}/follow`, { method: 'POST', token: r });
  record('POST /api/v1/reports/:id/follow', [200, 201].includes(follow.status) ? 'pass' : 'fail', `${follow.status}`);
  const comment = await call(`/api/v1/reports/${report.id}/comments`, { method: 'POST', token: r, body: { body: 'Crew put a cone out this morning.' } });
  record('POST /api/v1/reports/:id/comments', [200, 201].includes(comment.status) ? 'pass' : 'fail', `${comment.status}`);
  const comments = await call(`/api/v1/reports/${report.id}/comments`);
  record('GET /api/v1/reports/:id/comments', comments.status === 200 ? 'pass' : 'fail', `${comments.status} ${comments.text.slice(0, 80)}`);

  const mine = await call('/api/v1/me/reports', { token: r });
  const mineIds = ((mine.json as { reports?: { id: string }[] } | null)?.reports ?? []).map((x) => x.id);
  record('GET /api/v1/me/reports', mine.status === 200 && mineIds.includes(report.id) ? 'pass' : 'fail', `${mine.status} ${mineIds.length}`);
  const exp = await call('/api/v1/me/export', { token: r });
  record('GET /api/v1/me/export', exp.status === 200 || exp.status === 429 ? 'pass' : 'fail', `${exp.status} ${exp.text.length} bytes`);
  const wa = await call('/api/v1/me/watch-areas', { method: 'POST', token: r, body: { kind: 'home', label: 'Home', lat: CENTER.lat, lng: CENTER.lng, radiusM: 400, categories: [], schedule: null } });
  record('POST /api/v1/me/watch-areas', [200, 201].includes(wa.status) ? 'pass' : 'fail', `${wa.status} ${wa.text.slice(0, 120)}`);

  // Lifecycle: staff moves the report; the resident verifies the fix.
  if (s) {
    const steps: { to: string; afterPhotoId?: string }[] = [{ to: 'triaged' }, { to: 'assessed' }, { to: 'scheduled' }];
    let last: { status: number; text: string; json: Record<string, unknown> | null } = { status: 0, text: '', json: null };
    for (const step of steps) {
      const res = await call(`/api/v1/reports/${report.id}`, { method: 'PATCH', token: s, body: { to: step.to, note: `E2E → ${step.to}` } });
      last = { status: res.status, text: res.text, json: res.json };
      if (res.status !== 200) break;
    }
    record('PATCH /api/v1/reports/:id ×3 (staff: triaged → assessed → scheduled)', last.status === 200 ? 'pass' : notBuilt(last) ? 'skip' : 'fail', `${last.status} ${last.text.slice(0, 160)}`);
    if (last.status === 200) {
      const after = new FormData();
      after.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'after.jpg');
      const upAfter = await call('/api/v1/photos', { method: 'POST', token: s, form: after });
      const afterId = String((upAfter.json as { photoId?: string } | null)?.photoId ?? '');
      const done = await call(`/api/v1/reports/${report.id}`, { method: 'PATCH', token: s, body: { to: 'completed', note: 'Panel replaced', afterPhotoId: afterId } });
      record('PATCH → completed with an after photo', done.status === 200 ? 'pass' : 'fail', `${done.status} ${done.text.slice(0, 160)}`);
      const resVerify = await call(`/api/v1/reports/${report.id}/verify`, { method: 'POST', token: r, body: { verdict: 'confirmed' } });
      record('POST /api/v1/reports/:id/verify (resident confirms)', resVerify.status === 200 || resVerify.status === 201 ? 'pass' : notBuilt(resVerify) ? 'skip' : 'fail', `${resVerify.status} ${resVerify.text.slice(0, 160)}`);
      const denied = await call(`/api/v1/reports/${report.id}`, { method: 'PATCH', token: r, body: { to: 'verified' } });
      record('PATCH as a resident is refused', denied.status === 403 ? 'pass' : notBuilt(denied) ? 'skip' : 'fail', `${denied.status}`);
    }
  }

  const alerts = await call('/api/v1/me/alerts', { token: r });
  record('GET /api/v1/me/alerts', alerts.status === 200 ? 'pass' : notBuilt(alerts) ? 'skip' : 'fail', `${alerts.status} ${alerts.text.slice(0, 120)}`);
  const phone = await call('/api/v1/me/phone', { method: 'POST', token: r, body: { phone: '+15555550100' } });
  record('POST /api/v1/me/phone (SMS off → disabled or validation)', [200, 201, 400, 503].includes(phone.status) ? 'pass' : notBuilt(phone) ? 'skip' : 'fail', `${phone.status} ${phone.text.slice(0, 120)}`);
  summary();
}

function summary(): void {
  const pass = results.filter((x) => x.outcome === 'pass').length;
  const fail = results.filter((x) => x.outcome === 'fail').length;
  const skip = results.filter((x) => x.outcome === 'skip').length;
  console.log(`\n${pass} passed · ${fail} failed · ${skip} skipped (not built yet)`);
  process.exit(fail ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
