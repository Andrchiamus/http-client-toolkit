import nock from 'nock';
import { HttpClient } from './http-client.js';
import { isCacheEntry, type CacheEntry } from '../cache/index.js';
import { HttpClientError } from '../errors/http-client-error.js';
import { hashRequest } from '../stores/index.js';

const baseUrl = 'https://api.example.com';
const alternateBaseUrl = 'https://api-alt.example.com';

describe('HttpClient', () => {
  let httpClient: HttpClient;
  beforeEach(() => {
    httpClient = new HttpClient();
  });

  test('should return a successful response', async () => {
    const mockResponse = { data: [1, 2, 3], status: 'ok' };
    nock(baseUrl).get('/items').reply(200, mockResponse);

    const result = await httpClient.get(`${baseUrl}/items`);

    expect(result).toStrictEqual(mockResponse);
  });

  test('should apply responseTransformer when provided', async () => {
    const mockResponse = { snake_case_key: 'value' };
    nock(baseUrl).get('/transform').reply(200, mockResponse);

    const client = new HttpClient(
      {},
      {
        responseTransformer: (data: unknown) => {
          const obj = data as Record<string, unknown>;
          return { camelCaseKey: obj['snake_case_key'] };
        },
      },
    );

    const result = await client.get<{ camelCaseKey: string }>(
      `${baseUrl}/transform`,
    );
    expect(result.camelCaseKey).toBe('value');
  });

  test('should apply responseHandler when provided', async () => {
    const mockResponse = { error_code: 404, message: 'Not found' };
    nock(baseUrl).get('/handled').reply(200, mockResponse);

    const client = new HttpClient(
      {},
      {
        responseHandler: (data: unknown) => {
          const obj = data as Record<string, unknown>;
          if (obj['error_code'] === 404) {
            throw new HttpClientError('Resource not found', 404);
          }
          return data;
        },
      },
    );

    await expect(client.get(`${baseUrl}/handled`)).rejects.toThrow(
      HttpClientError,
    );
  });

  test('should use custom errorHandler when provided', async () => {
    nock(baseUrl).get('/error').reply(500, { message: 'Server error' });

    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }

    const client = new HttpClient(
      {},
      {
        errorHandler: () => new CustomError('Custom error occurred'),
      },
    );

    await expect(client.get(`${baseUrl}/error`)).rejects.toThrow(CustomError);
  });

  test('should pass HTTP response context to custom errorHandler once', async () => {
    nock(baseUrl)
      .get('/rate-limited')
      .reply(429, { message: 'Too many requests' });

    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }

    let invocations = 0;
    const client = new HttpClient(
      {},
      {
        errorHandler: (error) => {
          invocations += 1;
          const response = (
            error as { response?: { status?: number; data?: unknown } }
          ).response;
          const bodyMessage =
            typeof response?.data === 'object' && response.data !== null
              ? (response.data as { message?: unknown }).message
              : undefined;

          return new CustomError(
            `status=${response?.status}; message=${typeof bodyMessage === 'string' ? bodyMessage : 'n/a'}`,
          );
        },
      },
    );

    await expect(client.get(`${baseUrl}/rate-limited`)).rejects.toThrow(
      /status=429; message=Too many requests/,
    );
    expect(invocations).toBe(1);
  });

  test('should throw HttpClientError on HTTP errors by default', async () => {
    nock(baseUrl)
      .get('/server-error')
      .reply(500, { message: 'Internal error' });

    await expect(httpClient.get(`${baseUrl}/server-error`)).rejects.toThrow(
      HttpClientError,
    );
  });

  test('should throw HttpClientError with status code on HTTP errors', async () => {
    nock(baseUrl).get('/not-found').reply(404);

    try {
      await httpClient.get(`${baseUrl}/not-found`);
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpClientError);
      expect((error as HttpClientError).statusCode).toBe(404);
    }
  });

  test('should throw HttpClientError when request fails with no response', async () => {
    nock(baseUrl).get('/failed-request').replyWithError('Complete failure');

    await expect(httpClient.get(`${baseUrl}/failed-request`)).rejects.toThrow(
      HttpClientError,
    );
  });

  test('should support successful text responses', async () => {
    nock(baseUrl)
      .get('/plain-text')
      .reply(200, 'hello world', { 'Content-Type': 'text/plain' });

    const result = await httpClient.get<string>(`${baseUrl}/plain-text`);

    expect(result).toBe('hello world');
  });

  test('should support successful no-content responses', async () => {
    nock(baseUrl).get('/empty').reply(204);

    const result = await httpClient.get<undefined>(`${baseUrl}/empty`);

    expect(result).toBeUndefined();
  });

  test('should parse JSON-like body when Content-Type is absent', async () => {
    nock(baseUrl).get('/no-content-type').reply(200, '{"id":1}');

    // nock sets Content-Type by default for objects; raw string avoids it
    const result = await httpClient.get<{ id: number }>(
      `${baseUrl}/no-content-type`,
    );
    expect(result).toEqual({ id: 1 });
  });

  test('should return JSON primitive when response is a non-object JSON value', async () => {
    nock(baseUrl)
      .get('/json-primitive')
      .reply(200, '42', { 'Content-Type': 'application/json' });

    const result = await httpClient.get<number>(`${baseUrl}/json-primitive`);
    expect(result).toBe(42);
  });

  test('should return raw body when JSON parsing fails on JSON-like content', async () => {
    nock(baseUrl)
      .get('/bad-json')
      .reply(200, '{invalid json', { 'Content-Type': 'application/json' });

    const result = await httpClient.get<string>(`${baseUrl}/bad-json`);
    expect(result).toBe('{invalid json');
  });

  test('should abort rate-limit wait when signal is aborted', async () => {
    const rateLimitStoreStub = {
      async canProceed() {
        return false;
      },
      async record() {},
      async getStatus() {
        return { remaining: 0, resetTime: new Date(), limit: 60 };
      },
      async reset() {},
      async getWaitTime() {
        return 1_000;
      },
    } as const;

    const client = new HttpClient(
      { rateLimit: rateLimitStoreStub },
      {
        throwOnRateLimit: false,
        maxWaitTime: 5_000,
      },
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.get(`${baseUrl}/items`, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('should enforce Retry-After cooldown from throttled responses', async () => {
    nock(baseUrl)
      .get('/throttled')
      .reply(429, { message: 'Too many requests' }, { 'Retry-After': '1' });

    const client = new HttpClient();

    await expect(client.get(`${baseUrl}/throttled`)).rejects.toThrow(
      HttpClientError,
    );

    await expect(client.get(`${baseUrl}/blocked-by-cooldown`)).rejects.toThrow(
      /Rate limit exceeded for origin/,
    );
  });

  test('should honor non-X RateLimit headers with exhausted remaining quota', async () => {
    nock(baseUrl).get('/quota-status').reply(
      200,
      { ok: true },
      {
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': '1',
      },
    );

    const client = new HttpClient();

    const result = await client.get<{ ok: boolean }>(`${baseUrl}/quota-status`);
    expect(result.ok).toBe(true);

    await expect(client.get(`${baseUrl}/cooldown-active`)).rejects.toThrow(
      /Rate limit exceeded for origin/,
    );
  });

  test('should allow custom non-standard rate-limit header names', async () => {
    nock(baseUrl).get('/custom-headers').reply(
      200,
      { ok: true },
      {
        'Remaining-Requests': '0',
        'Window-Reset-Seconds': '1',
      },
    );

    const client = new HttpClient(
      {},
      {
        rateLimitHeaders: {
          remaining: ['Remaining-Requests'],
          reset: ['Window-Reset-Seconds'],
        },
      },
    );

    const result = await client.get<{ ok: boolean }>(
      `${baseUrl}/custom-headers`,
    );
    expect(result.ok).toBe(true);

    await expect(client.get(`${baseUrl}/custom-cooldown`)).rejects.toThrow(
      /Rate limit exceeded for origin/,
    );
  });

  test('should pass request priority to adaptive rate-limit methods', async () => {
    const priorities: {
      canProceed: Array<string>;
      getWaitTime: Array<string>;
      record: Array<string>;
    } = {
      canProceed: [],
      getWaitTime: [],
      record: [],
    };

    nock(baseUrl).get('/priority-aware').reply(200, { ok: true });

    let canProceedChecks = 0;

    const adaptiveRateLimitStoreStub = {
      async canProceed(_resource: string, priority = 'background') {
        priorities.canProceed.push(priority);
        canProceedChecks += 1;
        return canProceedChecks > 1;
      },
      async record(_resource: string, priority = 'background') {
        priorities.record.push(priority);
      },
      async getStatus() {
        return { remaining: 0, resetTime: new Date(), limit: 60 };
      },
      async reset() {},
      async getWaitTime(_resource: string, priority = 'background') {
        priorities.getWaitTime.push(priority);
        return 0;
      },
    } as const;

    const client = new HttpClient(
      { rateLimit: adaptiveRateLimitStoreStub },
      {
        throwOnRateLimit: false,
      },
    );

    const result = await client.get<{ ok: boolean }>(
      `${baseUrl}/priority-aware`,
      {
        priority: 'user',
      },
    );

    expect(result.ok).toBe(true);
    expect(priorities.canProceed).toEqual(['user', 'user']);
    expect(priorities.getWaitTime).toEqual(['user']);
    expect(priorities.record).toEqual(['user']);
  });

  test('should throw when rate-limit wait exceeds maxWaitTime', async () => {
    const rateLimitStoreStub = {
      async canProceed() {
        return false;
      },
      async record() {},
      async getStatus() {
        return { remaining: 0, resetTime: new Date(), limit: 60 };
      },
      async reset() {},
      async getWaitTime() {
        return 100;
      },
    } as const;

    const client = new HttpClient(
      { rateLimit: rateLimitStoreStub },
      {
        throwOnRateLimit: false,
        maxWaitTime: 30,
      },
    );

    await expect(client.get(`${baseUrl}/never-allowed`)).rejects.toThrow(
      /maxWaitTime/,
    );
  });

  test('should throw immediately when throwOnRateLimit is true and store blocks', async () => {
    const rateLimitStoreStub = {
      async canProceed() {
        return false;
      },
      async record() {},
      async getStatus() {
        return { remaining: 0, resetTime: new Date(), limit: 60 };
      },
      async reset() {},
      async getWaitTime() {
        return 1234;
      },
    } as const;

    const client = new HttpClient(
      { rateLimit: rateLimitStoreStub },
      {
        throwOnRateLimit: true,
      },
    );

    await expect(client.get(`${baseUrl}/blocked-immediately`)).rejects.toThrow(
      /Rate limit exceeded for resource/,
    );
  });

  test('should remain compatible with basic rate-limit stores', async () => {
    nock(baseUrl).get('/basic-rate-limit').reply(200, { ok: true });

    const calls = {
      canProceed: 0,
      getWaitTime: 0,
      record: 0,
    };

    let canProceedChecks = 0;

    const basicRateLimitStoreStub = {
      async canProceed() {
        calls.canProceed += 1;
        canProceedChecks += 1;
        return canProceedChecks > 1;
      },
      async record() {
        calls.record += 1;
      },
      async getStatus() {
        return { remaining: 0, resetTime: new Date(), limit: 60 };
      },
      async reset() {},
      async getWaitTime() {
        calls.getWaitTime += 1;
        return 0;
      },
    } as const;

    const client = new HttpClient(
      { rateLimit: basicRateLimitStoreStub },
      {
        throwOnRateLimit: false,
      },
    );

    const result = await client.get<{ ok: boolean }>(
      `${baseUrl}/basic-rate-limit`,
      {
        priority: 'user',
      },
    );

    expect(result.ok).toBe(true);
    expect(calls.canProceed).toBe(2);
    expect(calls.getWaitTime).toBe(1);
    expect(calls.record).toBe(1);
  });

  test('should generate distinct cache keys for different URL origins', async () => {
    const observedHashes: Array<string> = [];

    nock(baseUrl)
      .get('/same-path')
      .query({ q: '1' })
      .reply(200, { source: 'a' });
    nock(alternateBaseUrl)
      .get('/same-path')
      .query({ q: '1' })
      .reply(200, { source: 'b' });

    const cacheStoreStub = {
      async get() {
        return undefined;
      },
      async set(hash: string) {
        observedHashes.push(hash);
      },
      async delete() {},
      async clear() {},
    } as const;

    const client = new HttpClient({ cache: cacheStoreStub });

    await client.get(`${baseUrl}/same-path?q=1`);
    await client.get(`${alternateBaseUrl}/same-path?q=1`);

    expect(observedHashes).toHaveLength(2);
    expect(observedHashes[0]).not.toBe(observedHashes[1]);
  });

  test('should generate distinct cache keys for repeated query params', async () => {
    const observedHashes: Array<string> = [];

    nock(baseUrl).get('/multi').query(true).times(2).reply(200, { ok: true });

    const cacheStoreStub = {
      async get() {
        return undefined;
      },
      async set(hash: string) {
        observedHashes.push(hash);
      },
      async delete() {},
      async clear() {},
    } as const;

    const client = new HttpClient({ cache: cacheStoreStub });

    await client.get(`${baseUrl}/multi?tag=a&tag=b`);
    await client.get(`${baseUrl}/multi?tag=b`);

    expect(observedHashes).toHaveLength(2);
    expect(observedHashes[0]).not.toBe(observedHashes[1]);
  });

  test('should generate distinct hashes when repeated params have extra values', async () => {
    const observedHashes: Array<string> = [];

    nock(baseUrl)
      .get('/multi-values')
      .query(true)
      .times(2)
      .reply(200, { ok: true });

    const cacheStoreStub = {
      async get() {
        return undefined;
      },
      async set(hash: string) {
        observedHashes.push(hash);
      },
      async delete() {},
      async clear() {},
    } as const;

    const client = new HttpClient({ cache: cacheStoreStub });

    await client.get(`${baseUrl}/multi-values?tag=a&tag=b&tag=c`);
    await client.get(`${baseUrl}/multi-values?tag=a&tag=b`);

    expect(observedHashes).toHaveLength(2);
    expect(observedHashes[0]).not.toBe(observedHashes[1]);
  });

  test('should return cache hit without calling upstream', async () => {
    const freshEntry: CacheEntry = {
      __cacheEntry: true,
      value: { ok: true },
      metadata: {
        cacheControl: {
          noCache: false,
          noStore: false,
          mustRevalidate: false,
          proxyRevalidate: false,
          public: false,
          private: false,
          immutable: false,
          maxAge: 3600,
        },
        responseDate: Date.now(),
        storedAt: Date.now(),
        ageHeader: 0,
        statusCode: 200,
      },
    };

    const cacheStoreStub = {
      async get() {
        return freshEntry;
      },
      async set() {},
      async delete() {},
      async clear() {},
    } as const;

    const client = new HttpClient({ cache: cacheStoreStub });
    const result = await client.get<{ ok: boolean }>(`${baseUrl}/cache-hit`);

    expect(result.ok).toBe(true);
  });

  test('should execute only one upstream request when dedupe supports registerOrJoin', async () => {
    type Deferred = {
      promise: Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    };

    const jobs = new Map<string, Deferred>();
    let registerCalls = 0;

    const dedupeStoreStub = {
      async waitFor(hash: string) {
        const job = jobs.get(hash);
        if (!job) {
          return undefined;
        }

        try {
          return await job.promise;
        } catch {
          return undefined;
        }
      },
      async register(hash: string) {
        const existing = jobs.get(hash);
        if (existing) {
          return 'shared-job';
        }

        let resolve!: (value: unknown) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<unknown>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        jobs.set(hash, { promise, resolve, reject });
        return 'owner-job';
      },
      async registerOrJoin(hash: string) {
        registerCalls += 1;
        const existing = jobs.get(hash);

        if (existing) {
          return { jobId: 'shared-job', isOwner: false };
        }

        let resolve!: (value: unknown) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<unknown>((res, rej) => {
          resolve = res;
          reject = rej;
        });

        jobs.set(hash, { promise, resolve, reject });
        return { jobId: 'owner-job', isOwner: true };
      },
      async complete(hash: string, value: unknown) {
        const job = jobs.get(hash);
        if (job) {
          job.resolve(value);
        }
      },
      async fail(hash: string, error: Error) {
        const job = jobs.get(hash);
        if (job) {
          job.reject(error);
        }
      },
      async isInProgress(hash: string) {
        return jobs.has(hash);
      },
    } as const;

    nock(baseUrl)
      .get('/dedupe-race')
      .query({ page: '1' })
      .delay(50)
      .reply(200, { ok: true });

    const client = new HttpClient({ dedupe: dedupeStoreStub });

    const [resultA, resultB] = await Promise.all([
      client.get<{ ok: boolean }>(`${baseUrl}/dedupe-race?page=1`),
      client.get<{ ok: boolean }>(`${baseUrl}/dedupe-race?page=1`),
    ]);

    expect(resultA).toEqual({ ok: true });
    expect(resultB).toEqual({ ok: true });
    expect(registerCalls).toBe(2);
  });

  test('should return deduped result immediately when waitFor has a value', async () => {
    const dedupeStoreStub = {
      async waitFor() {
        return { from: 'dedupe' };
      },
      async register() {
        return 'job-1';
      },
      async complete() {},
      async fail() {},
      async isInProgress() {
        return true;
      },
    } as const;

    const client = new HttpClient({ dedupe: dedupeStoreStub });
    const result = await client.get<{ from: string }>(`${baseUrl}/not-called`);

    expect(result).toEqual({ from: 'dedupe' });
  });

  test('should call dedupe fail when request errors after register path', async () => {
    const calls = {
      register: 0,
      fail: 0,
    };

    const dedupeStoreStub = {
      async waitFor() {
        return undefined;
      },
      async register() {
        calls.register += 1;
        return 'job-1';
      },
      async complete() {},
      async fail() {
        calls.fail += 1;
      },
      async isInProgress() {
        return true;
      },
    } as const;

    nock(baseUrl)
      .get('/dedupe-failure')
      .reply(503, { message: 'Service unavailable' }, { 'Retry-After': '0' });

    const client = new HttpClient({ dedupe: dedupeStoreStub });

    await expect(client.get(`${baseUrl}/dedupe-failure`)).rejects.toThrow(
      HttpClientError,
    );
    expect(calls.register).toBe(1);
    expect(calls.fail).toBe(1);
  });

  test('should wrap HttpClientError input in generateClientError unchanged', () => {
    const client = new HttpClient() as unknown as {
      generateClientError: (err: unknown) => Error;
    };

    const original = new HttpClientError('already processed', 409);
    expect(client.generateClientError(original)).toBe(original);
  });

  test('should handle non-Error object with message in generateClientError', () => {
    const client = new HttpClient() as unknown as {
      generateClientError: (err: unknown) => Error;
    };

    const result = client.generateClientError({
      message: 'plain object error',
    });
    expect(result).toBeInstanceOf(HttpClientError);
    expect(result.message).toContain('plain object error');
  });

  test('should handle non-Error non-message value in generateClientError', () => {
    const client = new HttpClient() as unknown as {
      generateClientError: (err: unknown) => Error;
    };

    const result = client.generateClientError(42);
    expect(result).toBeInstanceOf(HttpClientError);
    expect(result.message).toContain('Unknown error');
  });

  test('should exercise private header parsing helpers', () => {
    const client = new HttpClient(
      {},
      {
        rateLimitHeaders: {
          retryAfter: ['  retry-after  ', ''],
        },
      },
    );

    const privateClient = client as unknown as {
      normalizeHeaderNames: (
        providedNames: Array<string> | undefined,
        defaultNames: ReadonlyArray<string>,
      ) => Array<string>;
      getHeaderValue: (
        headers: Record<string, unknown> | undefined,
        names: Array<string>,
      ) => string | undefined;
      parseIntegerHeader: (value: string | undefined) => number | undefined;
      parseRetryAfterMs: (value: string | undefined) => number | undefined;
      parseResetMs: (value: string | undefined) => number | undefined;
      parseCombinedRateLimitHeader: (value: string | undefined) => {
        remaining?: number;
        resetMs?: number;
      };
      getOriginScope: (url: string) => string;
      inferResource: (url: string) => string;
    };

    expect(privateClient.normalizeHeaderNames(undefined, ['x-a'])).toEqual([
      'x-a',
    ]);
    expect(privateClient.normalizeHeaderNames(['   '], ['x-a'])).toEqual([
      'x-a',
    ]);
    expect(privateClient.getHeaderValue(undefined, ['x-test'])).toBeUndefined();
    expect(
      privateClient.getHeaderValue({ 'x-test': 'string-val' }, ['x-test']),
    ).toBe('string-val');
    expect(privateClient.getHeaderValue({ 'x-test': ['10'] }, ['x-test'])).toBe(
      '10',
    );
    expect(
      privateClient.getHeaderValue({ other: 'val' }, ['x-missing']),
    ).toBeUndefined();
    expect(privateClient.parseIntegerHeader('-1')).toBeUndefined();
    expect(privateClient.parseIntegerHeader('abc')).toBeUndefined();

    expect(privateClient.parseRetryAfterMs('1')).toBe(1000);
    expect(
      privateClient.parseRetryAfterMs(
        new Date(Date.now() + 1_000).toUTCString(),
      ),
    ).toBeGreaterThan(0);
    expect(privateClient.parseRetryAfterMs('not-a-date')).toBeUndefined();

    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(privateClient.parseResetMs(String(nowSeconds + 2))).toBeGreaterThan(
      0,
    );
    expect(privateClient.parseResetMs('0')).toBe(0);

    expect(privateClient.parseCombinedRateLimitHeader('r=3; t=2')).toEqual({
      remaining: 3,
      resetMs: 2000,
    });
    expect(privateClient.parseCombinedRateLimitHeader('t=2')).toEqual({
      remaining: undefined,
      resetMs: 2000,
    });
    expect(privateClient.parseCombinedRateLimitHeader('r=5')).toEqual({
      remaining: 5,
      resetMs: undefined,
    });
    expect(privateClient.parseCombinedRateLimitHeader(undefined)).toEqual({});

    expect(privateClient.getOriginScope('not-a-url')).toBe('unknown');
    expect(privateClient.inferResource('/still-not-a-url')).toBe('unknown');
    expect(privateClient.inferResource(`${baseUrl}/`)).toBe('unknown');

    const privateApplyClient = client as unknown as {
      applyServerRateLimitHints: (
        url: string,
        headers: Record<string, unknown> | undefined,
        statusCode?: number,
      ) => void;
    };
    expect(() => {
      privateApplyClient.applyServerRateLimitHints(
        `${baseUrl}/no-headers`,
        undefined,
      );
    }).not.toThrow();
  });

  test('should exercise private cooldown and rate-limit helper branches', async () => {
    const allowRateLimitStoreStub = {
      async canProceed() {
        return true;
      },
      async record() {},
      async getStatus() {
        return { remaining: 1, resetTime: new Date(), limit: 60 };
      },
      async reset() {},
      async getWaitTime() {
        return 0;
      },
    } as const;

    const client = new HttpClient(
      { rateLimit: allowRateLimitStoreStub },
      {
        throwOnRateLimit: false,
        maxWaitTime: 50,
      },
    );

    const privateClient = client as unknown as {
      serverCooldowns: Map<string, number>;
      getOriginScope: (url: string) => string;
      enforceServerCooldown: (
        url: string,
        signal?: AbortSignal,
      ) => Promise<void>;
      enforceStoreRateLimit: (
        resource: string,
        priority: 'user' | 'background',
        signal?: AbortSignal,
      ) => Promise<boolean>;
    };

    const scope = privateClient.getOriginScope(baseUrl);
    privateClient.serverCooldowns.set(scope, Date.now() + 1);
    await expect(
      privateClient.enforceServerCooldown(`${baseUrl}/cooldown-wait`),
    ).resolves.toBeUndefined();

    await expect(
      privateClient.enforceStoreRateLimit('items', 'background'),
    ).resolves.toBe(false);
  });

  test('should support non-aborted signals during rate-limit wait', async () => {
    let checks = 0;
    const rateLimitStoreStub = {
      async canProceed() {
        checks += 1;
        return checks > 1;
      },
      async record() {},
      async getStatus() {
        return { remaining: 0, resetTime: new Date(), limit: 60 };
      },
      async reset() {},
      async getWaitTime() {
        return 1;
      },
    } as const;

    nock(baseUrl).get('/signal-wait').reply(200, { ok: true });

    const client = new HttpClient(
      { rateLimit: rateLimitStoreStub },
      {
        throwOnRateLimit: false,
        maxWaitTime: 100,
      },
    );

    const controller = new AbortController();
    const result = await client.get<{ ok: boolean }>(`${baseUrl}/signal-wait`, {
      signal: controller.signal,
    });

    expect(result.ok).toBe(true);
  });

  test('should use atomic acquire when rate-limit store provides it', async () => {
    nock(baseUrl).get('/atomic-acquire').reply(200, { ok: true });

    const acquireStore = {
      async canProceed() {
        return true;
      },
      async acquire() {
        return true;
      },
      async record() {},
      async getStatus() {
        return { remaining: 1, resetTime: new Date(), limit: 60 };
      },
      async reset() {},
      async getWaitTime() {
        return 0;
      },
    } as const;

    const client = new HttpClient(
      { rateLimit: acquireStore },
      { throwOnRateLimit: false },
    );

    const result = await client.get<{ ok: boolean }>(
      `${baseUrl}/atomic-acquire`,
    );
    expect(result.ok).toBe(true);
  });

  test('should exercise remaining private rate-limit edge branches', async () => {
    const allowRateLimitStoreStub = {
      async canProceed() {
        return true;
      },
      async record() {},
      async getStatus() {
        return { remaining: 1, resetTime: new Date(), limit: 60 };
      },
      async reset() {},
      async getWaitTime() {
        return 0;
      },
    } as const;

    const strictClient = new HttpClient(
      { rateLimit: allowRateLimitStoreStub },
      {
        throwOnRateLimit: true,
      },
    );

    const strictPrivate = strictClient as unknown as {
      enforceStoreRateLimit: (
        resource: string,
        priority: 'user' | 'background',
      ) => Promise<boolean>;
    };

    await expect(
      strictPrivate.enforceStoreRateLimit('items', 'user'),
    ).resolves.toBe(false);

    const waitingClient = new HttpClient(
      {},
      {
        throwOnRateLimit: false,
        maxWaitTime: 0,
      },
    );

    const waitingPrivate = waitingClient as unknown as {
      serverCooldowns: Map<string, number>;
      getOriginScope: (url: string) => string;
      enforceServerCooldown: (url: string) => Promise<void>;
    };

    const scope = waitingPrivate.getOriginScope(baseUrl);
    waitingPrivate.serverCooldowns.set(scope, Date.now() + 50);

    await expect(
      waitingPrivate.enforceServerCooldown(`${baseUrl}/max-wait-exceeded`),
    ).rejects.toThrow(/maxWaitTime/);
  });

  describe('cache header support', () => {
    function makeCacheStore() {
      const store = new Map<string, { value: unknown; ttl: number }>();
      return {
        async get(hash: string) {
          const entry = store.get(hash);
          return entry?.value;
        },
        async set(hash: string, value: unknown, ttl: number) {
          store.set(hash, { value, ttl });
        },
        async delete(hash: string) {
          store.delete(hash);
        },
        async clear() {
          store.clear();
        },
        _store: store,
      };
    }

    test('respects max-age and stores CacheEntry envelope', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/data')
        .reply(200, { id: 1 }, { 'Cache-Control': 'max-age=60' });

      await client.get(`${baseUrl}/data`);

      const hash = hashRequest(`${baseUrl}/data`, {});
      const stored = await cache.get(hash);
      expect(isCacheEntry(stored)).toBe(true);
      expect((stored as CacheEntry).value).toEqual({ id: 1 });
    });

    test('returns fresh cached entry without network request', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/fresh')
        .reply(200, { id: 1 }, { 'Cache-Control': 'max-age=3600' });

      const result1 = await client.get(`${baseUrl}/fresh`);
      // No second nock — if it fetches, nock will throw
      const result2 = await client.get(`${baseUrl}/fresh`);

      expect(result1).toEqual({ id: 1 });
      expect(result2).toEqual({ id: 1 });
    });

    test('does not cache when no-store is set', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/no-store')
        .reply(200, { id: 1 }, { 'Cache-Control': 'no-store' });

      await client.get(`${baseUrl}/no-store`);

      const hash = hashRequest(`${baseUrl}/no-store`, {});
      expect(await cache.get(hash)).toBeUndefined();
    });

    test('caches despite no-store when ignoreNoStore is true', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient(
        { cache },
        {
          cacheOverrides: { ignoreNoStore: true },
        },
      );

      nock(baseUrl)
        .get('/ignore-no-store')
        .reply(200, { id: 1 }, { 'Cache-Control': 'no-store, max-age=60' });

      await client.get(`${baseUrl}/ignore-no-store`);

      const hash = hashRequest(`${baseUrl}/ignore-no-store`, {});
      const stored = await cache.get(hash);
      expect(isCacheEntry(stored)).toBe(true);
    });

    test('sends conditional request with If-None-Match for stale entry', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/etag-data')
        .reply(
          200,
          { id: 1 },
          { 'Cache-Control': 'max-age=1', ETag: '"abc123"' },
        );

      await client.get(`${baseUrl}/etag-data`);

      // Advance past freshness
      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl)
        .get('/etag-data')
        .matchHeader('If-None-Match', '"abc123"')
        .reply(304, '', { 'Cache-Control': 'max-age=60' });

      const result = await client.get(`${baseUrl}/etag-data`);
      expect(result).toEqual({ id: 1 });
    });

    test('sends conditional request with If-Modified-Since for stale entry', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl).get('/lm-data').reply(
        200,
        { id: 2 },
        {
          'Cache-Control': 'max-age=1',
          'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
        },
      );

      await client.get(`${baseUrl}/lm-data`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl)
        .get('/lm-data')
        .matchHeader('If-Modified-Since', 'Mon, 01 Jan 2024 00:00:00 GMT')
        .reply(304, '', { 'Cache-Control': 'max-age=60' });

      const result = await client.get(`${baseUrl}/lm-data`);
      expect(result).toEqual({ id: 2 });
    });

    test('re-fetches when stale entry has no validators', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      // No ETag or Last-Modified
      nock(baseUrl)
        .get('/no-validators')
        .reply(200, { v: 1 }, { 'Cache-Control': 'max-age=1' });

      await client.get(`${baseUrl}/no-validators`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl)
        .get('/no-validators')
        .reply(200, { v: 2 }, { 'Cache-Control': 'max-age=60' });

      const result = await client.get(`${baseUrl}/no-validators`);
      expect(result).toEqual({ v: 2 });
    });

    test('returns stale value immediately for stale-while-revalidate', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl).get('/swr').reply(
        200,
        { v: 1 },
        {
          'Cache-Control': 'max-age=1, stale-while-revalidate=120',
          ETag: '"swr1"',
        },
      );

      await client.get(`${baseUrl}/swr`);

      // Advance past freshness but within SWR window
      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      // Background revalidation will happen
      nock(baseUrl)
        .get('/swr')
        .matchHeader('If-None-Match', '"swr1"')
        .reply(304, '', { 'Cache-Control': 'max-age=60' });

      const result = await client.get(`${baseUrl}/swr`);
      expect(result).toEqual({ v: 1 }); // Stale value returned immediately

      await client.flushRevalidations();
    });

    test('background revalidation updates cache on 200', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl).get('/swr-200').reply(
        200,
        { v: 1 },
        {
          'Cache-Control': 'max-age=1, stale-while-revalidate=120',
          ETag: '"old"',
        },
      );

      await client.get(`${baseUrl}/swr-200`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl)
        .get('/swr-200')
        .reply(
          200,
          { v: 2 },
          { 'Cache-Control': 'max-age=300', ETag: '"new"' },
        );

      await client.get(`${baseUrl}/swr-200`);
      await client.flushRevalidations();

      // Cache should now have the new value
      const hash = hashRequest(`${baseUrl}/swr-200`, {});
      const stored = (await cache.get(hash)) as CacheEntry;
      expect(stored.value).toEqual({ v: 2 });
    });

    test('background revalidation sends If-Modified-Since and applies responseTransformer', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient(
        { cache },
        {
          responseTransformer: (data: unknown) => {
            const obj = data as Record<string, unknown>;
            return { transformed: obj['v'] };
          },
        },
      );

      nock(baseUrl).get('/swr-lm').reply(
        200,
        { v: 1 },
        {
          'Cache-Control': 'max-age=1, stale-while-revalidate=120',
          'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
        },
      );

      await client.get(`${baseUrl}/swr-lm`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl)
        .get('/swr-lm')
        .matchHeader('If-Modified-Since', 'Mon, 01 Jan 2024 00:00:00 GMT')
        .reply(200, { v: 2 }, { 'Cache-Control': 'max-age=300' });

      await client.get(`${baseUrl}/swr-lm`);
      await client.flushRevalidations();

      const hash = hashRequest(`${baseUrl}/swr-lm`, {});
      const stored = (await cache.get(hash)) as CacheEntry;
      expect(stored.value).toEqual({ transformed: 2 });
    });

    test('background revalidation applies responseHandler on 200', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient(
        { cache },
        {
          responseHandler: (data: unknown) => {
            const obj = data as Record<string, unknown>;
            return { handled: obj['v'] };
          },
        },
      );

      nock(baseUrl).get('/swr-handler').reply(
        200,
        { v: 1 },
        {
          'Cache-Control': 'max-age=1, stale-while-revalidate=120',
          ETag: '"h1"',
        },
      );

      await client.get(`${baseUrl}/swr-handler`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl)
        .get('/swr-handler')
        .reply(200, { v: 2 }, { 'Cache-Control': 'max-age=300', ETag: '"h2"' });

      await client.get(`${baseUrl}/swr-handler`);
      await client.flushRevalidations();

      const hash = hashRequest(`${baseUrl}/swr-handler`, {});
      const stored = (await cache.get(hash)) as CacheEntry;
      expect(stored.value).toEqual({ handled: 2 });
    });

    test('background revalidation swallows errors silently', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl).get('/swr-fail').reply(
        200,
        { v: 1 },
        {
          'Cache-Control': 'max-age=1, stale-while-revalidate=120',
          ETag: '"e1"',
        },
      );

      await client.get(`${baseUrl}/swr-fail`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl).get('/swr-fail').replyWithError('Network error');

      const result = await client.get(`${baseUrl}/swr-fail`);
      expect(result).toEqual({ v: 1 });

      // Should not throw
      await client.flushRevalidations();
    });

    test('serves stale on 5xx when stale-if-error is set', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/sie')
        .reply(
          200,
          { v: 1 },
          { 'Cache-Control': 'max-age=1, stale-if-error=300' },
        );

      await client.get(`${baseUrl}/sie`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl).get('/sie').reply(500, { message: 'Server error' });

      const result = await client.get(`${baseUrl}/sie`);
      expect(result).toEqual({ v: 1 });
    });

    test('serves stale on network failure when stale-if-error is set', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/sie-net')
        .reply(
          200,
          { v: 1 },
          { 'Cache-Control': 'max-age=1, stale-if-error=300' },
        );

      await client.get(`${baseUrl}/sie-net`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      // Real fetch throws TypeError on network failures.
      // nock's replyWithError creates a regular Error, so we mock fetch directly.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new TypeError('fetch failed'));

      try {
        const result = await client.get(`${baseUrl}/sie-net`);
        expect(result).toEqual({ v: 1 });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('no-cache forces revalidation', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/no-cache')
        .reply(200, { v: 1 }, { 'Cache-Control': 'no-cache', ETag: '"nc1"' });

      await client.get(`${baseUrl}/no-cache`);

      // Even though entry is "fresh", no-cache forces revalidation
      nock(baseUrl)
        .get('/no-cache')
        .matchHeader('If-None-Match', '"nc1"')
        .reply(304, '', { 'Cache-Control': 'no-cache', ETag: '"nc1"' });

      const result = await client.get(`${baseUrl}/no-cache`);
      expect(result).toEqual({ v: 1 });
    });

    test('ignoreNoCache skips revalidation', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient(
        { cache },
        {
          cacheOverrides: { ignoreNoCache: true },
        },
      );

      nock(baseUrl)
        .get('/ignore-no-cache')
        .reply(200, { v: 1 }, { 'Cache-Control': 'no-cache, max-age=3600' });

      await client.get(`${baseUrl}/ignore-no-cache`);

      // No second nock — should return cached value without fetching
      const result = await client.get(`${baseUrl}/ignore-no-cache`);
      expect(result).toEqual({ v: 1 });
    });

    test('clamps TTL with minimumTTL', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient(
        { cache },
        {
          cacheOverrides: { minimumTTL: 300 },
        },
      );

      nock(baseUrl)
        .get('/min-ttl')
        .reply(200, { id: 1 }, { 'Cache-Control': 'max-age=10' });

      await client.get(`${baseUrl}/min-ttl`);

      const hash = hashRequest(`${baseUrl}/min-ttl`, {});
      const entry = cache._store.get(hash);
      expect(entry?.ttl).toBe(300);
    });

    test('clamps TTL with maximumTTL', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient(
        { cache },
        {
          cacheOverrides: { maximumTTL: 60 },
        },
      );

      nock(baseUrl)
        .get('/max-ttl')
        .reply(200, { id: 1 }, { 'Cache-Control': 'max-age=3600' });

      await client.get(`${baseUrl}/max-ttl`);

      const hash = hashRequest(`${baseUrl}/max-ttl`, {});
      const entry = cache._store.get(hash);
      expect(entry?.ttl).toBe(60);
    });

    test('304 response completes dedup for waiting callers', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      let dedupCompleted = false;
      const dedupeStub = {
        async waitFor() {
          return undefined;
        },
        async register() {
          return 'job-1';
        },
        async complete() {
          dedupCompleted = true;
        },
        async fail() {},
        async isInProgress() {
          return true;
        },
      } as const;

      const cache = makeCacheStore();
      const client = new HttpClient({ cache, dedupe: dedupeStub });

      nock(baseUrl)
        .get('/304-dedup')
        .reply(200, { id: 1 }, { 'Cache-Control': 'max-age=1', ETag: '"d1"' });

      await client.get(`${baseUrl}/304-dedup`);
      dedupCompleted = false;

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl)
        .get('/304-dedup')
        .reply(304, '', { 'Cache-Control': 'max-age=60' });

      await client.get(`${baseUrl}/304-dedup`);
      expect(dedupCompleted).toBe(true);
    });

    test('must-revalidate forces revalidation when stale', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl).get('/must-reval').reply(
        200,
        { v: 1 },
        {
          'Cache-Control': 'max-age=1, must-revalidate',
          ETag: '"mr1"',
        },
      );

      await client.get(`${baseUrl}/must-reval`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl)
        .get('/must-reval')
        .matchHeader('If-None-Match', '"mr1"')
        .reply(200, { v: 2 }, { 'Cache-Control': 'max-age=60' });

      const result = await client.get(`${baseUrl}/must-reval`);
      expect(result).toEqual({ v: 2 });
    });

    test('stale-if-error does not swallow 4xx errors', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/sie-4xx')
        .reply(
          200,
          { v: 1 },
          { 'Cache-Control': 'max-age=1, stale-if-error=300' },
        );

      await client.get(`${baseUrl}/sie-4xx`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl).get('/sie-4xx').reply(404);

      await expect(client.get(`${baseUrl}/sie-4xx`)).rejects.toThrow(
        HttpClientError,
      );
    });

    test('applies responseTransformer to cached responses', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient(
        { cache },
        {
          responseTransformer: (data: unknown) => {
            const obj = data as Record<string, unknown>;
            return { transformed: obj['raw'] };
          },
        },
      );

      nock(baseUrl)
        .get('/transform-cache')
        .reply(200, { raw: 'value' }, { 'Cache-Control': 'max-age=60' });

      const result = await client.get(`${baseUrl}/transform-cache`);
      expect(result).toEqual({ transformed: 'value' });

      // Cached value should also be transformed
      const result2 = await client.get(`${baseUrl}/transform-cache`);
      expect(result2).toEqual({ transformed: 'value' });
    });

    test('clampTTL applies both min and max', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient(
        { cache },
        {
          cacheOverrides: { minimumTTL: 100, maximumTTL: 200 },
        },
      );

      // TTL of 50 should be clamped to 100 (minimum)
      nock(baseUrl)
        .get('/clamp-min')
        .reply(200, { id: 1 }, { 'Cache-Control': 'max-age=50' });

      await client.get(`${baseUrl}/clamp-min`);
      const hash1 = hashRequest(`${baseUrl}/clamp-min`, {});
      expect(cache._store.get(hash1)?.ttl).toBe(100);

      // TTL of 500 should be clamped to 200 (maximum)
      nock(baseUrl)
        .get('/clamp-max')
        .reply(200, { id: 2 }, { 'Cache-Control': 'max-age=500' });

      await client.get(`${baseUrl}/clamp-max`);
      const hash2 = hashRequest(`${baseUrl}/clamp-max`, {});
      expect(cache._store.get(hash2)?.ttl).toBe(200);
    });

    test('uses defaultCacheTTL when no cache headers present', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient({ cache }, { defaultCacheTTL: 900 });

      nock(baseUrl).get('/no-headers').reply(200, { id: 1 });

      await client.get(`${baseUrl}/no-headers`);

      const hash = hashRequest(`${baseUrl}/no-headers`, {});
      expect(cache._store.get(hash)?.ttl).toBe(900);
    });

    test('flushRevalidations resolves when no pending revalidations', async () => {
      const client = new HttpClient();
      await expect(client.flushRevalidations()).resolves.toBeUndefined();
    });

    test('stale-if-error completes dedupe on fallback', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      let dedupCompleted = false;
      const dedupeStub = {
        async waitFor() {
          return undefined;
        },
        async register() {
          return 'job-1';
        },
        async complete() {
          dedupCompleted = true;
        },
        async fail() {},
        async isInProgress() {
          return true;
        },
      } as const;

      const cache = makeCacheStore();
      const client = new HttpClient({ cache, dedupe: dedupeStub });

      nock(baseUrl)
        .get('/sie-dedup')
        .reply(
          200,
          { v: 1 },
          { 'Cache-Control': 'max-age=1, stale-if-error=300' },
        );

      await client.get(`${baseUrl}/sie-dedup`);
      dedupCompleted = false;

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl).get('/sie-dedup').reply(500, { message: 'Server error' });

      const result = await client.get(`${baseUrl}/sie-dedup`);
      expect(result).toEqual({ v: 1 });
      expect(dedupCompleted).toBe(true);
    });

    test('isServerErrorOrNetworkFailure helper covers branches', () => {
      const client = new HttpClient();
      const helper = (
        client as unknown as {
          isServerErrorOrNetworkFailure: (error: unknown) => boolean;
        }
      ).isServerErrorOrNetworkFailure;

      expect(helper({ response: { status: 500 } })).toBe(true);
      expect(helper({ response: { status: 503 } })).toBe(true);
      expect(helper({ response: { status: 400 } })).toBe(false);
      expect(helper(new TypeError('fetch failed'))).toBe(true);
      expect(helper(new Error('other'))).toBe(false);
      expect(helper('string error')).toBe(false);
      expect(helper({ response: { status: 'not-a-number' } })).toBe(false);
    });

    test('Vary match returns cached value', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/vary-match')
        .reply(
          200,
          { v: 1 },
          { 'Cache-Control': 'max-age=3600', Vary: 'Accept' },
        );

      await client.get(`${baseUrl}/vary-match`, {
        headers: { accept: 'application/json' },
      });

      // Same Accept header — should return cached value without network request
      const result = await client.get(`${baseUrl}/vary-match`, {
        headers: { accept: 'application/json' },
      });
      expect(result).toEqual({ v: 1 });
    });

    test('Vary mismatch treats as cache miss', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/vary-miss')
        .reply(
          200,
          { v: 1 },
          { 'Cache-Control': 'max-age=3600', Vary: 'Accept' },
        );

      await client.get(`${baseUrl}/vary-miss`, {
        headers: { accept: 'application/json' },
      });

      // Different Accept header — should re-fetch
      nock(baseUrl)
        .get('/vary-miss')
        .reply(
          200,
          { v: 2 },
          { 'Cache-Control': 'max-age=3600', Vary: 'Accept' },
        );

      const result = await client.get(`${baseUrl}/vary-miss`, {
        headers: { accept: 'text/html' },
      });
      expect(result).toEqual({ v: 2 });
    });

    test('Vary: * always misses', async () => {
      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/vary-star')
        .reply(200, { v: 1 }, { 'Cache-Control': 'max-age=3600', Vary: '*' });

      await client.get(`${baseUrl}/vary-star`, {
        headers: { accept: 'application/json' },
      });

      // Even with identical headers, Vary: * always re-fetches
      nock(baseUrl)
        .get('/vary-star')
        .reply(200, { v: 2 }, { 'Cache-Control': 'max-age=3600', Vary: '*' });

      const result = await client.get(`${baseUrl}/vary-star`, {
        headers: { accept: 'application/json' },
      });
      expect(result).toEqual({ v: 2 });
    });

    test('user headers are sent with fetch', async () => {
      const client = new HttpClient();

      nock(baseUrl)
        .get('/custom-headers')
        .matchHeader('x-custom', 'hello')
        .reply(200, { ok: true });

      const result = await client.get(`${baseUrl}/custom-headers`, {
        headers: { 'x-custom': 'hello' },
      });
      expect(result).toEqual({ ok: true });
    });

    test('user headers merged with conditional headers on revalidation', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl)
        .get('/merge-headers')
        .reply(200, { v: 1 }, { 'Cache-Control': 'max-age=1', ETag: '"e1"' });

      await client.get(`${baseUrl}/merge-headers`, {
        headers: { 'x-api-key': 'secret' },
      });

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      // Should send both user header and conditional header
      nock(baseUrl)
        .get('/merge-headers')
        .matchHeader('x-api-key', 'secret')
        .matchHeader('If-None-Match', '"e1"')
        .reply(200, { v: 2 }, { 'Cache-Control': 'max-age=60' });

      const result = await client.get(`${baseUrl}/merge-headers`, {
        headers: { 'x-api-key': 'secret' },
      });
      expect(result).toEqual({ v: 2 });
    });

    test('background revalidation sends user headers', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = makeCacheStore();
      const client = new HttpClient({ cache });

      nock(baseUrl).get('/swr-headers').reply(
        200,
        { v: 1 },
        {
          'Cache-Control': 'max-age=1, stale-while-revalidate=120',
          ETag: '"s1"',
        },
      );

      await client.get(`${baseUrl}/swr-headers`, {
        headers: { 'x-token': 'abc' },
      });

      vi.spyOn(Date, 'now').mockReturnValue(now + 2000);

      // Background revalidation should include user headers
      nock(baseUrl)
        .get('/swr-headers')
        .matchHeader('x-token', 'abc')
        .matchHeader('If-None-Match', '"s1"')
        .reply(
          200,
          { v: 2 },
          { 'Cache-Control': 'max-age=60', Vary: 'X-Token' },
        );

      // SWR returns stale value immediately
      const result = await client.get(`${baseUrl}/swr-headers`, {
        headers: { 'x-token': 'abc' },
      });
      expect(result).toEqual({ v: 1 });

      await client.flushRevalidations();

      // After revalidation, cache should have updated value with Vary match
      const result2 = await client.get(`${baseUrl}/swr-headers`, {
        headers: { 'x-token': 'abc' },
      });
      expect(result2).toEqual({ v: 2 });
    });
  });

  describe('fetchFn', () => {
    test('uses custom fetchFn instead of globalThis.fetch', async () => {
      const mockResponse = new Response(JSON.stringify({ custom: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      const customFetch = vi.fn().mockResolvedValue(mockResponse);
      const client = new HttpClient({}, { fetchFn: customFetch });

      const result = await client.get<{ custom: boolean }>(
        `${baseUrl}/custom-fetch`,
      );

      expect(result).toEqual({ custom: true });
      expect(customFetch).toHaveBeenCalledWith(
        `${baseUrl}/custom-fetch`,
        expect.objectContaining({}),
      );
    });

    test('falls back to globalThis.fetch when fetchFn is not provided', async () => {
      nock(baseUrl).get('/default-fetch').reply(200, { default: true });

      const client = new HttpClient();
      const result = await client.get<{ default: boolean }>(
        `${baseUrl}/default-fetch`,
      );

      expect(result).toEqual({ default: true });
    });

    test('fetchFn receives correct URL and init', async () => {
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;

      const customFetch = vi
        .fn()
        .mockImplementation((url: string, init?: RequestInit) => {
          capturedUrl = url;
          capturedInit = init;
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        });

      const client = new HttpClient({}, { fetchFn: customFetch });
      await client.get(`${baseUrl}/check-args`, {
        headers: { 'x-test': 'value' },
      });

      expect(capturedUrl).toBe(`${baseUrl}/check-args`);
      expect(new Headers(capturedInit?.headers).get('x-test')).toBe('value');
    });

    test('fetchFn errors propagate correctly', async () => {
      const customFetch = vi
        .fn()
        .mockRejectedValue(new Error('Custom fetch failed'));

      const client = new HttpClient({}, { fetchFn: customFetch });

      await expect(client.get(`${baseUrl}/fetch-error`)).rejects.toThrow(
        'Custom fetch failed',
      );
    });
  });

  describe('requestInterceptor', () => {
    test('interceptor can add headers', async () => {
      nock(baseUrl)
        .get('/intercepted')
        .matchHeader('Authorization', 'Bearer token123')
        .reply(200, { authed: true });

      const client = new HttpClient(
        {},
        {
          requestInterceptor: (_url, init) => {
            const headers = new Headers(init.headers);
            headers.set('Authorization', 'Bearer token123');
            return { ...init, headers };
          },
        },
      );

      const result = await client.get<{ authed: boolean }>(
        `${baseUrl}/intercepted`,
      );
      expect(result).toEqual({ authed: true });
    });

    test('interceptor can modify existing init properties', async () => {
      let capturedInit: RequestInit | undefined;

      const customFetch = vi
        .fn()
        .mockImplementation((_url: string, init?: RequestInit) => {
          capturedInit = init;
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        });

      const client = new HttpClient(
        {},
        {
          fetchFn: customFetch,
          requestInterceptor: (_url, init) => ({
            ...init,
            cache: 'no-store' as RequestCache,
          }),
        },
      );

      await client.get(`${baseUrl}/modified-init`);
      expect(capturedInit?.cache).toBe('no-store');
    });

    test('async interceptor is awaited', async () => {
      nock(baseUrl)
        .get('/async-intercepted')
        .matchHeader('X-Async', 'resolved')
        .reply(200, { ok: true });

      const client = new HttpClient(
        {},
        {
          requestInterceptor: async (_url, init) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            const headers = new Headers(init.headers);
            headers.set('X-Async', 'resolved');
            return { ...init, headers };
          },
        },
      );

      const result = await client.get<{ ok: boolean }>(
        `${baseUrl}/async-intercepted`,
      );
      expect(result).toEqual({ ok: true });
    });

    test('no interceptor does not affect default path', async () => {
      nock(baseUrl).get('/no-interceptor').reply(200, { ok: true });

      const client = new HttpClient();
      const result = await client.get<{ ok: boolean }>(
        `${baseUrl}/no-interceptor`,
      );
      expect(result).toEqual({ ok: true });
    });

    test('interceptor errors propagate correctly', async () => {
      const client = new HttpClient(
        {},
        {
          requestInterceptor: () => {
            throw new Error('Interceptor failed');
          },
        },
      );

      await expect(client.get(`${baseUrl}/interceptor-error`)).rejects.toThrow(
        'Interceptor failed',
      );
    });
  });

  describe('responseInterceptor', () => {
    test('interceptor receives the raw Response and URL', async () => {
      let capturedUrl: string | undefined;
      let capturedStatus: number | undefined;

      nock(baseUrl).get('/response-intercepted').reply(200, { v: 1 });

      const client = new HttpClient(
        {},
        {
          responseInterceptor: (response, url) => {
            capturedUrl = url;
            capturedStatus = response.status;
            return response;
          },
        },
      );

      await client.get(`${baseUrl}/response-intercepted`);
      expect(capturedUrl).toBe(`${baseUrl}/response-intercepted`);
      expect(capturedStatus).toBe(200);
    });

    test('interceptor can replace the Response', async () => {
      nock(baseUrl).get('/replace-response').reply(200, { original: true });

      const client = new HttpClient(
        {},
        {
          responseInterceptor: () => {
            return new Response(JSON.stringify({ replaced: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        },
      );

      const result = await client.get<{ replaced: boolean }>(
        `${baseUrl}/replace-response`,
      );
      expect(result).toEqual({ replaced: true });
    });

    test('async interceptor is awaited', async () => {
      nock(baseUrl).get('/async-response').reply(200, { v: 1 });

      const client = new HttpClient(
        {},
        {
          responseInterceptor: async (response) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return response;
          },
        },
      );

      const result = await client.get<{ v: number }>(
        `${baseUrl}/async-response`,
      );
      expect(result).toEqual({ v: 1 });
    });

    test('no interceptor does not affect default path', async () => {
      nock(baseUrl).get('/no-response-interceptor').reply(200, { ok: true });

      const client = new HttpClient();
      const result = await client.get<{ ok: boolean }>(
        `${baseUrl}/no-response-interceptor`,
      );
      expect(result).toEqual({ ok: true });
    });

    test('interceptor errors propagate correctly', async () => {
      nock(baseUrl).get('/response-interceptor-error').reply(200, { ok: true });

      const client = new HttpClient(
        {},
        {
          responseInterceptor: () => {
            throw new Error('Response interceptor failed');
          },
        },
      );

      await expect(
        client.get(`${baseUrl}/response-interceptor-error`),
      ).rejects.toThrow('Response interceptor failed');
    });

    test('interceptor runs before responseTransformer', async () => {
      const callOrder: Array<string> = [];

      nock(baseUrl).get('/order-check').reply(200, { v: 1 });

      const client = new HttpClient(
        {},
        {
          responseInterceptor: (response) => {
            callOrder.push('responseInterceptor');
            return response;
          },
          responseTransformer: (data) => {
            callOrder.push('responseTransformer');
            return data;
          },
        },
      );

      await client.get(`${baseUrl}/order-check`);
      expect(callOrder).toEqual(['responseInterceptor', 'responseTransformer']);
    });
  });

  describe('interceptor integration', () => {
    test('requestInterceptor + responseInterceptor work together', async () => {
      nock(baseUrl)
        .get('/both-interceptors')
        .matchHeader('X-Request', 'added')
        .reply(200, { v: 1 });

      let responseIntercepted = false;

      const client = new HttpClient(
        {},
        {
          requestInterceptor: (_url, init) => {
            const headers = new Headers(init.headers);
            headers.set('X-Request', 'added');
            return { ...init, headers };
          },
          responseInterceptor: (response) => {
            responseIntercepted = true;
            return response;
          },
        },
      );

      const result = await client.get<{ v: number }>(
        `${baseUrl}/both-interceptors`,
      );
      expect(result).toEqual({ v: 1 });
      expect(responseIntercepted).toBe(true);
    });

    test('fetchFn + interceptors compose correctly', async () => {
      const callOrder: Array<string> = [];

      const customFetch = vi
        .fn()
        .mockImplementation((_url: string, _init?: RequestInit) => {
          callOrder.push('fetchFn');
          return Promise.resolve(
            new Response(JSON.stringify({ v: 1 }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        });

      const client = new HttpClient(
        {},
        {
          fetchFn: customFetch,
          requestInterceptor: (_url, init) => {
            callOrder.push('requestInterceptor');
            return init;
          },
          responseInterceptor: (response) => {
            callOrder.push('responseInterceptor');
            return response;
          },
        },
      );

      await client.get(`${baseUrl}/composed`);
      expect(callOrder).toEqual([
        'requestInterceptor',
        'fetchFn',
        'responseInterceptor',
      ]);
    });

    test('cached responses skip fetch and interceptors', async () => {
      const freshEntry: CacheEntry = {
        __cacheEntry: true,
        value: { cached: true },
        metadata: {
          cacheControl: {
            noCache: false,
            noStore: false,
            mustRevalidate: false,
            proxyRevalidate: false,
            public: false,
            private: false,
            immutable: false,
            maxAge: 3600,
          },
          responseDate: Date.now(),
          storedAt: Date.now(),
          ageHeader: 0,
          statusCode: 200,
        },
      };

      const cacheStoreStub = {
        async get() {
          return freshEntry;
        },
        async set() {},
        async delete() {},
        async clear() {},
      } as const;

      const fetchFn = vi.fn();
      const requestInterceptor = vi.fn();
      const responseInterceptor = vi.fn();

      const client = new HttpClient(
        { cache: cacheStoreStub },
        { fetchFn, requestInterceptor, responseInterceptor },
      );

      const result = await client.get<{ cached: boolean }>(
        `${baseUrl}/cached-skip`,
      );
      expect(result).toEqual({ cached: true });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(requestInterceptor).not.toHaveBeenCalled();
      expect(responseInterceptor).not.toHaveBeenCalled();
    });

    test('interceptors apply during background revalidation', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const callOrder: Array<string> = [];

      function makeCacheStore() {
        const store = new Map<string, { value: unknown; ttl: number }>();
        return {
          async get(hash: string) {
            return store.get(hash)?.value;
          },
          async set(hash: string, value: unknown, ttl: number) {
            store.set(hash, { value, ttl });
          },
          async delete(hash: string) {
            store.delete(hash);
          },
          async clear() {
            store.clear();
          },
        };
      }

      const cache = makeCacheStore();
      const client = new HttpClient(
        { cache },
        {
          requestInterceptor: (_url, init) => {
            callOrder.push('requestInterceptor');
            return init;
          },
          responseInterceptor: (response) => {
            callOrder.push('responseInterceptor');
            return response;
          },
        },
      );

      nock(baseUrl).get('/swr-interceptors').reply(
        200,
        { v: 1 },
        {
          'Cache-Control': 'max-age=1, stale-while-revalidate=120',
          ETag: '"i1"',
        },
      );

      await client.get(`${baseUrl}/swr-interceptors`);
      callOrder.length = 0; // Reset after initial fetch

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      nock(baseUrl)
        .get('/swr-interceptors')
        .reply(200, { v: 2 }, { 'Cache-Control': 'max-age=60', ETag: '"i2"' });

      await client.get(`${baseUrl}/swr-interceptors`);
      await client.flushRevalidations();

      expect(callOrder).toEqual(['requestInterceptor', 'responseInterceptor']);
    });

    test('fetchFn is used during background revalidation', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      let bgFetchCalled = false;

      function makeCacheStore() {
        const store = new Map<string, { value: unknown; ttl: number }>();
        return {
          async get(hash: string) {
            return store.get(hash)?.value;
          },
          async set(hash: string, value: unknown, ttl: number) {
            store.set(hash, { value, ttl });
          },
          async delete(hash: string) {
            store.delete(hash);
          },
          async clear() {
            store.clear();
          },
        };
      }

      const cache = makeCacheStore();

      // Use a real nock for the initial request, then a custom fetchFn for bg revalidation
      let fetchCallCount = 0;
      const originalFetch = globalThis.fetch;

      const customFetch = vi
        .fn()
        .mockImplementation((url: string, init?: RequestInit) => {
          fetchCallCount += 1;
          if (fetchCallCount === 1) {
            // First call: use real fetch (nock will intercept)
            return originalFetch(url, init);
          }
          // Second call: background revalidation
          bgFetchCalled = true;
          return Promise.resolve(
            new Response(JSON.stringify({ v: 2 }), {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'max-age=60',
              },
            }),
          );
        });

      const client = new HttpClient({ cache }, { fetchFn: customFetch });

      nock(baseUrl).get('/swr-fetchfn').reply(
        200,
        { v: 1 },
        {
          'Cache-Control': 'max-age=1, stale-while-revalidate=120',
          ETag: '"f1"',
        },
      );

      await client.get(`${baseUrl}/swr-fetchfn`);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);

      await client.get(`${baseUrl}/swr-fetchfn`);
      await client.flushRevalidations();

      expect(bgFetchCalled).toBe(true);
    });
  });
});
