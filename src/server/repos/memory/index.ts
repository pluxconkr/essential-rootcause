/**
 * Memory repos bundle for tests and the dev server (plan §14 route tests run every +api.ts against repos/memory/*).
 * Never used in production: getRepos() fails closed instead (plan §3.10). Server-only module.
 */
import type { Repos, UserRow } from '../types';
import { MemoryHealthRepo, MemoryJobsRepo, type MemoryHealthState } from './health';
import { MemoryReportsRepo } from './reports';
import { MemoryUsersRepo } from './users';

export { MemoryHealthRepo, MemoryJobsRepo, MemoryReportsRepo, MemoryUsersRepo };

export interface MemoryRepos extends Repos {
  users: MemoryUsersRepo;
  reports: MemoryReportsRepo;
  health: MemoryHealthRepo;
  jobs: MemoryJobsRepo;
}

export function createMemoryRepos(opts: { users?: readonly UserRow[]; health?: MemoryHealthState; jobs?: Record<string, string | null> } = {}): MemoryRepos {
  const users = new MemoryUsersRepo(opts.users);
  return { users, reports: new MemoryReportsRepo(users), health: new MemoryHealthRepo(opts.health), jobs: new MemoryJobsRepo(opts.jobs) };
}
