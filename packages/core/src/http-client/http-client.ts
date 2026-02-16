import {
  parseCacheControl,
  createCacheEntry,
  refreshCacheEntry,
  isCacheEntry,
  getFreshnessStatus,
  calculateStoreTTL,
  parseVaryHeader,
  captureVaryValues,
  varyMatches,
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
import {
  HttpClientContract,
  type CacheOverrideOptions,
  type HttpErrorContext,
  type RetryContext,
  type RetryOptions,
} from '../types/index.js';

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
   * Custom fetch implementation. Defaults to `globalThis.fetch`.
   * Use this to intercept/transform at the fetch level — e.g., resolving
   * pre-signed URLs or following redirects before the response enters
   * the caching layer.
   */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * Pre-request hook. Runs before every outbound request, allowing
   * modification of the request init (e.g., injecting auth headers,
   * adding tracing headers). Called with the URL and current RequestInit;
   * must return a (possibly modified) RequestInit.
   */
  requestInterceptor?: (
    url: string,
    init: RequestInit,
  ) => Promise<RequestInit> | RequestInit;
  /**
   * Post-response hook. Runs after receiving the raw Response but before
   * response body parsing, transformation, and caching. Use this for
   * logging, modifying headers, or replacing the Response entirely.
   * Distinct from `responseTransformer` which operates on parsed data.
   */
  responseInterceptor?: (
    response: Response,
    url: string,
  ) => Promise<Response> | Response;
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
   * Transforms parsed response data before caching and further processing.
   * Runs on every response (cache miss or revalidation). Use this for
   * structural mapping like converting snake_case keys to camelCase.
   */
  responseTransformer?: (data: unknown) => unknown;
  /**
   * Optional error handler to convert HTTP errors into domain-specific error types.
   * Only called for HTTP errors (non-2xx responses), not for network failures.
   * If not provided, a generic HttpClientError is thrown.
   */
  errorHandler?: (context: HttpErrorContext) => Error;
  /**
   * Post-transformation hook for validation or domain-level error detection.
   * Runs after `responseTransformer` on the final data. Throw to reject
   * responses that are technically 2xx but contain application-level errors
   * (e.g. `{ error_code: 404 }` inside a 200 response). The return value
   * replaces the response data.
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
   * Automatic retry configuration. Pass `false` to disable retries globally.
   * Pass an options object to enable retries with custom settings.
   */
  retry?: RetryOptions | false;
  /**
   * Override specific cache header behaviors.
   */
  cacheOverrides?: CacheOverrideOptions;
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

export {
  type CacheOverrideOptions,
  type HttpErrorContext,
  type RetryContext,
  type RetryOptions,
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
      | 'fetchFn'
      | 'requestInterceptor'
      | 'responseInterceptor'
      | 'responseTransformer'
      | 'errorHandler'
      | 'responseHandler'
      | 'cacheOverrides'
      | 'retry'
    > & {
      rateLimitHeaders: RateLimitHeaderConfig;
    };

  constructor(stores: HttpClientStores = {}, options: HttpClientOptions = {}) {
    this.stores = stores;
    this.options = {
      fetchFn: options.fetchFn,
      requestInterceptor: options.requestInterceptor,
      responseInterceptor: options.responseInterceptor,
      defaultCacheTTL: options.defaultCacheTTL ?? 3600,
      throwOnRateLimit: options.throwOnRateLimit ?? true,
      maxWaitTime: options.maxWaitTime ?? 60000,
      responseTransformer: options.responseTransformer,
      errorHandler: options.errorHandler,
      responseHandler: options.responseHandler,
      retry: options.retry,
      cacheOverrides: options.cacheOverrides,
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
    forceWait = false,
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

      if (this.options.throwOnRateLimit && !forceWait) {
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
    requestHeaders?: Record<string, string>,
    cacheConfig?: {
      defaultCacheTTL: number;
      cacheOverrides?: CacheOverrideOptions;
    },
  ): Promise<void> {
    const fetchHeaders = new Headers(requestHeaders);
    if (entry.metadata.etag) {
      fetchHeaders.set('If-None-Match', entry.metadata.etag);
    }
    if (entry.metadata.lastModified) {
      fetchHeaders.set('If-Modified-Since', entry.metadata.lastModified);
    }

    try {
      let revalInit: RequestInit = { headers: fetchHeaders };
      if (this.options.requestInterceptor) {
        revalInit = await this.options.requestInterceptor(url, revalInit);
      }

      const revalFetchFn = this.options.fetchFn ?? globalThis.fetch;
      let response = await revalFetchFn(url, revalInit);

      if (this.options.responseInterceptor) {
        response = await this.options.responseInterceptor(response, url);
      }

      this.applyServerRateLimitHints(url, response.headers, response.status);

      const resolvedTTL =
        cacheConfig?.defaultCacheTTL ?? this.options.defaultCacheTTL;
      const resolvedOverrides =
        cacheConfig?.cacheOverrides ?? this.options.cacheOverrides;

      if (response.status === 304) {
        const refreshed = refreshCacheEntry(entry, response.headers);
        const ttl = this.clampTTL(
          calculateStoreTTL(refreshed.metadata, resolvedTTL),
          resolvedOverrides,
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
        if (newEntry.metadata.varyHeaders && requestHeaders) {
          const varyFields = parseVaryHeader(newEntry.metadata.varyHeaders);
          newEntry.metadata.varyValues = captureVaryValues(
            varyFields,
            requestHeaders,
          );
        }
        const ttl = this.clampTTL(
          calculateStoreTTL(newEntry.metadata, resolvedTTL),
          resolvedOverrides,
        );
        await this.stores.cache?.set(hash, newEntry, ttl);
      }
    } catch {
      // Background revalidation failures are silently ignored.
      // The stale entry remains in the cache and will be served until
      // it falls out of the stale-while-revalidate window.
    }
  }

  private clampTTL(
    ttl: number,
    overridesParam?: CacheOverrideOptions,
  ): number {
    const overrides = overridesParam ?? this.options.cacheOverrides;
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

  private resolveCacheConfig(
    perRequestTTL?: number,
    perRequestOverrides?: CacheOverrideOptions,
  ): { defaultCacheTTL: number; cacheOverrides?: CacheOverrideOptions } {
    const defaultCacheTTL = perRequestTTL ?? this.options.defaultCacheTTL;

    if (!perRequestOverrides) {
      return { defaultCacheTTL, cacheOverrides: this.options.cacheOverrides };
    }

    const base = this.options.cacheOverrides ?? {};
    return {
      defaultCacheTTL,
      cacheOverrides: {
        ...base,
        ...perRequestOverrides,
      },
    };
  }

  private isServerErrorOrNetworkFailure(error: unknown): boolean {
    if (this.isHttpErrorContext(error)) {
      if (error.response.status >= 500) return true;
    }
    if (error instanceof TypeError) return true;
    return false;
  }

  private generateClientError(err: unknown): Error {
    // HTTP errors: the consumer classifies these
    if (this.isHttpErrorContext(err)) {
      if (this.options.errorHandler) {
        return this.options.errorHandler(err);
      }
      return this.defaultHttpError(err);
    }

    // Non-HTTP errors (network failures, unexpected throws): toolkit owns these
    if (err instanceof Error) {
      return new HttpClientError(err.message);
    }
    return new HttpClientError(String(err));
  }

  private isHttpErrorContext(err: unknown): err is HttpErrorContext {
    return (
      err != null &&
      typeof err === 'object' &&
      'url' in err &&
      'response' in err &&
      typeof (err as HttpErrorContext).response?.status === 'number'
    );
  }

  private defaultHttpError(ctx: HttpErrorContext): HttpClientError {
    const bodyMessage =
      typeof ctx.response.data === 'object' && ctx.response.data !== null
        ? (ctx.response.data as { message?: string }).message
        : undefined;
    const message = bodyMessage
      ? `${ctx.message}, ${bodyMessage}`
      : ctx.message;
    return new HttpClientError(message, ctx.response.status, {
      data: ctx.response.data,
      headers: ctx.response.headers,
    });
  }

  private static RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

  private resolveRetryConfig(
    perRequest?: RetryOptions | false,
  ):
    | (Required<
        Pick<RetryOptions, 'baseDelay' | 'jitter' | 'maxDelay' | 'maxRetries'>
      > &
        Pick<RetryOptions, 'onRetry' | 'retryCondition'>)
    | null {
    // Per-request `false` disables retries for this call
    if (perRequest === false) return null;
    // Constructor `false` disables retries globally
    if (this.options.retry === false) return null;

    const base = (
      typeof this.options.retry === 'object' ? this.options.retry : {}
    ) as RetryOptions;
    const override = (
      typeof perRequest === 'object' ? perRequest : {}
    ) as RetryOptions;

    // No retry config provided at all → retries disabled
    if (this.options.retry === undefined && perRequest === undefined)
      return null;

    return {
      baseDelay: override.baseDelay ?? base.baseDelay ?? 1000,
      jitter: override.jitter ?? base.jitter ?? 'full',
      maxDelay: override.maxDelay ?? base.maxDelay ?? 30000,
      maxRetries: override.maxRetries ?? base.maxRetries ?? 3,
      onRetry: override.onRetry ?? base.onRetry,
      retryCondition: override.retryCondition ?? base.retryCondition,
    };
  }

  private calculateRetryDelay(
    attempt: number,
    baseDelay: number,
    maxDelay: number,
    jitter: 'full' | 'none',
    retryAfterMs?: number,
  ): number {
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, maxDelay);
    const jitteredDelay =
      jitter === 'full' ? Math.floor(Math.random() * cappedDelay) : cappedDelay;
    // Retry-After from server takes precedence when larger
    if (retryAfterMs !== undefined && retryAfterMs > jitteredDelay) {
      return retryAfterMs;
    }
    return jitteredDelay;
  }

  private isRetryableRequest(
    error: Error | HttpErrorContext,
    retryConfig: NonNullable<ReturnType<HttpClient['resolveRetryConfig']>>,
    attempt: number,
    url: string,
  ): { shouldRetry: boolean; context: RetryContext } {
    let statusCode: number | undefined;
    let retryAfterMs: number | undefined;

    if (this.isHttpErrorContext(error)) {
      statusCode = error.response.status;
      const retryAfterRaw = this.getHeaderValue(
        error.response.headers,
        this.options.rateLimitHeaders.retryAfter,
      );
      retryAfterMs = this.parseRetryAfterMs(retryAfterRaw);
    }

    const context: RetryContext = { error, retryAfterMs, statusCode, url };

    // Custom condition overrides default logic
    if (retryConfig.retryCondition) {
      return {
        shouldRetry: retryConfig.retryCondition(context, attempt),
        context,
      };
    }

    // Default: retry on retryable status codes
    if (statusCode !== undefined) {
      return {
        shouldRetry: HttpClient.RETRYABLE_STATUS_CODES.has(statusCode),
        context,
      };
    }

    // Network errors (TypeError) are retryable
    if (error instanceof TypeError) {
      return { shouldRetry: true, context };
    }

    return { shouldRetry: false, context };
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

  private async executeFetch(
    url: string,
    fetchHeaders: Headers,
    signal: AbortSignal | undefined,
    retryConfig: NonNullable<
      ReturnType<HttpClient['resolveRetryConfig']>
    > | null,
    staleEntry: CacheEntry<unknown> | undefined,
  ): Promise<
    | { notModified: true; refreshedEntry: CacheEntry<unknown> }
    | { notModified: false; response: Response; parsedBody: ParsedResponseBody }
  > {
    const maxAttempts = retryConfig ? retryConfig.maxRetries + 1 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Re-check server cooldown between retries — the previous attempt may
      // have set a cooldown via applyServerRateLimitHints. Always wait (never
      // throw) since the retry mechanism is handling recovery.
      if (attempt > 1) {
        await this.enforceServerCooldown(url, signal, true);
      }

      try {
        let fetchInit: RequestInit = { signal };
        if ([...fetchHeaders].length > 0) {
          fetchInit.headers = new Headers(fetchHeaders);
        }

        // Re-run interceptor each attempt (auth tokens may refresh)
        if (this.options.requestInterceptor) {
          fetchInit = await this.options.requestInterceptor(url, fetchInit);
        }

        const fetchFn = this.options.fetchFn ?? globalThis.fetch;
        let response = await fetchFn(url, fetchInit);

        if (this.options.responseInterceptor) {
          response = await this.options.responseInterceptor(response, url);
        }
        this.applyServerRateLimitHints(url, response.headers, response.status);

        // Handle 304 Not Modified — must be checked BEFORE !response.ok
        if (response.status === 304 && staleEntry) {
          return {
            notModified: true,
            refreshedEntry: refreshCacheEntry(staleEntry, response.headers),
          };
        }

        const parsedBody = await this.parseResponseBody(response);

        if (!response.ok) {
          const httpError: HttpErrorContext = {
            message: `Request failed with status ${response.status}`,
            url,
            response: {
              status: response.status,
              data: parsedBody.data,
              headers: response.headers,
            },
          };

          // Check if we should retry this error
          if (retryConfig && attempt < maxAttempts) {
            const { shouldRetry, context } = this.isRetryableRequest(
              httpError,
              retryConfig,
              attempt,
              url,
            );
            if (shouldRetry) {
              const delay = this.calculateRetryDelay(
                attempt,
                retryConfig.baseDelay,
                retryConfig.maxDelay,
                retryConfig.jitter,
                context.retryAfterMs,
              );
              retryConfig.onRetry?.(context, attempt, delay);
              await wait(delay, signal);
              continue;
            }
          }

          throw httpError;
        }

        return { notModified: false, response, parsedBody };
      } catch (fetchError) {
        // AbortError always propagates immediately — no retry
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          throw fetchError;
        }

        // Network errors (TypeError) — may be retryable
        if (
          fetchError instanceof TypeError &&
          retryConfig &&
          attempt < maxAttempts
        ) {
          const { shouldRetry, context } = this.isRetryableRequest(
            fetchError,
            retryConfig,
            attempt,
            url,
          );
          if (shouldRetry) {
            const delay = this.calculateRetryDelay(
              attempt,
              retryConfig.baseDelay,
              retryConfig.maxDelay,
              retryConfig.jitter,
              context.retryAfterMs,
            );
            retryConfig.onRetry?.(context, attempt, delay);
            await wait(delay, signal);
            continue;
          }
        }

        // HttpErrorContext thrown from the !response.ok branch above
        // or other non-retryable errors — propagate
        throw fetchError;
      }
    }

    // TypeScript: unreachable — the loop always returns or throws
    throw new Error('Unexpected end of retry loop');
  }

  async get<Result>(
    url: string,
    options: {
      signal?: AbortSignal;
      priority?: RequestPriority;
      headers?: Record<string, string>;
      retry?: RetryOptions | false;
      cacheTTL?: number;
      cacheOverrides?: CacheOverrideOptions;
    } = {},
  ): Promise<Result> {
    const { signal, priority = 'background', headers } = options;
    const { endpoint, params } = this.parseUrlForHashing(url);
    const hash = hashRequest(endpoint, params);
    const resource = this.inferResource(url);
    const cacheConfig = this.resolveCacheConfig(
      options.cacheTTL,
      options.cacheOverrides,
    );

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

          // Vary mismatch → treat as cache miss
          if (
            !varyMatches(
              entry.metadata.varyValues,
              entry.metadata.varyHeaders,
              headers ?? {},
            )
          ) {
            // fall through to fetch
          } else {
            const status = getFreshnessStatus(entry.metadata);

            switch (status) {
              case 'fresh':
                return entry.value as Result;

              case 'no-cache':
                if (cacheConfig.cacheOverrides?.ignoreNoCache) {
                  return entry.value as Result;
                }
                staleEntry = entry;
                break;

              case 'must-revalidate':
                staleEntry = entry;
                break;

              case 'stale-while-revalidate': {
                // Serve stale immediately, revalidate in background
                const revalidation = this.backgroundRevalidate(
                  url,
                  hash,
                  entry,
                  headers,
                  cacheConfig,
                );
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

      // 4. Execute the actual HTTP request (with optional retry)
      // Build base headers once — conditional headers on top of user headers
      const fetchHeaders = new Headers(headers);
      if (staleEntry) {
        if (staleEntry.metadata.etag) {
          fetchHeaders.set('If-None-Match', staleEntry.metadata.etag);
        }
        if (staleEntry.metadata.lastModified) {
          fetchHeaders.set(
            'If-Modified-Since',
            staleEntry.metadata.lastModified,
          );
        }
      }

      const retryConfig = this.resolveRetryConfig(options.retry);
      const fetchResult = await this.executeFetch(
        url,
        fetchHeaders,
        signal,
        retryConfig,
        staleEntry,
      );

      // Handle 304 Not Modified
      if (fetchResult.notModified) {
        const { refreshedEntry } = fetchResult;
        const ttl = this.clampTTL(
          calculateStoreTTL(
            refreshedEntry.metadata,
            cacheConfig.defaultCacheTTL,
          ),
          cacheConfig.cacheOverrides,
        );

        if (this.stores.cache) {
          await this.stores.cache.set(hash, refreshedEntry, ttl);
        }

        const result = refreshedEntry.value as Result;

        if (this.stores.dedupe) {
          await this.stores.dedupe.complete(hash, result);
        }

        return result;
      }

      const { response, parsedBody } = fetchResult;

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
          !cc.noStore || cacheConfig.cacheOverrides?.ignoreNoStore;

        if (shouldStore) {
          const entry = createCacheEntry(
            result,
            response.headers,
            response.status,
          );
          if (entry.metadata.varyHeaders && headers) {
            const varyFields = parseVaryHeader(entry.metadata.varyHeaders);
            entry.metadata.varyValues = captureVaryValues(varyFields, headers);
          }
          const ttl = this.clampTTL(
            calculateStoreTTL(entry.metadata, cacheConfig.defaultCacheTTL),
            cacheConfig.cacheOverrides,
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
