import type { CacheEntryMetadata } from './cache-entry.js';

export type FreshnessStatus =
  | 'fresh'
  | 'stale'
  | 'must-revalidate'
  | 'stale-while-revalidate'
  | 'stale-if-error'
  | 'no-cache';

/**
 * Calculate the freshness lifetime of a cache entry in seconds.
 *
 * Priority order for a private cache (RFC 9111 §4.2.2):
 *   1. max-age (s-maxage is ignored — shared-cache-only)
 *   2. Expires − Date
 *   3. Heuristic: 10% of (Date − Last-Modified)
 *   4. 0 (treat as immediately stale)
 */
export function calculateFreshnessLifetime(
  metadata: CacheEntryMetadata,
): number {
  const { cacheControl } = metadata;

  // 1. max-age
  if (cacheControl.maxAge !== undefined) {
    return cacheControl.maxAge;
  }

  // 2. Expires − Date
  if (metadata.expires !== undefined) {
    // Expires: 0 means already expired
    if (metadata.expires === 0) return 0;
    const delta = (metadata.expires - metadata.responseDate) / 1000;
    return Math.max(0, delta);
  }

  // 3. Heuristic: 10% of (Date − Last-Modified)
  if (metadata.lastModified) {
    const lastModMs = Date.parse(metadata.lastModified);
    if (Number.isFinite(lastModMs)) {
      const age = (metadata.responseDate - lastModMs) / 1000;
      if (age > 0) {
        return Math.floor(age * 0.1);
      }
    }
  }

  // 4. No freshness info — treat as immediately stale
  return 0;
}

/**
 * Calculate the current age of a cache entry in seconds.
 *
 * Per RFC 9111 §4.2.3:
 *   apparent_age        = max(0, response_time − date_value)
 *   corrected_age_value = age_value + response_delay
 *   corrected_initial   = max(apparent_age, corrected_age_value)
 *   resident_time       = now − response_time
 *   current_age         = corrected_initial + resident_time
 *
 * We approximate response_delay as 0 since we don't track request_time.
 * This is conservative (slightly underestimates age).
 */
export function calculateCurrentAge(
  metadata: CacheEntryMetadata,
  now?: number,
): number {
  const currentTime = now ?? Date.now();
  const responseTime = metadata.storedAt; // closest proxy for response_time

  // apparent_age = max(0, response_time − date_value) in seconds
  const apparentAge = Math.max(
    0,
    (responseTime - metadata.responseDate) / 1000,
  );

  // corrected_age_value = age_header + response_delay (response_delay ≈ 0)
  const correctedAgeValue = metadata.ageHeader;

  // corrected_initial_age = max(apparent_age, corrected_age_value)
  const correctedInitialAge = Math.max(apparentAge, correctedAgeValue);

  // resident_time = now − response_time (in seconds)
  const residentTime = (currentTime - responseTime) / 1000;

  return correctedInitialAge + residentTime;
}

/**
 * Determine the freshness status of a cache entry.
 *
 * Returns the most specific applicable status, used by HttpClient
 * to decide whether to serve from cache, revalidate, or re-fetch.
 */
export function getFreshnessStatus(
  metadata: CacheEntryMetadata,
  now?: number,
): FreshnessStatus {
  const { cacheControl } = metadata;

  // no-cache: always revalidate, even if "fresh" by age
  if (cacheControl.noCache) {
    return 'no-cache';
  }

  const freshnessLifetime = calculateFreshnessLifetime(metadata);
  const currentAge = calculateCurrentAge(metadata, now);

  // Still fresh
  if (freshnessLifetime > currentAge) {
    return 'fresh';
  }

  // Stale. Determine which stale state applies.
  const staleness = currentAge - freshnessLifetime;

  // must-revalidate: cannot serve stale under any circumstances
  if (cacheControl.mustRevalidate) {
    return 'must-revalidate';
  }

  // stale-while-revalidate: can serve stale if within the SWR window
  if (
    cacheControl.staleWhileRevalidate !== undefined &&
    staleness <= cacheControl.staleWhileRevalidate
  ) {
    return 'stale-while-revalidate';
  }

  // stale-if-error: can serve stale on error if within the SIE window
  if (
    cacheControl.staleIfError !== undefined &&
    staleness <= cacheControl.staleIfError
  ) {
    return 'stale-if-error';
  }

  return 'stale';
}

/**
 * Calculate the TTL to pass to CacheStore.set().
 *
 * This must be long enough to cover the freshness lifetime PLUS any
 * stale-serving windows (SWR, SIE), so the entry remains available
 * in the store during those windows.
 *
 * Falls back to defaultTTL when no cache headers provide a lifetime.
 */
export function calculateStoreTTL(
  metadata: CacheEntryMetadata,
  defaultTTL: number,
): number {
  const freshness = calculateFreshnessLifetime(metadata);

  // If no cache headers gave us a freshness lifetime, use the default
  if (freshness === 0 && metadata.cacheControl.maxAge === undefined) {
    // No explicit freshness info and heuristic returned 0.
    // Use defaultTTL so the entry doesn't expire immediately.
    return defaultTTL;
  }

  // Add stale-serving windows so the store doesn't evict entries
  // that are still serveable under SWR or SIE.
  const swrWindow = metadata.cacheControl.staleWhileRevalidate ?? 0;
  const sieWindow = metadata.cacheControl.staleIfError ?? 0;
  const staleWindow = Math.max(swrWindow, sieWindow);

  return freshness + staleWindow;
}
