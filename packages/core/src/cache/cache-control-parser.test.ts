import { describe, it, expect } from 'vitest';
import { parseCacheControl } from './cache-control-parser.js';

describe('parseCacheControl', () => {
  it('parses max-age', () => {
    expect(parseCacheControl('max-age=300')).toMatchObject({ maxAge: 300 });
  });

  it('parses combined directives', () => {
    const result = parseCacheControl(
      'public, max-age=3600, stale-while-revalidate=60',
    );
    expect(result).toMatchObject({
      public: true,
      maxAge: 3600,
      staleWhileRevalidate: 60,
    });
  });

  it('handles no-store and no-cache', () => {
    const result = parseCacheControl('no-cache, no-store');
    expect(result.noCache).toBe(true);
    expect(result.noStore).toBe(true);
  });

  it('returns defaults for null/undefined/empty', () => {
    for (const input of [null, undefined, '']) {
      const result = parseCacheControl(input);
      expect(result.noCache).toBe(false);
      expect(result.noStore).toBe(false);
      expect(result.maxAge).toBeUndefined();
    }
  });

  it('ignores unknown directives', () => {
    const result = parseCacheControl('max-age=60, x-custom=hello, no-cache');
    expect(result.maxAge).toBe(60);
    expect(result.noCache).toBe(true);
  });

  it('handles malformed numeric values', () => {
    expect(parseCacheControl('max-age=abc').maxAge).toBeUndefined();
    expect(parseCacheControl('max-age=-1').maxAge).toBeUndefined();
    expect(parseCacheControl('max-age=').maxAge).toBeUndefined();
  });

  it('is case insensitive', () => {
    const result = parseCacheControl('Max-Age=300, No-Cache');
    expect(result.maxAge).toBe(300);
    expect(result.noCache).toBe(true);
  });

  it('handles extra whitespace', () => {
    const result = parseCacheControl('  max-age = 300 , no-store  ');
    expect(result.maxAge).toBe(300);
    expect(result.noStore).toBe(true);
  });

  it('parses s-maxage', () => {
    const result = parseCacheControl('s-maxage=600');
    expect(result.sMaxAge).toBe(600);
  });

  it('parses must-revalidate', () => {
    const result = parseCacheControl('must-revalidate');
    expect(result.mustRevalidate).toBe(true);
  });

  it('parses proxy-revalidate', () => {
    const result = parseCacheControl('proxy-revalidate');
    expect(result.proxyRevalidate).toBe(true);
  });

  it('parses private', () => {
    const result = parseCacheControl('private');
    expect(result.private).toBe(true);
  });

  it('parses immutable', () => {
    const result = parseCacheControl('immutable');
    expect(result.immutable).toBe(true);
  });

  it('parses stale-if-error', () => {
    const result = parseCacheControl('stale-if-error=300');
    expect(result.staleIfError).toBe(300);
  });

  it('handles empty parts from trailing commas', () => {
    const result = parseCacheControl('max-age=60,,,no-cache,');
    expect(result.maxAge).toBe(60);
    expect(result.noCache).toBe(true);
  });

  it('returns undefined for numeric directive without value', () => {
    // max-age with no = sign → value is undefined → parseSeconds(undefined)
    expect(parseCacheControl('max-age').maxAge).toBeUndefined();
    expect(
      parseCacheControl('stale-while-revalidate').staleWhileRevalidate,
    ).toBeUndefined();
  });
});
