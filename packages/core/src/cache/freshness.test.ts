import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CacheEntryMetadata } from './cache-entry.js';
import {
  calculateFreshnessLifetime,
  calculateCurrentAge,
  getFreshnessStatus,
  calculateStoreTTL,
} from './freshness.js';

function makeMetadata(
  overrides: Partial<CacheEntryMetadata> = {},
): CacheEntryMetadata {
  return {
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
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('calculateFreshnessLifetime', () => {
  it('uses max-age when present', () => {
    const m = makeMetadata({
      cacheControl: { ...makeMetadata().cacheControl, maxAge: 300 },
    });
    expect(calculateFreshnessLifetime(m)).toBe(300);
  });

  it('ignores s-maxage (private cache)', () => {
    const m = makeMetadata({
      cacheControl: { ...makeMetadata().cacheControl, sMaxAge: 600 },
    });
    // s-maxage should NOT be used — falls through to 0
    expect(calculateFreshnessLifetime(m)).toBe(0);
  });

  it('falls back to Expires − Date', () => {
    const now = Date.now();
    const m = makeMetadata({
      responseDate: now,
      expires: now + 600_000, // 600s in the future
    });
    expect(calculateFreshnessLifetime(m)).toBe(600);
  });

  it('treats Expires: 0 as immediately expired', () => {
    const m = makeMetadata({ expires: 0 });
    expect(calculateFreshnessLifetime(m)).toBe(0);
  });

  it('clamps negative Expires − Date to 0', () => {
    const now = Date.now();
    const m = makeMetadata({
      responseDate: now,
      expires: now - 1000, // In the past
    });
    expect(calculateFreshnessLifetime(m)).toBe(0);
  });

  it('uses heuristic 10% of Last-Modified age', () => {
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    const m = makeMetadata({
      responseDate: now,
      lastModified: new Date(tenDaysAgo).toUTCString(),
    });
    // 10% of 10 days ≈ 1 day = 86400s
    expect(calculateFreshnessLifetime(m)).toBe(86400);
  });

  it('returns 0 for unparseable Last-Modified', () => {
    const m = makeMetadata({
      lastModified: 'not-a-date',
    });
    expect(calculateFreshnessLifetime(m)).toBe(0);
  });

  it('returns 0 for future Last-Modified', () => {
    const now = Date.now();
    const m = makeMetadata({
      responseDate: now,
      lastModified: new Date(now + 1000).toUTCString(),
    });
    expect(calculateFreshnessLifetime(m)).toBe(0);
  });

  it('returns 0 when no freshness info available', () => {
    expect(calculateFreshnessLifetime(makeMetadata())).toBe(0);
  });

  it('prefers max-age over Expires', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: { ...makeMetadata().cacheControl, maxAge: 100 },
      responseDate: now,
      expires: now + 600_000,
    });
    expect(calculateFreshnessLifetime(m)).toBe(100);
  });

  it('prefers max-age over Last-Modified heuristic', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: { ...makeMetadata().cacheControl, maxAge: 50 },
      responseDate: now,
      lastModified: new Date(now - 86400000).toUTCString(),
    });
    expect(calculateFreshnessLifetime(m)).toBe(50);
  });
});

describe('calculateCurrentAge', () => {
  it('accounts for resident time', () => {
    const now = Date.now();
    const storedAt = now - 120_000; // stored 120s ago
    const m = makeMetadata({ storedAt, responseDate: storedAt });
    const age = calculateCurrentAge(m, now);
    expect(age).toBe(120);
  });

  it('incorporates Age header', () => {
    const now = Date.now();
    const m = makeMetadata({
      storedAt: now,
      responseDate: now,
      ageHeader: 60,
    });
    const age = calculateCurrentAge(m, now);
    expect(age).toBe(60); // corrected_initial_age = max(0, 60) + 0 resident
  });

  it('accepts explicit now parameter for deterministic testing', () => {
    const stored = 1000000;
    const m = makeMetadata({
      storedAt: stored,
      responseDate: stored,
      ageHeader: 0,
    });
    // 10 seconds of resident time
    expect(calculateCurrentAge(m, stored + 10_000)).toBe(10);
  });

  it('uses apparent age when Date is older than storedAt', () => {
    const now = Date.now();
    const m = makeMetadata({
      storedAt: now,
      responseDate: now - 5000, // Date header is 5s before storedAt
      ageHeader: 0,
    });
    const age = calculateCurrentAge(m, now);
    expect(age).toBe(5); // apparent_age = 5s
  });

  it('uses max of apparent age and Age header', () => {
    const now = Date.now();
    const m = makeMetadata({
      storedAt: now,
      responseDate: now - 3000, // 3s apparent age
      ageHeader: 10, // 10s from Age header
    });
    const age = calculateCurrentAge(m, now);
    expect(age).toBe(10); // max(3, 10) = 10
  });

  it('uses Date.now() when now is not provided', () => {
    const stored = Date.now() - 5000;
    const m = makeMetadata({
      storedAt: stored,
      responseDate: stored,
      ageHeader: 0,
    });
    const age = calculateCurrentAge(m);
    expect(age).toBeGreaterThanOrEqual(4);
    expect(age).toBeLessThanOrEqual(6);
  });
});

describe('getFreshnessStatus', () => {
  it('returns fresh when within lifetime', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: { ...makeMetadata().cacheControl, maxAge: 300 },
      storedAt: now,
      responseDate: now,
    });
    expect(getFreshnessStatus(m, now)).toBe('fresh');
  });

  it('returns stale when past lifetime', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: { ...makeMetadata().cacheControl, maxAge: 60 },
      storedAt: now - 120_000,
      responseDate: now - 120_000,
    });
    expect(getFreshnessStatus(m, now)).toBe('stale');
  });

  it('returns no-cache even when fresh', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 3600,
        noCache: true,
      },
      storedAt: now,
      responseDate: now,
    });
    expect(getFreshnessStatus(m, now)).toBe('no-cache');
  });

  it('returns must-revalidate when stale and must-revalidate set', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 60,
        mustRevalidate: true,
      },
      storedAt: now - 120_000,
      responseDate: now - 120_000,
    });
    expect(getFreshnessStatus(m, now)).toBe('must-revalidate');
  });

  it('returns stale-while-revalidate when within SWR window', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 60,
        staleWhileRevalidate: 120,
      },
      storedAt: now - 90_000, // 90s ago, 30s stale, within 120s SWR window
      responseDate: now - 90_000,
    });
    expect(getFreshnessStatus(m, now)).toBe('stale-while-revalidate');
  });

  it('returns stale when past SWR window', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 60,
        staleWhileRevalidate: 10,
      },
      storedAt: now - 120_000, // 120s ago, 60s stale, past 10s SWR window
      responseDate: now - 120_000,
    });
    expect(getFreshnessStatus(m, now)).toBe('stale');
  });

  it('returns stale-if-error when within SIE window', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 60,
        staleIfError: 300,
      },
      storedAt: now - 120_000, // 120s ago, 60s stale, within 300s SIE window
      responseDate: now - 120_000,
    });
    expect(getFreshnessStatus(m, now)).toBe('stale-if-error');
  });

  it('returns stale when past SIE window', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 60,
        staleIfError: 10,
      },
      storedAt: now - 120_000,
      responseDate: now - 120_000,
    });
    expect(getFreshnessStatus(m, now)).toBe('stale');
  });

  it('must-revalidate takes priority over SWR and SIE', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 60,
        mustRevalidate: true,
        staleWhileRevalidate: 300,
        staleIfError: 300,
      },
      storedAt: now - 120_000,
      responseDate: now - 120_000,
    });
    expect(getFreshnessStatus(m, now)).toBe('must-revalidate');
  });

  it('SWR takes priority over SIE', () => {
    const now = Date.now();
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 60,
        staleWhileRevalidate: 300,
        staleIfError: 300,
      },
      storedAt: now - 90_000,
      responseDate: now - 90_000,
    });
    expect(getFreshnessStatus(m, now)).toBe('stale-while-revalidate');
  });
});

describe('calculateStoreTTL', () => {
  it('returns freshness + stale window', () => {
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 300,
        staleWhileRevalidate: 60,
      },
    });
    expect(calculateStoreTTL(m, 3600)).toBe(360);
  });

  it('uses max of SWR and SIE windows', () => {
    const m = makeMetadata({
      cacheControl: {
        ...makeMetadata().cacheControl,
        maxAge: 300,
        staleWhileRevalidate: 60,
        staleIfError: 600,
      },
    });
    expect(calculateStoreTTL(m, 3600)).toBe(900);
  });

  it('falls back to defaultTTL when no freshness info', () => {
    expect(calculateStoreTTL(makeMetadata(), 3600)).toBe(3600);
  });

  it('uses header-derived TTL when max-age is 0', () => {
    const m = makeMetadata({
      cacheControl: { ...makeMetadata().cacheControl, maxAge: 0 },
    });
    // max-age=0 means immediately stale, but maxAge IS defined (0)
    // so we don't fall back to defaultTTL
    expect(calculateStoreTTL(m, 3600)).toBe(0);
  });

  it('uses freshness from Expires header', () => {
    const now = Date.now();
    const m = makeMetadata({
      responseDate: now,
      expires: now + 300_000,
    });
    expect(calculateStoreTTL(m, 3600)).toBe(300);
  });
});
