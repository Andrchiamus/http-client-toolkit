import {
  parseCacheControl,
  createCacheEntry,
  refreshCacheEntry,
  isCacheEntry,
  getFreshnessStatus,
  calculateStoreTTL,
  type CacheEntry,
} from '../cache/index.js';
import { HttpClientError } from '../errors/http-client-error.js';
import {
  CacheStore,
  DedupeStore,
  RateLimitStore,
  AdaptiveRateLimitStore,
  RequestPriority,
  hashRequest,
} from '../stores/index.js';
import { HttpClientContract } from '../types/index.js';

const DEFAULT_RATE_LIMIT_HEADER_NAMES = {
  retryAfter: ['retry-after'],
  limit: ['ratelimit-limit', 'x-ratelimit-limit', 'rate-limit-limit'],
  remaining: [
    'ratelimit-remaining',
    'x-ratelimit-remaining',
    'rate-limit-remaining',
  ],
  reset: ['ratelimit-reset', 'x-ratelimit-reset', 'rate-limit-reset'],
  combined: ['ratelimit'],
} as const;

/**
 * Wait for a specified period while supporting cancellation via AbortSignal.
 *
 * If the signal is aborted before the timeout completes the promise rejects
 * with an `Error` whose name is set to `AbortError`, mimicking DOMException in
 * browser environments without depending on it. This allows callers to use a
 * single `AbortController` for both the rate-limit wait *and* the subsequent
 * HTTP request.
 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

export interface HttpClientStores {
  cache?: CacheStore;
  dedupe?: DedupeStore;
  rateLimit?: RateLimitStore | AdaptiveRateLimitStore;
}

export interface HttpClientOptions {
  /**
   * Default cache TTL in seconds
   */
  defaultCacheTTL?: number;
  /**
   * Whether to throw errors on rate limit violations
   */
  throwOnRateLimit?: boolean;
  /**
   * Maximum time to wait for rate limit in milliseconds
   */
  maxWaitTime?: number;
  /**
   * Optional response transformer applied to the raw response data.
   * Use this for converting snake_case to camelCase, etc.
   */
  responseTransformer?: (data: unknown) => unknown;
  /**
   * Optional error handler to convert errors into domain-specific error types.
   * If not provided, a generic HttpClientError is thrown.
   */
  errorHandler?: (error: unknown) => Error;
  /**
   * Optional response validator/handler called after transformation.
   * Use this to inspect the response and throw domain-specific errors
   * based on response content (e.g., API-level error codes).
   */
  responseHandler?: (data: unknown) => unknown;
  /**
   * Configure rate-limit response header names for standards and custom APIs.
   */
  rateLimitHeaders?: {
    retryAfter?: Array<string>;
    limit?: Array<string>;
    remaining?: Array<string>;
    reset?: Array<string>;
    combined?: Array<string>;
  };
  /**
   * Override specific cache header behaviors.
   */
  cacheHeaderOverrides?: {
    /** Cache responses even when Cache-Control: no-store is set */
    ignoreNoStore?: boolean;
    /** Skip revalidation even when Cache-Control: no-cache is set */
    ignoreNoCache?: boolean;
    /** Minimum TTL in seconds — floor on header-derived freshness */
    minimumTTL?: number;
    /** Maximum TTL in seconds — cap on header-derived freshness */
    maximumTTL?: number;
  };
}

interface RateLimitHeaderConfig {
  retryAfter: Array<string>;
  limit: Array<string>;
  remaining: Array<string>;
  reset: Array<string>;
  combined: Array<string>;
}

interface ParsedResponseBody {
  data: unknown;
}

type ErrorWithResponse = {
  message: string;
  response: {
    status: number;
    data: unknown;
    headers: Headers;
  };
};

export class HttpClient implements HttpClientContract {
  private stores: HttpClientStores;
  private serverCooldowns = new Map<string, number>();
  private pendingRevalidations: Array<Promise<void>> = [];
  private options: Required<
    Pick<
      HttpClientOptions,
      'defaultCacheTTL' | 'throwOnRateLimit' | 'maxWaitTime'
    >
  > &
    Pick<
      HttpClientOptions,
      | 'responseTransformer'
      | 'errorHandler'
      | 'responseHandler'
      | 'cacheHeaderOverrides'
    > & {
      rateLimitHeaders: RateLimitHeaderConfig;
    };

  constructor(stores: HttpClientStores = {}, options: HttpClientOptions = {}) {
    this.stores = stores;
    this.options = {
      defaultCacheTTL: options.defaultCacheTTL ?? 3600,
      throwOnRateLimit: options.throwOnRateLimit ?? true,
      maxWaitTime: options.maxWaitTime ?? 60000,
      responseTransformer: options.responseTransformer,
      errorHandler: options.errorHandler,
      responseHandler: options.responseHandler,
      cacheHeaderOverrides: options.cacheHeaderOverrides,
      rateLimitHeaders: this.normalizeRateLimitHeaders(
        options.rateLimitHeaders,
      ),
    };
  }

  private normalizeRateLimitHeaders(
    customHeaders?: HttpClientOptions['rateLimitHeaders'],
  ): RateLimitHeaderConfig {
    return {
      retryAfter: this.normalizeHeaderNames(
        customHeaders?.retryAfter,
        DEFAULT_RATE_LIMIT_HEADER_NAMES.retryAfter,
      ),
      limit: this.normalizeHeaderNames(
        customHeaders?.limit,
        DEFAULT_RATE_LIMIT_HEADER_NAMES.limit,
      ),
      remaining: this.normalizeHeaderNames(
        customHeaders?.remaining,
        DEFAULT_RATE_LIMIT_HEADER_NAMES.remaining,
      ),
      reset: this.normalizeHeaderNames(
        customHeaders?.reset,
        DEFAULT_RATE_LIMIT_HEADER_NAMES.reset,
      ),
      combined: this.normalizeHeaderNames(
        customHeaders?.combined,
        DEFAULT_RATE_LIMIT_HEADER_NAMES.combined,
      ),
    };
  }

  private normalizeHeaderNames(
    providedNames: Array<string> | undefined,
    defaultNames: ReadonlyArray<string>,
  ): Array<string> {
    if (!providedNames || providedNames.length === 0) {
      return [...defaultNames];
    }

    const customNames = providedNames
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);

    if (customNames.length === 0) {
      return [...defaultNames];
    }

    return [...new Set([...customNames, ...defaultNames])];
  }

  /**
   * Infer the resource name from the endpoint URL
   * @param url The full URL or endpoint path
   * @returns The resource name for rate limiting
   */
  private inferResource(url: string): string {
    try {
      const urlObj = new URL(url);
      // Use the first meaningful path segment as the resource name
      const segments = urlObj.pathname.split('/').filter(Boolean);
      return segments[segments.length - 1] || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Extract endpoint and params from URL for request hashing
   * @param url The full URL
   * @returns Object with endpoint and params for hashing
   */
  private parseUrlForHashing(url: string): {
    endpoint: string;
    params: Record<string, unknown>;
  } {
    const urlObj = new URL(url);
    const endpoint = `${urlObj.origin}${urlObj.pathname}`;
    const params: Record<string, unknown> = {};

    urlObj.searchParams.forEach((value, key) => {
      const existing = params[key];

      // Keep repeated query keys as arrays so semantically distinct URLs like
      // `?tag=a&tag=b` and `?tag=b` do not hash to the same cache/dedupe key.
      if (existing === undefined) {
        params[key] = value;
        return;
      }

      if (Array.isArray(existing)) {
        existing.push(value);
        return;
      }

      params[key] = [existing, value];
    });

    return { endpoint, params };
  }

  private getOriginScope(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return 'unknown';
    }
  }

  private getHeaderValue(
    headers: Headers | Record<string, unknown> | undefined,
    names: Array<string>,
  ): string | undefined {
    if (!headers) {
      return undefined;
    }

    if (headers instanceof Headers) {
      for (const rawName of names) {
        const value = headers.get(rawName);
        if (value !== null) {
          return value;
        }
      }
      return undefined;
    }

    for (const rawName of names) {
      const name = rawName.toLowerCase();
      const value = headers[name] ?? headers[rawName];

      if (typeof value === 'string') {
        return value;
      }

      if (Array.isArray(value) && value.length > 0) {
        const first = value.find((entry) => typeof entry === 'string');
        if (typeof first === 'string') {
          return first;
        }
      }
    }

    return undefined;
  }

  private parseIntegerHeader(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return undefined;
    }

    return parsed;
  }

  private parseRetryAfterMs(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }

    const numeric = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return numeric * 1000;
    }

    const dateMs = Date.parse(value);
    if (!Number.isFinite(dateMs)) {
      return undefined;
    }

    return Math.max(0, dateMs - Date.now());
  }

  private parseResetMs(value: string | undefined): number | undefined {
    const parsed = this.parseIntegerHeader(value);
    if (parsed === undefined) {
      return undefined;
    }

    if (parsed === 0) {
      return 0;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    if (parsed > nowSeconds + 1) {
      return Math.max(0, (parsed - nowSeconds) * 1000);
    }

    return parsed * 1000;
  }

  private parseCombinedRateLimitHeader(value: string | undefined): {
    remaining?: number;
    resetMs?: number;
  } {
    if (!value) {
      return {};
    }

    const remainingMatch = value.match(/(?:^|[;,])\s*r\s*=\s*(\d+)/i);
    const resetMatch = value.match(/(?:^|[;,])\s*t\s*=\s*(\d+)/i);

    return {
      remaining: remainingMatch
        ? this.parseIntegerHeader(remainingMatch[1])
        : undefined,
      resetMs: resetMatch ? this.parseResetMs(resetMatch[1]) : undefined,
    };
  }

  private applyServerRateLimitHints(
    url: string,
    headers: Headers | Record<string, unknown> | undefined,
    statusCode?: number,
  ): void {
    if (!headers) {
      return;
    }

    const config = this.options.rateLimitHeaders;
    const retryAfterRaw = this.getHeaderValue(headers, config.retryAfter);
    const resetRaw = this.getHeaderValue(headers, config.reset);
    const remainingRaw = this.getHeaderValue(headers, config.remaining);
    const combinedRaw = this.getHeaderValue(headers, config.combined);

    const retryAfterMs = this.parseRetryAfterMs(retryAfterRaw);
    const resetMs = this.parseResetMs(resetRaw);
    const remaining = this.parseIntegerHeader(remainingRaw);
    const combined = this.parseCombinedRateLimitHeader(combinedRaw);

    const effectiveRemaining = remaining ?? combined.remaining;
    const effectiveResetMs = resetMs ?? combined.resetMs;
    const hasRateLimitErrorStatus = statusCode === 429 || statusCode === 503;

    let waitMs: number | undefined;

    if (retryAfterMs !== undefined) {
      waitMs = retryAfterMs;
    } else if (
      effectiveResetMs !== undefined &&
      (hasRateLimitErrorStatus ||
        (effectiveRemaining !== undefined && effectiveRemaining <= 0))
    ) {
      waitMs = effectiveResetMs;
    }

    if (waitMs === undefined || waitMs <= 0) {
      return;
    }

    const scope = this.getOriginScope(url);
    this.serverCooldowns.set(scope, Date.now() + waitMs);
  }

  private async enforceServerCooldown(
    url: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const scope = this.getOriginScope(url);
    const startedAt = Date.now();

    // Re-check cooldown after each sleep so we never proceed while a server
    // cooldown is still active. This avoids bypassing limits when cooldown
    // duration is longer than maxWaitTime.
    while (true) {
      const cooldownUntil = this.serverCooldowns.get(scope);
      if (!cooldownUntil) {
        return;
      }

      const waitMs = cooldownUntil - Date.now();
      if (waitMs <= 0) {
        this.serverCooldowns.delete(scope);
        return;
      }

      if (this.options.throwOnRateLimit) {
        throw new Error(
          `Rate limit exceeded for origin '${scope}'. Wait ${waitMs}ms before retrying.`,
        );
      }

      const elapsedMs = Date.now() - startedAt;
      const remainingWaitBudgetMs = this.options.maxWaitTime - elapsedMs;

      if (remainingWaitBudgetMs <= 0) {
        throw new Error(
          `Rate limit wait exceeded maxWaitTime (${this.options.maxWaitTime}ms) for origin '${scope}'.`,
        );
      }

      await wait(Math.min(waitMs, remainingWaitBudgetMs), signal);
    }
  }

  private async enforceStoreRateLimit(
    resource: string,
    priority: RequestPriority,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const rateLimit = this.stores.rateLimit as AdaptiveRateLimitStore;
    const startedAt = Date.now();
    const hasAtomicAcquire = typeof rateLimit.acquire === 'function';

    const canProceedNow = async (): Promise<boolean> => {
      if (hasAtomicAcquire) {
        return rateLimit.acquire!(resource, priority);
      }
      return rateLimit.canProceed(resource, priority);
    };

    if (this.options.throwOnRateLimit) {
      const canProceed = await canProceedNow();
      if (!canProceed) {
        const waitTime = await rateLimit.getWaitTime(resource, priority);
        throw new Error(
          `Rate limit exceeded for resource '${resource}'. Wait ${waitTime}ms before retrying.`,
        );
      }
      return hasAtomicAcquire;
    }

    // Keep polling + waiting until the store explicitly allows the request or
    // we exhaust maxWaitTime. A single one-off sleep can otherwise let a request
    // through while still over limit.
    while (!(await canProceedNow())) {
      const suggestedWaitMs = await rateLimit.getWaitTime(resource, priority);
      const elapsedMs = Date.now() - startedAt;
      const remainingWaitBudgetMs = this.options.maxWaitTime - elapsedMs;

      if (remainingWaitBudgetMs <= 0) {
        throw new Error(
          `Rate limit wait exceeded maxWaitTime (${this.options.maxWaitTime}ms) for resource '${resource}'.`,
        );
      }

      // If a store reports "blocked" but no wait time, use a tiny backoff to
      // avoid a tight CPU loop while still converging quickly.
      const waitTime =
        suggestedWaitMs > 0
          ? Math.min(suggestedWaitMs, remainingWaitBudgetMs)
          : Math.min(25, remainingWaitBudgetMs);

      await wait(waitTime, signal);
    }

    return hasAtomicAcquire;
  }

  /**
   * Wait for all pending background revalidations to complete.
   * Primarily useful in tests to avoid dangling promises.
   */
  async flushRevalidations(): Promise<void> {
    await Promise.allSettled(this.pendingRevalidations);
    this.pendingRevalidations = [];
  }

  private async backgroundRevalidate(
    url: string,
    hash: string,
    entry: CacheEntry<unknown>,
  ): Promise<void> {
    const headers = new Headers();
    if (entry.metadata.etag) {
      headers.set('If-None-Match', entry.metadata.etag);
    }
    if (entry.metadata.lastModified) {
      headers.set('If-Modified-Since', entry.metadata.lastModified);
    }

    try {
      const response = await fetch(url, { headers });
      this.applyServerRateLimitHints(url, response.headers, response.status);

      if (response.status === 304) {
        const refreshed = refreshCacheEntry(entry, response.headers);
        const ttl = this.clampTTL(
          calculateStoreTTL(refreshed.metadata, this.options.defaultCacheTTL),
        );
        await this.stores.cache?.set(hash, refreshed, ttl);
        return;
      }

      if (response.ok) {
        const parsedBody = await this.parseResponseBody(response);
        let data: unknown = parsedBody.data;
        if (this.options.responseTransformer && data) {
          data = this.options.responseTransformer(data);
        }
        if (this.options.responseHandler) {
          data = this.options.responseHandler(data);
        }
        const newEntry = createCacheEntry(
          data,
          response.headers,
          response.status,
        );
        const ttl = this.clampTTL(
          calculateStoreTTL(newEntry.metadata, this.options.defaultCacheTTL),
        );
        await this.stores.cache?.set(hash, newEntry, ttl);
      }
    } catch {
      // Background revalidation failures are silently ignored.
      // The stale entry remains in the cache and will be served until
      // it falls out of the stale-while-revalidate window.
    }
  }

  private clampTTL(ttl: number): number {
    const overrides = this.options.cacheHeaderOverrides;
    if (!overrides) return ttl;
    let clamped = ttl;
    if (overrides.minimumTTL !== undefined) {
      clamped = Math.max(clamped, overrides.minimumTTL);
    }
    if (overrides.maximumTTL !== undefined) {
      clamped = Math.min(clamped, overrides.maximumTTL);
    }
    return clamped;
  }

  private isServerErrorOrNetworkFailure(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'response' in error) {
      const status = (error as ErrorWithResponse).response?.status;
      if (typeof status === 'number' && status >= 500) return true;
    }
    if (error instanceof TypeError) return true;
    return false;
  }

  private generateClientError(err: unknown): Error {
    // If a custom error handler is provided, use it
    if (this.options.errorHandler) {
      return this.options.errorHandler(err);
    }

    if (err instanceof HttpClientError) {
      return err;
    }

    const responseError = err as Partial<ErrorWithResponse>;
    const statusCode =
      typeof responseError.response?.status === 'number'
        ? responseError.response.status
        : undefined;

    const responseData = responseError.response?.data;
    const derivedResponseMessage =
      typeof responseData === 'object' && responseData !== null
        ? (responseData as { message?: unknown }).message
        : undefined;
    const responseMessage =
      typeof derivedResponseMessage === 'string'
        ? derivedResponseMessage
        : undefined;

    const errorMessage =
      err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown }).message === 'string'
          ? (err as { message: string }).message
          : 'Unknown error';
    const message = `${errorMessage}${responseMessage ? `, ${responseMessage}` : ''}`;

    return new HttpClientError(message, statusCode);
  }

  private async parseResponseBody(
    response: Response,
  ): Promise<ParsedResponseBody> {
    if (response.status === 204 || response.status === 205) {
      return { data: undefined };
    }

    const rawBody = await response.text();
    if (!rawBody) {
      return { data: undefined };
    }

    const contentType =
      response.headers.get('content-type')?.toLowerCase() ?? '';
    const shouldAttemptJsonParsing =
      contentType.includes('application/json') ||
      contentType.includes('+json') ||
      rawBody.trimStart().startsWith('{') ||
      rawBody.trimStart().startsWith('[');

    if (!shouldAttemptJsonParsing) {
      return { data: rawBody };
    }

    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return { data: parsed };
      }

      return { data: parsed };
    } catch {
      return { data: rawBody };
    }
  }

  async get<Result>(
    url: string,
    options: { signal?: AbortSignal; priority?: RequestPriority } = {},
  ): Promise<Result> {
    const { signal, priority = 'background' } = options;
    const { endpoint, params } = this.parseUrlForHashing(url);
    const hash = hashRequest(endpoint, params);
    const resource = this.inferResource(url);

    // Track stale entry for conditional requests and stale-if-error fallback
    let staleEntry: CacheEntry<unknown> | undefined;
    let staleCandidate: CacheEntry<unknown> | undefined;

    try {
      await this.enforceServerCooldown(url, signal);

      // 1. Cache — check for cached response
      if (this.stores.cache) {
        const cachedResult = await this.stores.cache.get(hash);

        if (cachedResult !== undefined && isCacheEntry(cachedResult)) {
          const entry = cachedResult as CacheEntry<unknown>;
          const status = getFreshnessStatus(entry.metadata);

          switch (status) {
            case 'fresh':
              return entry.value as Result;

            case 'no-cache':
              if (this.options.cacheHeaderOverrides?.ignoreNoCache) {
                return entry.value as Result;
              }
              staleEntry = entry;
              break;

            case 'must-revalidate':
              staleEntry = entry;
              break;

            case 'stale-while-revalidate': {
              // Serve stale immediately, revalidate in background
              const revalidation = this.backgroundRevalidate(url, hash, entry);
              this.pendingRevalidations.push(revalidation);
              // Cleanup resolved promises periodically
              revalidation.finally(() => {
                this.pendingRevalidations = this.pendingRevalidations.filter(
                  (p) => p !== revalidation,
                );
              });
              return entry.value as Result;
            }

            case 'stale-if-error':
              // Attempt fresh fetch, fall back to stale on error
              staleCandidate = entry;
              staleEntry = entry; // Also use for conditional request
              break;

            case 'stale':
              staleEntry = entry;
              break;
          }
        }
      }

      // 2. Deduplication — check for in-progress request
      if (this.stores.dedupe) {
        const existingResult = await this.stores.dedupe.waitFor(hash);
        if (existingResult !== undefined) {
          return existingResult as Result;
        }

        if (this.stores.dedupe.registerOrJoin) {
          const registration = await this.stores.dedupe.registerOrJoin(hash);

          if (!registration.isOwner) {
            const joinedResult = await this.stores.dedupe.waitFor(hash);
            if (joinedResult !== undefined) {
              return joinedResult as Result;
            }
          }
        } else {
          await this.stores.dedupe.register(hash);
        }
      }

      // 3. Rate limiting — check if request can proceed
      let alreadyRecordedRateLimit = false;
      if (this.stores.rateLimit) {
        alreadyRecordedRateLimit = await this.enforceStoreRateLimit(
          resource,
          priority,
          signal,
        );
      }

      // 4. Execute the actual HTTP request
      // Build conditional headers when we have a stale entry
      const fetchInit: RequestInit = { signal };
      if (staleEntry) {
        const conditionalHeaders = new Headers();
        if (staleEntry.metadata.etag) {
          conditionalHeaders.set('If-None-Match', staleEntry.metadata.etag);
        }
        if (staleEntry.metadata.lastModified) {
          conditionalHeaders.set(
            'If-Modified-Since',
            staleEntry.metadata.lastModified,
          );
        }
        // Only add headers if we actually have validators
        if ([...conditionalHeaders].length > 0) {
          fetchInit.headers = conditionalHeaders;
        }
      }

      const response = await fetch(url, fetchInit);
      this.applyServerRateLimitHints(url, response.headers, response.status);

      // Handle 304 Not Modified — must be checked BEFORE !response.ok
      if (response.status === 304 && staleEntry) {
        const refreshed = refreshCacheEntry(staleEntry, response.headers);
        const ttl = this.clampTTL(
          calculateStoreTTL(refreshed.metadata, this.options.defaultCacheTTL),
        );

        if (this.stores.cache) {
          await this.stores.cache.set(hash, refreshed, ttl);
        }

        const result = refreshed.value as Result;

        if (this.stores.dedupe) {
          await this.stores.dedupe.complete(hash, result);
        }

        return result;
      }

      const parsedBody = await this.parseResponseBody(response);

      if (!response.ok) {
        const error: ErrorWithResponse = {
          message: `Request failed with status ${response.status}`,
          response: {
            status: response.status,
            data: parsedBody.data,
            headers: response.headers,
          },
        };
        throw error;
      }

      // 5. Apply response transformer if provided
      let data: unknown = parsedBody.data;
      if (this.options.responseTransformer && data) {
        data = this.options.responseTransformer(data);
      }

      // 6. Apply response handler if provided (for domain-specific validation)
      if (this.options.responseHandler) {
        data = this.options.responseHandler(data);
      }

      const result = data as Result;

      // 7. Record the request for rate limiting
      if (this.stores.rateLimit && !alreadyRecordedRateLimit) {
        const rateLimit = this.stores.rateLimit as AdaptiveRateLimitStore;
        await rateLimit.record(resource, priority);
      }

      // 8. Cache the result
      if (this.stores.cache) {
        const cc = parseCacheControl(response.headers.get('cache-control'));
        const shouldStore =
          !cc.noStore || this.options.cacheHeaderOverrides?.ignoreNoStore;

        if (shouldStore) {
          const entry = createCacheEntry(
            result,
            response.headers,
            response.status,
          );
          const ttl = this.clampTTL(
            calculateStoreTTL(entry.metadata, this.options.defaultCacheTTL),
          );
          await this.stores.cache.set(hash, entry, ttl);
        }
      }

      // 9. Mark deduplication as complete
      if (this.stores.dedupe) {
        await this.stores.dedupe.complete(hash, result);
      }

      return result;
    } catch (error) {
      // stale-if-error fallback: serve stale entry when origin fails
      if (staleCandidate && this.isServerErrorOrNetworkFailure(error)) {
        const result = staleCandidate.value as Result;

        if (this.stores.dedupe) {
          await this.stores.dedupe.complete(hash, result);
        }

        return result;
      }

      // Mark deduplication as failed
      if (this.stores.dedupe) {
        await this.stores.dedupe.fail(hash, error as Error);
      }

      // Allow callers to detect aborts distinctly – do not wrap AbortError.
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      // Already a processed error from the !response.ok branch above
      if (error instanceof HttpClientError) {
        throw error;
      }

      throw this.generateClientError(error);
    }
  }
}
