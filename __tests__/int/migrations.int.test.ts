/**
 * Integration placeholder (plan §14 "Integration (Docker, in CI)"): runs only when SUPABASE_DB_URL points at the
 * local `supabase start` database (CI job `integration`); skipped everywhere else so `npm test` stays hermetic.
 * TODO(M1): migrations apply; RPCs find_duplicates / reports_in_bbox / rate_limit_hit / usage_bytes exist; append-only
 * triggers raise on UPDATE/DELETE; RLS denies anon table reads; rate-limit RPC under concurrency; anonymous
 * unlinkability (AC19); auth.users → app_user trigger.
 */
const dbUrl = process.env.SUPABASE_DB_URL;
const describeWithDb = dbUrl ? describe : describe.skip;

describeWithDb('supabase migrations', () => {
  test('SUPABASE_DB_URL is a postgres URL for the local stack', () => {
    const u = new URL(dbUrl ?? '');
    expect(u.protocol).toMatch(/^postgres(ql)?:$/);
  });
});
