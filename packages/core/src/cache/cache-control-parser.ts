export interface CacheControlDirectives {
  maxAge?: number;
  sMaxAge?: number;
  noCache: boolean;
  noStore: boolean;
  mustRevalidate: boolean;
  proxyRevalidate: boolean;
  public: boolean;
  private: boolean;
  immutable: boolean;
  staleWhileRevalidate?: number;
  staleIfError?: number;
}

const EMPTY_DIRECTIVES: CacheControlDirectives = {
  noCache: false,
  noStore: false,
  mustRevalidate: false,
  proxyRevalidate: false,
  public: false,
  private: false,
  immutable: false,
};

/**
 * Parse a numeric directive value. Returns undefined for non-finite
 * or negative values so callers can safely treat undefined as "absent".
 */
function parseSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Parse a Cache-Control header value into structured directives.
 *
 * Lenient: unrecognised directives are silently ignored, malformed
 * numeric values result in undefined (treated as absent).
 */
export function parseCacheControl(
  header: string | null | undefined,
): CacheControlDirectives {
  if (!header) return { ...EMPTY_DIRECTIVES };

  const result: CacheControlDirectives = { ...EMPTY_DIRECTIVES };

  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const eqIdx = trimmed.indexOf('=');
    const key = (eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx))
      .trim()
      .toLowerCase();
    const value = eqIdx === -1 ? undefined : trimmed.slice(eqIdx + 1).trim();

    switch (key) {
      case 'max-age':
        result.maxAge = parseSeconds(value);
        break;
      case 's-maxage':
        result.sMaxAge = parseSeconds(value);
        break;
      case 'no-cache':
        result.noCache = true;
        break;
      case 'no-store':
        result.noStore = true;
        break;
      case 'must-revalidate':
        result.mustRevalidate = true;
        break;
      case 'proxy-revalidate':
        result.proxyRevalidate = true;
        break;
      case 'public':
        result.public = true;
        break;
      case 'private':
        result.private = true;
        break;
      case 'immutable':
        result.immutable = true;
        break;
      case 'stale-while-revalidate':
        result.staleWhileRevalidate = parseSeconds(value);
        break;
      case 'stale-if-error':
        result.staleIfError = parseSeconds(value);
        break;
      // Unknown directives silently ignored
    }
  }

  return result;
}
