# @http-client-toolkit/store-sqlite

SQLite-backed store implementations for [@http-client-toolkit/core](https://www.npmjs.com/package/@http-client-toolkit/core) using [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and [Drizzle ORM](https://orm.drizzle.team/). Suitable for production use where data should survive process restarts.

Part of the [http-client-toolkit](https://github.com/AllyMurray/http-client-toolkit) monorepo.

## Installation

```bash
npm install @http-client-toolkit/core @http-client-toolkit/store-sqlite
```

Requires Node.js >= 20.

## Usage

All stores accept either a file path or an existing `better-sqlite3` Database instance. Passing a shared instance lets multiple stores operate on the same database file:

```typescript
import { HttpClient } from '@http-client-toolkit/core';
import Database from 'better-sqlite3';
import {
  SQLiteCacheStore,
  SQLiteDedupeStore,
  SQLiteRateLimitStore,
} from '@http-client-toolkit/store-sqlite';

const db = new Database('./app.db');

const client = new HttpClient({
  cache: new SQLiteCacheStore({ database: db }),
  dedupe: new SQLiteDedupeStore({ database: db }),
  rateLimit: new SQLiteRateLimitStore({ database: db }),
});

const data = await client.get<{ name: string }>(
  'https://api.example.com/user/1',
);
```

By default, stores use `':memory:'` (non-persistent). When a file path is passed instead of a Database instance, the store manages its own connection and will close it when `close()` is called.

## Stores

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
  pollIntervalMs: 100, // Poll DB state for cross-instance waiters
});
```

Pending waiters are settled when the store is closed/destroyed, preventing hanging promises during shutdown.

### SQLiteRateLimitStore

```typescript
new SQLiteRateLimitStore({
  database: './ratelimit.db',
  defaultConfig: { limit: 60, windowMs: 60_000 },
  resourceConfigs: new Map([['slow-api', { limit: 10, windowMs: 60_000 }]]),
});
```

### SqliteAdaptiveRateLimitStore

Priority-aware rate limiter with the same adaptive strategies as the in-memory variant, backed by SQLite for persistence.

```typescript
new SqliteAdaptiveRateLimitStore({
  database: './ratelimit.db',
  defaultConfig: { limit: 200, windowMs: 3_600_000 },
  resourceConfigs: new Map([['search', { limit: 50, windowMs: 60_000 }]]),
  adaptiveConfig: { highActivityThreshold: 10 },
});
```

## License

ISC
