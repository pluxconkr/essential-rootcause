/**
 * Fire the storm demo against a real project (plan §9.5 demo `storm`; spec 4.2): inserts one synthetic
 * weather_forecast row — 52 mm in the 6 h from the demo's 9:30 PM onset (an hourly series in its payload, so the
 * briefing's window is the storm's), 84 % chance, gusts 40 km/h, valid tonight, labelled demo in its payload — then
 * runs the scenario evaluation and one push dispatch exactly as the job tick would, and prints the alert id and the
 * audience count. Server-side only: needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (and
 * EXPO_ACCESS_TOKEN for the push leg, optional). The rain scenario's 12 h cooldown applies: a second run the same
 * evening reports "cooldown" instead of a second alert.
 *
 *   npx tsx scripts/demo-storm.ts
 */
import { DEMO_STORM_FORECAST, demoStormWindow } from '../src/domain/alerts';
import { TICK_DEADLINE_MS } from '../src/server/jobs/tick';
import { dispatchQueuedPushes } from '../src/server/jobs/alertDispatch';
import { evaluateScenarios } from '../src/server/jobs/scenarioEval';
import { getAlertsRepo } from '../src/server/repos/alerts';

const HOUR_MS = 3_600_000;

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server env only).');
    process.exit(2);
  }
  const now = Date.now();
  const repo = getAlertsRepo();
  // Hourly buckets from the poll instant (bucket i = now + i h): the 52 mm sit in the six hours nearest the demo onset.
  const onsetBucket = Math.round((Date.parse(demoStormWindow(now).validFrom) - now) / HOUR_MS);
  const rainMmByHour = Array.from({ length: 24 }, (_, i) => (i >= onsetBucket && i < onsetBucket + 6 ? DEMO_STORM_FORECAST.rainMm6h / 6 : 0));
  const forecast = await repo.saveForecast({
    issued_at: new Date(now).toISOString(),
    valid_from: new Date(now).toISOString(),
    valid_to: new Date(now + 24 * HOUR_MS).toISOString(),
    grid_id: 'demo',
    rain_mm: DEMO_STORM_FORECAST.rainMm6h,
    pop_pct: DEMO_STORM_FORECAST.popPct,
    gust_kmh: DEMO_STORM_FORECAST.gustKmh,
    temp_min: null,
    temp_max: null,
    payload: { demo: true, note: 'inserted by scripts/demo-storm.ts', rainMmByHour },
  });
  console.log(`forecast ${forecast.id}: ${forecast.rain_mm} mm / 6 h, pop ${forecast.pop_pct} %, gusts ${forecast.gust_kmh} km/h (demo)`);
  const ctx = { now, deadline: now + TICK_DEADLINE_MS, requestId: 'demo-storm' };
  const outcome = await evaluateScenarios(ctx, { repo });
  if (outcome.fired.length === 0) {
    console.log(`nothing fired: ${outcome.note}`);
    return;
  }
  for (const f of outcome.fired) console.log(`alert ${f.alertId} (${f.kind}, run ${f.runId}): ${f.hazards} hazards, audience ${f.audience}, ${f.deliveries} deliveries queued`);
  const sent = await dispatchQueuedPushes(ctx, { repo });
  console.log(`push: sent ${sent.sent}, failed ${sent.failed}, no device ${sent.noDevice}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
