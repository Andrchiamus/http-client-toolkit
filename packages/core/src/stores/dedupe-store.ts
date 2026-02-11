/**
 * Interface for deduplicating concurrent API requests
 */
export interface DedupeStore<T = unknown> {
  /**
   * Wait for the result of an existing request if one is in progress
   * @param hash The hash key of the request
   * @returns The result if found, otherwise undefined
   */
  waitFor(hash: string): Promise<T | undefined>;

  /**
   * Register a new request and get a job ID
   * @param hash The hash key of the request
   * @returns A unique job ID for this request
   */
  register(hash: string): Promise<string>;

  /**
   * Atomically register or join an in-flight request.
   *
   * When provided, this allows callers to determine ownership and guarantees
   * that only one caller executes the upstream request while others wait.
   * Implementations that do not provide this method remain compatible, but
   * may allow duplicate upstream requests under extreme races.
   *
   * @param hash The hash key of the request
   * @returns The job id and whether the caller owns execution
   */
  registerOrJoin?(hash: string): Promise<{
    jobId: string;
    isOwner: boolean;
  }>;

  /**
   * Mark a request as complete with its result
   * @param hash The hash key of the request
   * @param value The result of the request
   */
  complete(hash: string, value: T): Promise<void>;

  /**
   * Mark a request as failed with an error
   * @param hash The hash key of the request
   * @param error The error that occurred
   */
  fail(hash: string, error: Error): Promise<void>;

  /**
   * Check if a request is currently in progress
   * @param hash The hash key of the request
   * @returns True if the request is in progress
   */
  isInProgress(hash: string): Promise<boolean>;
}
