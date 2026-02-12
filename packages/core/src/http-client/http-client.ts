import axios, { AxiosError } from 'axios';
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
}

interface RateLimitHeaderConfig {
  retryAfter: Array<string>;
  limit: Array<string>;
  remaining: Array<string>;
  reset: Array<string>;
  combined: Array<string>;
}

export class HttpClient implements HttpClientContract {
  private _http;
  private stores: HttpClientStores;
  private serverCooldowns = new Map<string, number>();
  private options: Required<
    Pick<
      HttpClientOptions,
      'defaultCacheTTL' | 'throwOnRateLimit' | 'maxWaitTime'
    >
  > &
    Pick<
      HttpClientOptions,
      'responseTransformer' | 'errorHandler' | 'responseHandler'
    > & {
      rateLimitHeaders: RateLimitHeaderConfig;
    };

  constructor(stores: HttpClientStores = {}, options: HttpClientOptions = {}) {
    this._http = axios.create();
    this.stores = stores;
    this.options = {
      defaultCacheTTL: options.defaultCacheTTL ?? 3600,
      throwOnRateLimit: options.throwOnRateLimit ?? true,
      maxWaitTime: options.maxWaitTime ?? 60000,
      responseTransformer: options.responseTransformer,
      errorHandler: options.errorHandler,
      responseHandler: options.responseHandler,
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
    headers: Record<string, unknown> | undefined,
    names: Array<string>,
  ): string | undefined {
    if (!headers) {
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
    headers: Record<string, unknown> | undefined,
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

  private generateClientError(err: unknown): Error {
    // If a custom error handler is provided, use it
    if (this.options.errorHandler) {
      return this.options.errorHandler(err);
    }

    if (err instanceof HttpClientError) {
      return err;
    }

    const error = err as AxiosError<{ message?: string }>;
    const statusCode = error.response?.status;
    const errorMessage = error.response?.data?.message;
    const message = `${error.message}${errorMessage ? `, ${errorMessage}` : ''}`;

    return new HttpClientError(message, statusCode);
  }

  async get<Result>(
    url: string,
    options: { signal?: AbortSignal; priority?: RequestPriority } = {},
  ): Promise<Result> {
    const { signal, priority = 'background' } = options;
    const { endpoint, params } = this.parseUrlForHashing(url);
    const hash = hashRequest(endpoint, params);
    const resource = this.inferResource(url);

    try {
      await this.enforceServerCooldown(url, signal);

      // 1. Cache - check for cached response
      if (this.stores.cache) {
        const cachedResult = await this.stores.cache.get(hash);
        if (cachedResult !== undefined) {
          return cachedResult as Result;
        }
      }

      // 2. Deduplication - check for in-progress request
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

      // 3. Rate limiting - check if request can proceed
      let alreadyRecordedRateLimit = false;
      if (this.stores.rateLimit) {
        alreadyRecordedRateLimit = await this.enforceStoreRateLimit(
          resource,
          priority,
          signal,
        );
      }

      // 4. Execute the actual HTTP request
      const response = await this._http.get(url, { signal });
      this.applyServerRateLimitHints(
        url,
        response.headers as Record<string, unknown>,
        response.status,
      );

      // 5. Apply response transformer if provided
      let data = response.data;
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
        await this.stores.cache.set(hash, result, this.options.defaultCacheTTL);
      }

      // 9. Mark deduplication as complete
      if (this.stores.dedupe) {
        await this.stores.dedupe.complete(hash, result);
      }

      return result;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        this.applyServerRateLimitHints(
          url,
          axiosError.response.headers as Record<string, unknown>,
          axiosError.response.status,
        );
      }

      // Mark deduplication as failed
      if (this.stores.dedupe) {
        await this.stores.dedupe.fail(hash, error as Error);
      }

      // Allow callers to detect aborts distinctly – do not wrap AbortError.
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      throw this.generateClientError(error);
    }
  }
}
