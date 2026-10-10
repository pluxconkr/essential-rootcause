/**
 * Memory repos bundle for tests and the dev server (plan §14 route tests run every +api.ts against repos/memory/*).
 * Never used in production: getRepos() fails closed instead (plan §3.10). Server-only module.
 */
import { MemoryJobsStore } from '../jobs';
import type { Repos, UserRow } from '../types';
import { MemoryAlertsRepo } from './alerts';
import { MemoryEngagementRepo } from './engagement';
import { MemoryHealthRepo, MemoryJobsRepo, type MemoryHealthState } from './health';
import { MemoryLifecycleRepo } from './lifecycle';
import { MemoryMeRepo } from './me';
import { MemoryPhotosRepo } from './photos';
import { MemoryReportsRepo } from './reports';
import { MemorySmsRepo } from './smsStatus';
import { MemoryUsersRepo } from './users';

export { MemoryAlertsRepo, MemoryEngagementRepo, MemoryHealthRepo, MemoryJobsRepo, MemoryLifecycleRepo, MemoryMeRepo, MemoryPhotosRepo, MemoryReportsRepo, MemorySmsRepo, MemoryUsersRepo };

export interface MemoryRepos extends Repos {
  users: MemoryUsersRepo;
  reports: MemoryReportsRepo;
  health: MemoryHealthRepo;
  jobs: MemoryJobsRepo;
  /** Photo objects and pending rows (src/server/repos/photos.ts); read by getPhotosRepo(). */
  photos: MemoryPhotosRepo;
  /** Status moves, verdicts and severity audits over the same report rows (src/server/repos/lifecycle.ts); read by getLifecycleRepo(). */
  lifecycle: MemoryLifecycleRepo;
  /** Forecasts, scenarios, alerts and deliveries over the same report rows (src/server/repos/alerts.ts); read by getAlertsRepo(). */
  alerts: MemoryAlertsRepo;
  /** Profile, stats, watch areas, devices (src/server/repos/me.ts); read by getMeRepo() in the dev-memory server. */
  me: MemoryMeRepo;
  /** Votes, follows, comments, flags (src/server/repos/engagement.ts); read by getEngagementRepo() in the dev-memory server. */
  engagement: MemoryEngagementRepo;
  /** sms_message claim rows and the tenant switch (src/server/repos/sms.ts); read by getSmsRepo() in the dev-memory server. */
  sms: MemorySmsRepo;
  /** The jobs' cursor store over the same rows (src/server/repos/jobs.ts); read by getJobsStore() in the dev-memory server. */
  jobsStore: MemoryJobsStore;
}

export function createMemoryRepos(opts: { users?: readonly UserRow[]; health?: MemoryHealthState; jobs?: Record<string, string | null> } = {}): MemoryRepos {
  const users = new MemoryUsersRepo(opts.users);
  const photos = new MemoryPhotosRepo();
  const reports = new MemoryReportsRepo(users, photos);
  const lifecycle = new MemoryLifecycleRepo(reports);
  const bundle = {
    users,
    reports,
    health: new MemoryHealthRepo(opts.health),
    jobs: new MemoryJobsRepo(opts.jobs),
    photos,
    lifecycle,
    alerts: new MemoryAlertsRepo(users, reports),
    engagement: new MemoryEngagementRepo(users, reports),
    sms: new MemorySmsRepo(),
    jobsStore: new MemoryJobsStore(reports, () => lifecycle.verifications),
  } as MemoryRepos;
  bundle.me = new MemoryMeRepo(bundle);
  return bundle;
}
