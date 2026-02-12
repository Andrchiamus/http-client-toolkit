# HTTP Client Toolkit

A modular HTTP client toolkit with pluggable caching, deduplication, and rate limiting. Each concern is implemented as a standalone store that can be used independently or composed together.

**[Documentation](https://allymurray.github.io/http-client-toolkit)**

## Packages

| Package | Description |
| --- | --- |
| [`@http-client-toolkit/core`](https://www.npmjs.com/package/@http-client-toolkit/core) | HTTP client and store interfaces |
| [`@http-client-toolkit/store-memory`](https://www.npmjs.com/package/@http-client-toolkit/store-memory) | In-memory store implementations |
| [`@http-client-toolkit/store-sqlite`](https://www.npmjs.com/package/@http-client-toolkit/store-sqlite) | SQLite-backed store implementations |
| [`@http-client-toolkit/store-dynamodb`](https://www.npmjs.com/package/@http-client-toolkit/store-dynamodb) | DynamoDB-backed store implementations |

## Quick Start

```bash
npm install @http-client-toolkit/core @http-client-toolkit/store-memory
```

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

Every store is optional. Use only what you need.

Requires Node.js >= 20.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## License

ISC
