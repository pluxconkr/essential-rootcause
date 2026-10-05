/**
 * Production repos bundle over one service-role client (plan §3.1). Built by getRepos() per request/isolate;
 * nothing here caches rows (workerd keeps no memory between requests, plan §3.10). Server-only module.
 */
import type { ServiceClient } from '../../db';
import type { ReposWithPhotos } from '../photos';
import { SupabaseHealthRepo, SupabaseJobsRepo } from './health';
import { SupabasePhotosRepo } from './photos';
import { SupabaseReportsRepo } from './reports';
import { SupabaseUsersRepo } from './users';

export { SupabaseHealthRepo, SupabaseJobsRepo, SupabasePhotosRepo, SupabaseReportsRepo, SupabaseUsersRepo };

export function createSupabaseRepos(client: ServiceClient): ReposWithPhotos {
  const users = new SupabaseUsersRepo(client);
  return { users, reports: new SupabaseReportsRepo(client, users), health: new SupabaseHealthRepo(client), jobs: new SupabaseJobsRepo(client), photos: new SupabasePhotosRepo(client, users) };
}
