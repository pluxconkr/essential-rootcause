/**
 * Production repos bundle over one service-role client (plan §3.1). Built by getRepos() per request/isolate;
 * nothing here caches rows (workerd keeps no memory between requests, plan §3.10). Server-only module.
 */
import type { ServiceClient } from '../../db';
import type { Repos } from '../types';
import { SupabaseHealthRepo, SupabaseJobsRepo } from './health';
import { SupabaseReportsRepo } from './reports';
import { SupabaseUsersRepo } from './users';

export { SupabaseHealthRepo, SupabaseJobsRepo, SupabaseReportsRepo, SupabaseUsersRepo };

export function createSupabaseRepos(client: ServiceClient): Repos {
  const users = new SupabaseUsersRepo(client);
  return { users, reports: new SupabaseReportsRepo(client, users), health: new SupabaseHealthRepo(client), jobs: new SupabaseJobsRepo(client) };
}
