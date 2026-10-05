/**
 * POST /api/v1/reports/[id]/flag (plan §7 "resident · 10/d · moderation queue"). FlagInput {reason, note?} →
 * 201 {flagId, status: 'open'} as a content_flag row for the console's moderation queue (M3). Shared logic in
 * server/flags.ts. Expo Router API route: no React Native imports; never throws (withTiming).
 */
import { handleFlag } from '@/server/flags';
import { withTiming } from '@/server/http';

const handlePost = withTiming('POST /api/v1/reports/[id]/flag', (request, ctx) => handleFlag('report', request, ctx));

export async function POST(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePost(request, params);
}
