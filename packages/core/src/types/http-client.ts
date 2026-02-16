import { RequestPriority } from '../stores/rate-limit-store.js';

export interface HttpErrorContext {
  /** Human-readable description, e.g. `"Request failed with status 404"`. */
  message: string;
  /** The URL that was requested. */
  url: string;
  response: {
    /** HTTP status code (e.g. 404, 500). */
    status: number;
    /**
     * Parsed response body. `undefined` for empty bodies and 204/205 responses.
     * JSON responses are parsed into objects/arrays; non-JSON bodies are returned
     * as raw strings.
     */
    data: unknown;
    /** Response headers. */
    headers: Headers;
  };
}

export interface RetryContext {
  error: Error | HttpErrorContext;
  retryAfterMs?: number;
  statusCode?: number;
  url: string;
}

export interface RetryOptions {
  /** Base delay in milliseconds between retries. Default: 1000 */
  baseDelay?: number;
  /** Jitter strategy. `'full'` adds random jitter, `'none'` uses exact backoff. Default: `'full'` */
  jitter?: 'full' | 'none';
  /** Maximum delay in milliseconds between retries. Default: 30000 */
  maxDelay?: number;
  /** Maximum number of retry attempts. Default: 3 */
  maxRetries?: number;
  /** Called before each retry. Return `false` to stop retrying. */
  onRetry?: (context: RetryContext, attempt: number, delay: number) => void;
  /** Custom condition to determine if a request should be retried. */
  retryCondition?: (context: RetryContext, attempt: number) => boolean;
}

export interface HttpClientContract {
  /**
   * Perform a GET request.
   *
   * @param url     Full request URL
   * @param options Optional configuration – primarily an AbortSignal so
   *                callers can cancel long-running or rate-limited waits.
   */
  get<Result>(
    url: string,
    options?: {
      /**
       * AbortSignal that allows the caller to cancel the request, including any
       * internal rate-limit wait. If the signal is aborted while waiting the
       * promise rejects with an `AbortError`-like `Error` instance.
       */
      signal?: AbortSignal;
      /**
       * Priority level for the request (affects rate limiting behavior)
       */
      priority?: RequestPriority;
      /**
       * Custom headers to send with the request. Also used for Vary-based
       * cache matching — the client captures header values listed in the
       * response's Vary header and checks them on subsequent lookups.
       */
      headers?: Record<string, string>;
      /**
       * Per-request retry configuration. Pass `false` to disable retries for
       * this specific request even if retries are enabled at the constructor level.
       */
      retry?: RetryOptions | false;
    },
  ): Promise<Result>;
}
