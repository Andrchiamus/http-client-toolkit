# http-client-toolkit: Improvements

## Critical (Must Fix Before Publishing)

1. ~~**Fix ESLint globals version conflict**~~ **RESOLVED** - Removed unused imports from root `eslint.config.js`, moved `@repo/eslint-config` runtime deps from `devDependencies` to `dependencies`, upgraded `globals` to ^17.3.0 and `typescript-eslint` to ^8.55.0, cleaned up duplicated ESLint deps in `store-memory`, added `eslint` as explicit devDependency to all packages that run lint scripts.

2. ~~**Incomplete README**~~ **RESOLVED** - Replaced with comprehensive README covering installation, quick start, full API reference for all packages, configuration options, usage examples, and a full integration example.

3. ~~**Missing CHANGELOG**~~ **RESOLVED** - Initialized changesets with `changeset init`. CHANGELOG.md files are auto-generated per package when `changeset version` runs. Created initial changeset for 0.0.1 patch release.

## Important (Should Fix)

4. ~~**Hardcoded values in AdaptiveRateLimitStore**~~ **RESOLVED** - In-memory store now accepts `defaultConfig` and `resourceConfigs` options matching the SQLite store's pattern. Removed hardcoded 200 req/hour limit and 1-hour window from `getCurrentUsage()`. Defaults to core's `DEFAULT_RATE_LIMIT` (60 req/min).

5. **No integration examples** - Create an example showing all 3 stores used together with the HTTP client.

6. **No error codes documentation** - Document what status codes `HttpClientError` can contain.

## Nice to Have

7. CONTRIBUTING.md guidelines
8. GitHub issue/PR templates
9. Performance benchmarks documentation
10. Migration guide for version upgrades
