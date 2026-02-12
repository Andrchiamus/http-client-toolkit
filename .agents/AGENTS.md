# AGENTS

## Project Overview

HTTP Client Toolkit — a TypeScript monorepo providing pluggable HTTP caching, request deduplication, and rate limiting with swappable storage backends.

## Monorepo Structure

**pnpm** workspaces + **Turborepo** for build orchestration. All packages under `packages/`.

| Package | Scope | Description |
|---|---|---|
| `packages/core` | `@http-client-toolkit/core` | Core HTTP client, interfaces, and adaptive rate limiting |
| `packages/store-memory` | `@http-client-toolkit/store-memory` | In-memory store (Map-based, LRU eviction) |
| `packages/store-sqlite` | `@http-client-toolkit/store-sqlite` | SQLite store via better-sqlite3 + Drizzle ORM |
| `packages/store-dynamodb` | `@http-client-toolkit/store-dynamodb` | DynamoDB store via AWS SDK v3 |
| `packages/eslint-config` | `@repo/eslint-config` | Shared ESLint flat config (private) |
| `packages/tsup-config` | `@repo/tsup-config` | Shared tsup build config (private) |
| `packages/vitest-config` | `@repo/vitest-config` | Shared Vitest config (private) |

## Commands

```bash
pnpm build            # Build all packages (turbo)
pnpm test             # Run all tests (turbo)
pnpm test:coverage    # Tests with V8 coverage
pnpm lint             # Lint all packages
pnpm lint:fix         # Lint + auto-fix
pnpm format           # Prettier format (ts, tsx, md)
pnpm changeset        # Create a changeset for versioning
pnpm release          # Build + publish via changesets
```

Per-package: `pnpm --filter @http-client-toolkit/core test`

## Architecture

The core `HttpClient` orchestrates three pluggable concerns:
1. **Cache** — check cache → return hit or proceed
2. **Dedup** — atomic `registerOrJoin()` → owner fetches, joiners wait
3. **Rate limit** — basic sliding-window or adaptive priority-aware
4. **Fetch** → parse → optional `responseTransformer` → optional `responseHandler` → cache result

### Key Interfaces (in `packages/core/src/`)

- **CacheStore\<T\>**: `get`, `set` (with TTL), `delete`, `clear`
- **DedupeStore\<T\>**: `registerOrJoin` (atomic ownership), `waitFor`, `complete`, `fail`
- **RateLimitStore**: `canProceed`, `record`, `acquire` (optional atomic), `getWaitTime`, `getStatus`
- **AdaptiveRateLimitStore**: extends RateLimitStore with `priority: 'user' | 'background'`
- **HttpClientContract**: `get<Result>(url, options?)` → typed result or throws `HttpClientError`

### Store Implementation Pattern

Each store backend implements the same interfaces. New backends follow this pattern:
- Implement `CacheStore`, `DedupeStore`, and/or `RateLimitStore` from core
- Use Zod for config validation
- Export from a single `src/index.ts` entry point

## Code Conventions

- **TypeScript strict mode**, `@types/node` v20, Node >= 20
- **ESM + CJS dual exports** via tsup (`lib/index.js` + `lib/index.cjs`)
- **Vitest** — tests colocated in `src/`, 100% coverage thresholds (lines/functions/branches/statements)
- **ESLint 9** flat config with `typescript-eslint`, `eslint-plugin-import`, Prettier
- **Zod** for runtime schema validation (configs, inputs)
- **Changesets** for versioning; **Husky** for git hooks

## Testing

- Tests live alongside source: `src/**/*.test.ts`
- **Core**: `nock` for HTTP interception
- **DynamoDB**: `aws-sdk-client-mock` + `aws-sdk-client-mock-vitest`
- **Memory/SQLite**: Direct instance testing
- Time mocking: `vi.spyOn(Date, 'now').mockReturnValue(fixedTimestamp)` for TTL tests
- **Always clean up in `afterEach()`** — stores have timers that cause test pollution if leaked

## Important Implementation Details

### Cache TTL Semantics (all backends)
- `ttlSeconds > 0`: expires after N seconds
- `ttlSeconds === 0`: never expires (permanent)
- `ttlSeconds < 0`: already expired (immediate removal)

### Dedup Ownership
- `registerOrJoin()` returns `{ jobId, isOwner }` — only the owner makes the HTTP call
- Non-owners `waitFor()` the result; failed jobs resolve as `undefined` (not thrown)

### Rate Limiting
- Sliding window: tracks request timestamps per resource
- Server hints (429, 503, Retry-After) trigger origin-level cooldowns
- Adaptive mode monitors user activity over configurable window (default 15min) with 4 strategies

### Request Hashing
- Deterministic SHA-256 via `hashRequest(endpoint, params)`
- Sorts keys, normalizes primitives (`10` and `"10"` hash identically)
- `undefined` omitted, `null` preserved

### Memory Management
- In-memory stores have cleanup timers — call `.destroy()` to prevent event-loop leaks
- Timers use `unref()` so stores don't keep the process alive

### DynamoDB
- Single table design: `pk`/`sk` partition + sort keys, GSI1 for queries
- Native TTL on `ttl` attribute; max 400KB per item
- Batch writes: exponential backoff with jitter, max 8 retries
- Conditional writes for atomics; detect failures via `isConditionalTransactionFailure()`

## Build Config

- tsup: ESM + CJS, dts, sourcemaps, treeshake, target es2015, output to `lib/`
- Vitest: `globals: true`, `silent: true`, V8 coverage at 100% thresholds
- Each package extends shared configs from `@repo/tsup-config` and `@repo/vitest-config`
- Build order matters: core must build before store packages

## Git Conventions

- Conventional commits with scope: `feat(core):`, `fix(store-dynamodb):`, `perf(store-memory):`
- Changesets for versioning — run `pnpm changeset` before PR
- Pre-commit hook runs Prettier + lint + test on changed packages
