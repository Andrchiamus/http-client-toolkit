# @http-client-toolkit/core

## 0.4.0

### Minor Changes

- 0586ad7: Add Vary header support to HttpClient. Cached responses with a Vary header are now only served when the current request's headers match the stored values. A new `headers` option on `get()` lets callers send custom request headers, which are also used for Vary-based cache matching.

## 0.3.0

### Minor Changes

- 601e241: Respect RFC 9111 HTTP cache headers by default. The client now always uses `Cache-Control`, `ETag`, `Last-Modified`, and `Expires` headers for freshness-based caching, conditional requests (304 Not Modified), `stale-while-revalidate`, and `stale-if-error`. The `defaultCacheTTL` is used as a fallback when response headers don't specify freshness. Store backends require no changes. The `cacheOverrides` option allows selectively bypassing specific cache directives.

## 0.2.0

### Minor Changes

- d673265: Add opt-in RFC 9111 HTTP cache header support. When `respectCacheHeaders: true` is set, the client respects `Cache-Control`, `ETag`, `Last-Modified`, and `Expires` headers for freshness-based caching, conditional requests (304 Not Modified), `stale-while-revalidate`, and `stale-if-error`. All new options default to off, preserving full backward compatibility. Store backends require no changes.

## 0.1.0

## 0.0.1

### Patch Changes

- beefad8: Initial release with HTTP client, store interfaces, in-memory and SQLite store implementations.
