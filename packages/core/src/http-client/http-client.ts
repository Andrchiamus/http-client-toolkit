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
}

export class HttpClient implements HttpClientContract {
  private _http;
  private stores: HttpClientStores;
  private options: Required<
    Pick<
      HttpClientOptions,
      'defaultCacheTTL' | 'throwOnRateLimit' | 'maxWaitTime'
    >
  > &
    Pick<
      HttpClientOptions,
      'responseTransformer' | 'errorHandler' | 'responseHandler'
    >;

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
    };
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
    const params: Record<string, string> = {};

    urlObj.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    return { endpoint, params };
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
      if (this.stores.rateLimit) {
        const rateLimit = this.stores.rateLimit as AdaptiveRateLimitStore;
        const canProceed = await rateLimit.canProceed(resource, priority);

        if (!canProceed) {
          if (this.options.throwOnRateLimit) {
            const waitTime = await rateLimit.getWaitTime(resource, priority);
            throw new Error(
              `Rate limit exceeded for resource '${resource}'. Wait ${waitTime}ms before retrying.`,
            );
          } else {
            const waitTime = Math.min(
              await rateLimit.getWaitTime(resource, priority),
              this.options.maxWaitTime,
            );
            if (waitTime > 0) {
              await wait(waitTime, signal);
            }
          }
        }
      }

      // 4. Execute the actual HTTP request
      const response = await this._http.get(url, { signal });

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
      if (this.stores.rateLimit) {
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
