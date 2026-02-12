import {
  parseCacheControl,
  type CacheControlDirectives,
} from './cache-control-parser.js';

export interface CacheEntryMetadata {
  /** ETag response header, for If-None-Match conditional requests */
  etag?: string;
  /** Last-Modified response header, for If-Modified-Since conditional requests */
  lastModified?: string;
  /** Parsed Cache-Control directives */
  cacheControl: CacheControlDirectives;
  /**
   * Date response header as epoch ms.
   * Falls back to storedAt if the server didn't send Date.
   */
  responseDate: number;
  /** Epoch ms when this entry was written to the cache */
  storedAt: number;
  /** Value of the Age response header at receipt time (seconds) */
  ageHeader: number;
  /** Raw Vary header value (e.g. "Accept, Accept-Encoding") */
  varyHeaders?: string;
  /** Captured request header values for Vary matching */
  varyValues?: Record<string, string | undefined>;
  /** HTTP status code of the original response */
  statusCode: number;
  /**
   * Expires header as epoch ms. Used as freshness fallback
   * when Cache-Control max-age is absent.
   */
  expires?: number;
}

export interface CacheEntry<T = unknown> {
  /** Discriminant field for the isCacheEntry type guard */
  __cacheEntry: true;
  /** The actual response value the caller requested */
  value: T;
  /** RFC 9111 metadata for freshness/revalidation decisions */
  metadata: CacheEntryMetadata;
}

/**
 * Type guard: distinguishes a CacheEntry envelope from a raw cached value.
 */
export function isCacheEntry<T>(value: unknown): value is CacheEntry<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).__cacheEntry === true &&
    'value' in value &&
    'metadata' in value
  );
}

/**
 * Parse an HTTP-date string (RFC 7231) into epoch ms.
 * Returns undefined if the value is missing or unparseable.
 *
 * Handles:
 * - IMF-fixdate: "Sun, 06 Nov 1994 08:49:37 GMT"
 * - RFC 850: "Sunday, 06-Nov-94 08:49:37 GMT"
 * - asctime: "Sun Nov  6 08:49:37 1994"
 * - "0" (treated as already-expired per Expires spec)
 */
export function parseHttpDate(
  value: string | null | undefined,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Expires: 0 means "already expired" per RFC 9111 §5.3
  if (trimmed === '0') return 0;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Create a CacheEntry from a response value and the HTTP response headers.
 *
 * Call this after response body parsing + transformation + validation,
 * right before storing in the cache.
 */
export function createCacheEntry<T>(
  value: T,
  headers: Headers,
  statusCode: number,
): CacheEntry<T> {
  const now = Date.now();
  const dateMs = parseHttpDate(headers.get('date')) ?? now;
  const ageRaw = headers.get('age');
  const ageHeader =
    ageRaw !== null ? Number.parseInt(ageRaw.trim(), 10) || 0 : 0;

  return {
    __cacheEntry: true,
    value,
    metadata: {
      etag: headers.get('etag') ?? undefined,
      lastModified: headers.get('last-modified') ?? undefined,
      cacheControl: parseCacheControl(headers.get('cache-control')),
      responseDate: dateMs,
      storedAt: now,
      ageHeader,
      varyHeaders: headers.get('vary') ?? undefined,
      statusCode,
      expires: parseHttpDate(headers.get('expires')),
    },
  };
}

/**
 * Refresh a cache entry after receiving a 304 Not Modified response.
 *
 * Updates metadata from the 304 response headers while keeping the
 * existing cached value (body). Per RFC 9111 §4.3.4, the 304 response
 * headers replace the stored headers.
 */
export function refreshCacheEntry<T>(
  existing: CacheEntry<T>,
  newHeaders: Headers,
): CacheEntry<T> {
  const now = Date.now();
  const dateMs = parseHttpDate(newHeaders.get('date')) ?? now;
  const ageRaw = newHeaders.get('age');
  const ageHeader =
    ageRaw !== null ? Number.parseInt(ageRaw.trim(), 10) || 0 : 0;

  // 304 can carry updated Cache-Control, ETag, Expires, Date, Vary.
  // Fields not present in the 304 keep their existing values.
  const newCacheControl = newHeaders.get('cache-control');
  const newEtag = newHeaders.get('etag');
  const newLastModified = newHeaders.get('last-modified');
  const newExpires = newHeaders.get('expires');
  const newVary = newHeaders.get('vary');

  return {
    __cacheEntry: true,
    value: existing.value,
    metadata: {
      ...existing.metadata,
      cacheControl: newCacheControl
        ? parseCacheControl(newCacheControl)
        : existing.metadata.cacheControl,
      etag: newEtag ?? existing.metadata.etag,
      lastModified: newLastModified ?? existing.metadata.lastModified,
      responseDate: dateMs,
      storedAt: now,
      ageHeader,
      expires:
        newExpires !== null
          ? parseHttpDate(newExpires)
          : existing.metadata.expires,
      varyHeaders: newVary ?? existing.metadata.varyHeaders,
      // statusCode stays the same (the original 200, not 304)
    },
  };
}
