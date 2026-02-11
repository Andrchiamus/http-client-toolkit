# HTTP Client Toolkit

A modular HTTP client toolkit with pluggable caching, deduplication, and rate limiting. Each concern is implemented as a standalone store that can be used independently or composed together.

## Packages

| Package                                                  | Description                         |
| -------------------------------------------------------- | ----------------------------------- |
| [`@http-client-toolkit/core`](#core)                     | HTTP client and store interfaces    |
| [`@http-client-toolkit/store-memory`](#in-memory-stores) | In-memory store implementations     |
| [`@http-client-toolkit/store-sqlite`](#sqlite-stores)    | SQLite-backed store implementations |

## Installation

Install the core client first:

```bash
npm install @http-client-toolkit/core
```

Then pick one or more store backends:

```bash
npm install @http-client-toolkit/store-memory
```

```bash
npm install @http-client-toolkit/store-sqlite
```

Requires Node.js >= 20.

If you are contributing in this repository (instead of consuming published packages), use `pnpm install` at the repo root.

## Quick Start

```typescript
import { HttpClient } from '@http-client-toolkit/core';
import {
  InMemoryCacheStore,
  InMemoryDedupeStore,
  InMemoryRateLimitStore,
} from '@http-client-toolkit/store-memory';

const client = new HttpClient(
  {
    cache: new InMemoryCacheStore(),
    dedupe: new InMemoryDedupeStore(),
    rateLimit: new InMemoryRateLimitStore(),
  },
  { defaultCacheTTL: 300 },
);

const data = await client.get<{ name: string }>(
  'https://api.example.com/user/1',
);
```

Every store is optional. Use only what you need:

```typescript
// Cache-only client
const client = new HttpClient({ cache: new InMemoryCacheStore() });

// Rate-limited client with no caching
const client = new HttpClient({
  rateLimit: new InMemoryRateLimitStore({
    defaultConfig: { limit: 100, windowMs: 60_000 },
  }),
});
```

## Core

The core package provides the `HttpClient` class and all store interfaces.

### HttpClient

```typescript
new HttpClient(stores?, options?)
```

`HttpClient` currently exposes a single request method: `get(url, options?)`.
The `url` must be an absolute URL (for example, `https://api.example.com/items`).

**Request options (`client.get`)**

| Property   | Type                     | Default        | Description                         |
| ---------- | ------------------------ | -------------- | ----------------------------------- |
| `signal`   | `AbortSignal`            | -              | Cancels wait + request when aborted |
| `priority` | `'user' \| 'background'` | `'background'` | Used by adaptive rate-limit stores  |

**Stores:**

| Property    | Type                                       | Description           |
| ----------- | ------------------------------------------ | --------------------- |
| `cache`     | `CacheStore`                               | Response caching      |
| `dedupe`    | `DedupeStore`                              | Request deduplication |
| `rateLimit` | `RateLimitStore \| AdaptiveRateLimitStore` | Rate limiting         |

**Options:**

| Property              | Type                         | Default | Description                             |
| --------------------- | ---------------------------- | ------- | --------------------------------------- |
| `defaultCacheTTL`     | `number`                     | `3600`  | Cache TTL in seconds                    |
| `throwOnRateLimit`    | `boolean`                    | `true`  | Throw when rate limited vs. wait        |
| `maxWaitTime`         | `number`                     | `60000` | Max wait time (ms) before throwing      |
| `responseTransformer` | `(data: unknown) => unknown` | -       | Transform raw response data             |
| `responseHandler`     | `(data: unknown) => unknown` | -       | Validate/process transformed data       |
| `errorHandler`        | `(error: unknown) => Error`  | -       | Convert errors to domain-specific types |

### Request Flow

When `client.get(url)` is called, the request passes through each configured layer in order:

1. **Cache** - Return cached response if available
2. **Dedupe** - If an identical request is already in-flight, wait for its result
3. **Rate Limit** - Wait or throw if the rate limit is exceeded
4. **Fetch** - Execute the HTTP request
5. **Transform & Validate** - Apply `responseTransformer` then `responseHandler`
6. **Store** - Cache the result, record the rate limit hit, and resolve any deduplicated waiters

### Priority Support

When using an `AdaptiveRateLimitStore`, requests can declare a priority:

```typescript
// User-initiated request - gets higher rate limit allocation
const data = await client.get(url, { priority: 'user' });

// Background/automated request - lower priority
const data = await client.get(url, { priority: 'background' });
```

The adaptive store dynamically shifts capacity between user and background pools based on recent activity patterns.

`HttpClient` always forwards `priority` to rate-limit store methods. Adaptive stores use it to allocate capacity; basic `RateLimitStore` implementations safely ignore the extra argument.

Rate limits are tracked per inferred resource name. The client derives this from the URL path's last segment (for example, `/v1/users/42` maps to resource `42`).
Use explicit `resourceConfigs` keys that match your URL patterns.

### Cancellation

Pass an `AbortSignal` to cancel a request, including while waiting for a rate limit window:

```typescript
const controller = new AbortController();
const data = await client.get(url, { signal: controller.signal });

// Cancel from elsewhere
controller.abort();
```

### Error Handling

All HTTP errors are wrapped in `HttpClientError`:

```typescript
import { HttpClientError } from '@http-client-toolkit/core';

try {
  await client.get(url);
} catch (error) {
  if (error instanceof HttpClientError) {
    console.log(error.message); // Error description
    console.log(error.statusCode); // HTTP status code (if applicable)
  }
}
```

Use `errorHandler` to convert errors into your own domain types:

```typescript
const client = new HttpClient(stores, {
  errorHandler: (error) => {
    if (error instanceof HttpClientError && error.statusCode === 404) {
      return new NotFoundError('Resource not found');
    }
    return error instanceof Error ? error : new Error(String(error));
  },
});
```

### Response Transformation

Use `responseTransformer` to normalize API responses (e.g. convert keys to camelCase) and `responseHandler` to validate or unwrap them:

```typescript
import camelcaseKeys from 'camelcase-keys';

const client = new HttpClient(stores, {
  responseTransformer: (data) => camelcaseKeys(data, { deep: true }),
  responseHandler: (data) => {
    if (!data || typeof data !== 'object') {
      throw new Error('Unexpected response shape');
    }
    return data;
  },
});
```

### Request Hashing

The `hashRequest` utility generates deterministic SHA-256 hashes for cache and deduplication keys. `HttpClient` hashes by URL origin + path + normalized query params so identical paths on different hosts do not collide. Parameter order does not matter, and numbers/booleans are normalized to strings before hashing (`"10"` and `10`, `"true"` and `true` produce the same hash).

```typescript
import { hashRequest } from '@http-client-toolkit/core';

const hash = hashRequest('https://api.example.com/search', {
  q: 'test',
  page: 1,
});
```

## In-Memory Stores

Fast, zero-dependency stores for development, testing, or single-process production use.

```bash
npm install @http-client-toolkit/store-memory
```

### InMemoryCacheStore

LRU cache with TTL support and dual eviction limits (item count + memory usage).

```typescript
import { InMemoryCacheStore } from '@http-client-toolkit/store-memory';

const cache = new InMemoryCacheStore({
  maxItems: 1000, // Default: 1000
  maxMemoryBytes: 50_000_000, // Default: 50 MB
  cleanupIntervalMs: 60_000, // Default: 60s. Set to 0 to disable.
  evictionRatio: 0.1, // Default: 10% evicted when limits exceeded
});
```

Call `cache.destroy()` when done to clear the cleanup timer.

Expired entries are removed lazily on `get` (and during scheduled cleanup), and cache memory statistics are updated immediately when those entries are evicted.

### InMemoryDedupeStore

Prevents duplicate concurrent requests. If a request for the same hash is already in-flight, subsequent callers wait for the original to complete.

Built-in dedupe stores implement an atomic `registerOrJoin` path so exactly one caller executes the upstream request while other concurrent callers join and wait.

```typescript
import { InMemoryDedupeStore } from '@http-client-toolkit/store-memory';

const dedupe = new InMemoryDedupeStore({
  jobTimeoutMs: 300_000, // Default: 5 minutes
  cleanupIntervalMs: 60_000, // Default: 60s
});
```

### InMemoryRateLimitStore

Sliding window rate limiter with optional per-resource configuration.

```typescript
import { InMemoryRateLimitStore } from '@http-client-toolkit/store-memory';

const rateLimit = new InMemoryRateLimitStore({
  defaultConfig: { limit: 60, windowMs: 60_000 },
  resourceConfigs: new Map([['slow-api', { limit: 10, windowMs: 60_000 }]]),
});
```

### AdaptiveRateLimitStore

Priority-aware rate limiter that dynamically allocates capacity between user and background requests based on recent activity patterns.

```typescript
import { AdaptiveRateLimitStore } from '@http-client-toolkit/store-memory';

const rateLimit = new AdaptiveRateLimitStore({
  defaultConfig: { limit: 200, windowMs: 3_600_000 }, // 200 req/hour
  resourceConfigs: new Map([['search', { limit: 50, windowMs: 60_000 }]]),
  adaptiveConfig: {
    highActivityThreshold: 10, // User requests to trigger high-activity mode
    moderateActivityThreshold: 3, // User requests to trigger moderate mode
    monitoringWindowMs: 900_000, // 15-minute activity window
    maxUserScaling: 2.0, // Max user capacity multiplier
  },
});
```

**Adaptive strategies:**

| Activity Level           | Behavior                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| **High**                 | Prioritizes user requests, pauses background if trend is increasing |
| **Moderate**             | Balanced allocation with trend-aware scaling                        |
| **Low**                  | Scales up background capacity                                       |
| **Sustained inactivity** | Gives full capacity to background                                   |

## SQLite Stores

Persistent stores backed by SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and [Drizzle ORM](https://orm.drizzle.team/). Suitable for production use where data should survive process restarts.

By default, stores use `':memory:'` (non-persistent). Pass a file path (for example `./app.db`) for persistence.

```bash
npm install @http-client-toolkit/store-sqlite
```

All SQLite stores accept either a file path or an existing `better-sqlite3` Database instance. Passing a shared instance lets multiple stores operate on the same database file:

```typescript
import Database from 'better-sqlite3';
import {
  SQLiteCacheStore,
  SQLiteDedupeStore,
  SQLiteRateLimitStore,
} from '@http-client-toolkit/store-sqlite';

const db = new Database('./app.db');

const cache = new SQLiteCacheStore({ database: db });
const dedupe = new SQLiteDedupeStore({ database: db });
const rateLimit = new SQLiteRateLimitStore({ database: db });

const client = new HttpClient({ cache, dedupe, rateLimit });
```

When a file path is passed instead, the store manages its own connection and will close it when `close()` is called.

### SQLiteCacheStore

```typescript
new SQLiteCacheStore({
  database: './cache.db', // Default: ':memory:'
  cleanupIntervalMs: 60_000, // Set to 0 to disable automatic cleanup
  maxEntrySizeBytes: 5_242_880, // Default: 5 MiB
});
```

### SQLiteDedupeStore

```typescript
new SQLiteDedupeStore({
  database: './dedupe.db',
  jobTimeoutMs: 300_000,
  cleanupIntervalMs: 60_000,
});
```

### SQLiteRateLimitStore

```typescript
new SQLiteRateLimitStore({
  database: "./ratelimit.db",
  defaultConfig: { limit: 60, windowMs: 60_000 },
  resourceConfigs: new Map([...]),
});
```

### SqliteAdaptiveRateLimitStore

```typescript
new SqliteAdaptiveRateLimitStore({
  database: "./ratelimit.db",
  defaultConfig: { limit: 200, windowMs: 3_600_000 },
  resourceConfigs: new Map([...]),
  adaptiveConfig: { highActivityThreshold: 10 },
});
```

## Full Example

```typescript
import { HttpClient } from '@http-client-toolkit/core';
import Database from 'better-sqlite3';
import {
  SQLiteCacheStore,
  SQLiteDedupeStore,
  SqliteAdaptiveRateLimitStore,
} from '@http-client-toolkit/store-sqlite';

const db = new Database('./http-store.db');

const client = new HttpClient(
  {
    cache: new SQLiteCacheStore({ database: db }),
    dedupe: new SQLiteDedupeStore({ database: db }),
    rateLimit: new SqliteAdaptiveRateLimitStore({
      database: db,
      defaultConfig: { limit: 200, windowMs: 3_600_000 },
    }),
  },
  {
    defaultCacheTTL: 600,
    throwOnRateLimit: false,
    maxWaitTime: 30_000,
    responseTransformer: (data) => data,
  },
);

// User-initiated request
const user = await client.get<{ name: string }>(
  'https://api.example.com/user/1',
  { priority: 'user' },
);

// Background sync
const items = await client.get<Array<{ id: number }>>(
  'https://api.example.com/items',
  { priority: 'background' },
);
```

## Development

From the repo root:

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Useful root scripts:

- `pnpm format` - format TypeScript/Markdown files with Prettier
- `pnpm clean` - remove package build outputs and root `node_modules`

## License

MIT
