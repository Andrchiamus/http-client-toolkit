import nock from 'nock';
import { HttpClient } from './http-client.js';
import { HttpClientError } from '../errors/http-client-error.js';

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
    const cacheStoreStub = {
      async get() {
        return { ok: true };
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
    expect(privateClient.getHeaderValue({ 'x-test': ['10'] }, ['x-test'])).toBe(
      '10',
    );
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
});
