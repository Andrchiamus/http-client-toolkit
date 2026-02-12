import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isCacheEntry,
  createCacheEntry,
  refreshCacheEntry,
  parseHttpDate,
  type CacheEntry,
} from './cache-entry.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseHttpDate', () => {
  it('returns undefined for null', () => {
    expect(parseHttpDate(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseHttpDate(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseHttpDate('')).toBeUndefined();
    expect(parseHttpDate('   ')).toBeUndefined();
  });

  it('returns 0 for "0" (already-expired)', () => {
    expect(parseHttpDate('0')).toBe(0);
  });

  it('parses IMF-fixdate format', () => {
    const ms = parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT');
    expect(ms).toBe(Date.parse('Sun, 06 Nov 1994 08:49:37 GMT'));
  });

  it('returns undefined for unparseable date', () => {
    expect(parseHttpDate('not-a-date')).toBeUndefined();
  });

  it('parses ISO 8601 dates', () => {
    const ms = parseHttpDate('2024-01-15T12:00:00Z');
    expect(ms).toBe(Date.parse('2024-01-15T12:00:00Z'));
  });
});

describe('isCacheEntry', () => {
  it('returns true for valid cache entries', () => {
    const entry: CacheEntry = {
      __cacheEntry: true,
      value: { id: 1 },
      metadata: {
        cacheControl: {
          noCache: false,
          noStore: false,
          mustRevalidate: false,
          proxyRevalidate: false,
          public: false,
          private: false,
          immutable: false,
        },
        responseDate: Date.now(),
        storedAt: Date.now(),
        ageHeader: 0,
        statusCode: 200,
      },
    };
    expect(isCacheEntry(entry)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isCacheEntry(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isCacheEntry(undefined)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isCacheEntry('string')).toBe(false);
    expect(isCacheEntry(42)).toBe(false);
    expect(isCacheEntry(true)).toBe(false);
  });

  it('returns false for plain objects (legacy cache values)', () => {
    expect(isCacheEntry({ id: 1, name: 'test' })).toBe(false);
  });

  it('returns false when __cacheEntry is not true', () => {
    expect(isCacheEntry({ __cacheEntry: false, value: {}, metadata: {} })).toBe(
      false,
    );
  });

  it('returns false when value is missing', () => {
    expect(isCacheEntry({ __cacheEntry: true, metadata: {} })).toBe(false);
  });

  it('returns false when metadata is missing', () => {
    expect(isCacheEntry({ __cacheEntry: true, value: {} })).toBe(false);
  });
});

describe('createCacheEntry', () => {
  it('creates entry from response headers', () => {
    const now = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const headers = new Headers({
      'cache-control': 'max-age=300',
      etag: '"abc123"',
      'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
      date: 'Mon, 15 Jan 2024 12:00:00 GMT',
    });

    const entry = createCacheEntry({ id: 1 }, headers, 200);

    expect(entry.__cacheEntry).toBe(true);
    expect(entry.value).toEqual({ id: 1 });
    expect(entry.metadata.etag).toBe('"abc123"');
    expect(entry.metadata.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    expect(entry.metadata.cacheControl.maxAge).toBe(300);
    expect(entry.metadata.storedAt).toBe(now);
    expect(entry.metadata.statusCode).toBe(200);
    expect(entry.metadata.ageHeader).toBe(0);
  });

  it('falls back to Date.now() when Date header is missing', () => {
    const now = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const headers = new Headers({ 'cache-control': 'max-age=60' });
    const entry = createCacheEntry('value', headers, 200);

    expect(entry.metadata.responseDate).toBe(now);
  });

  it('parses Age header', () => {
    const headers = new Headers({
      'cache-control': 'max-age=300',
      age: '120',
    });

    const entry = createCacheEntry({}, headers, 200);
    expect(entry.metadata.ageHeader).toBe(120);
  });

  it('parses Expires header', () => {
    const headers = new Headers({
      expires: 'Wed, 15 Jan 2025 12:00:00 GMT',
    });

    const entry = createCacheEntry({}, headers, 200);
    expect(entry.metadata.expires).toBe(
      Date.parse('Wed, 15 Jan 2025 12:00:00 GMT'),
    );
  });

  it('captures Vary header', () => {
    const headers = new Headers({
      'cache-control': 'max-age=60',
      vary: 'Accept, Accept-Encoding',
    });

    const entry = createCacheEntry({}, headers, 200);
    expect(entry.metadata.varyHeaders).toBe('Accept, Accept-Encoding');
  });

  it('handles missing optional headers', () => {
    const headers = new Headers();
    const entry = createCacheEntry({}, headers, 200);

    expect(entry.metadata.etag).toBeUndefined();
    expect(entry.metadata.lastModified).toBeUndefined();
    expect(entry.metadata.varyHeaders).toBeUndefined();
    expect(entry.metadata.expires).toBeUndefined();
  });

  it('handles non-numeric Age header', () => {
    const headers = new Headers({ age: 'invalid' });
    const entry = createCacheEntry({}, headers, 200);
    expect(entry.metadata.ageHeader).toBe(0);
  });
});

describe('refreshCacheEntry', () => {
  const makeExistingEntry = (): CacheEntry<{ id: number }> => ({
    __cacheEntry: true,
    value: { id: 42 },
    metadata: {
      etag: '"old-etag"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      cacheControl: {
        maxAge: 60,
        noCache: false,
        noStore: false,
        mustRevalidate: false,
        proxyRevalidate: false,
        public: false,
        private: false,
        immutable: false,
      },
      responseDate: 1700000000000,
      storedAt: 1700000000000,
      ageHeader: 0,
      statusCode: 200,
      expires: 1700000060000,
      varyHeaders: 'Accept',
    },
  });

  it('preserves the original value', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers({ 'cache-control': 'max-age=300' });
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.value).toEqual({ id: 42 });
  });

  it('updates Cache-Control from 304 headers', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers({ 'cache-control': 'max-age=600' });
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.cacheControl.maxAge).toBe(600);
  });

  it('keeps existing Cache-Control when 304 has none', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers();
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.cacheControl.maxAge).toBe(60);
  });

  it('updates ETag from 304', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers({ etag: '"new-etag"' });
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.etag).toBe('"new-etag"');
  });

  it('keeps existing ETag when 304 has none', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers();
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.etag).toBe('"old-etag"');
  });

  it('updates storedAt and responseDate', () => {
    const now = 1700001000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const existing = makeExistingEntry();
    const newHeaders = new Headers();
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.storedAt).toBe(now);
    expect(refreshed.metadata.responseDate).toBe(now);
  });

  it('preserves statusCode from original response', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers();
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.statusCode).toBe(200);
  });

  it('updates Expires when 304 provides it', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers({
      expires: 'Wed, 15 Jan 2025 12:00:00 GMT',
    });
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.expires).toBe(
      Date.parse('Wed, 15 Jan 2025 12:00:00 GMT'),
    );
  });

  it('keeps existing Expires when 304 has none', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers();
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.expires).toBe(1700000060000);
  });

  it('updates Vary header from 304', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers({ vary: 'Accept-Encoding' });
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.varyHeaders).toBe('Accept-Encoding');
  });

  it('updates Age header from 304', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers({ age: '30' });
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.ageHeader).toBe(30);
  });

  it('handles non-numeric Age header in 304', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers({ age: 'invalid' });
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.ageHeader).toBe(0);
  });

  it('updates Last-Modified from 304', () => {
    const existing = makeExistingEntry();
    const newHeaders = new Headers({
      'last-modified': 'Tue, 02 Jan 2024 00:00:00 GMT',
    });
    const refreshed = refreshCacheEntry(existing, newHeaders);

    expect(refreshed.metadata.lastModified).toBe(
      'Tue, 02 Jan 2024 00:00:00 GMT',
    );
  });
});
