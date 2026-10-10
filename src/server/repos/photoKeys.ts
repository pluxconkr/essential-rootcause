/**
 * Storage object keys for a photo (private bucket `photos`): <tenant>/<photoId>/{full,thumb}.jpg. A leaf module with
 * no imports so repos/memory and repos/supabase can share it without a require cycle through repos/photos.ts.
 */
export function photoKeys(tenantId: string, photoId: string): { full: string; thumb: string } {
  return { full: `${tenantId}/${photoId}/full.jpg`, thumb: `${tenantId}/${photoId}/thumb.jpg` };
}
