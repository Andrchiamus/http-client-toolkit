import {
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DynamoDBAdaptiveRateLimitStore } from './dynamodb-adaptive-rate-limit-store.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('DynamoDBAdaptiveRateLimitStore', () => {
  let store: DynamoDBAdaptiveRateLimitStore;
  const defaultConfig = { limit: 200, windowMs: 3600000 };

  beforeEach(() => {
    ddbMock.reset();
    store = new DynamoDBAdaptiveRateLimitStore({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      defaultConfig,
      adaptiveConfig: {
        monitoringWindowMs: 1000,
        highActivityThreshold: 5,
        moderateActivityThreshold: 2,
        recalculationIntervalMs: 100,
        sustainedInactivityThresholdMs: 2000,
        backgroundPauseOnIncreasingTrend: true,
        maxUserScaling: 2.0,
        minUserReserved: 10,
      },
    });
  });

  afterEach(async () => {
    await store.close();
  });

  describe('basic adaptive operations', () => {
    it('should allow user requests with initial state allocation', async () => {
      // ensureActivityMetrics: user query, background query
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] }) // user activity
        .resolvesOnce({ Items: [] }) // background activity
        .resolvesOnce({ Count: 0 }) // getCurrentUsage for user
        .resolvesOnce({ Count: 0 }); // getCurrentUsage for background

      const canProceed = await store.canProceed('test-resource', 'user');
      expect(canProceed).toBe(true);
    });

    it('should allow background requests with initial state allocation', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 });

      const canProceed = await store.canProceed('test-resource', 'background');
      expect(canProceed).toBe(true);
    });

    it('should record user requests with GSI keys', async () => {
      // PutCommand only — record() does not call ensureActivityMetrics
      ddbMock.on(PutCommand).resolvesOnce({});

      await store.record('test-resource', 'user');

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.pk).toBe('RATELIMIT#test-resource');
      expect(putInput.Item?.gsi1pk).toBe('RATELIMIT#test-resource#user');
      expect(putInput.Item?.priority).toBe('user');
    });

    it('should record background requests with GSI keys', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});

      await store.record('test-resource', 'background');

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.gsi1pk).toBe('RATELIMIT#test-resource#background');
      expect(putInput.Item?.priority).toBe('background');
    });

    it('should throw a clear error when the table is missing', async () => {
      ddbMock.on(PutCommand).rejectsOnce(
        new ResourceNotFoundException({
          message: 'Requested resource not found',
          $metadata: {},
        }),
      );

      await expect(store.record('missing-table', 'user')).rejects.toThrow(
        'was not found. Create the table using your infrastructure',
      );
    });
  });

  describe('adaptive capacity allocation', () => {
    it('should start with initial state allocation', async () => {
      // ensureActivityMetrics
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] })
        // getCurrentUsage (user + background)
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 });

      const status = await store.getStatus('test-resource');
      expect(status.adaptive?.userReserved).toBe(60); // 30% of 200
      expect(status.adaptive?.backgroundMax).toBe(140); // 200 - 60
      expect(status.adaptive?.backgroundPaused).toBe(false);
      expect(status.adaptive?.reason).toContain('Initial state');
    });

    it('should block background requests when capacity is exhausted', async () => {
      // Record a background request to populate in-memory metrics
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.record('test-resource', 'background');

      // Force recalculation interval
      (
        store as unknown as { lastCapacityUpdate: Map<string, number> }
      ).lastCapacityUpdate.delete('test-resource');

      // canProceed calls:
      // With 0 user activity and some background activity, calculator gives
      // "No user activity yet" strategy: userReserved=minUserReserved=10, backgroundMax=190
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Count: 0 }) // user usage
        .resolvesOnce({ Count: 190 }); // background at max (190)

      const canProceed = await store.canProceed('test-resource', 'background');
      expect(canProceed).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should provide adaptive status information', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 });

      const status = await store.getStatus('test-resource');
      expect(status).toHaveProperty('remaining');
      expect(status).toHaveProperty('resetTime');
      expect(status).toHaveProperty('limit');
      expect(status).toHaveProperty('adaptive');
      expect(status.adaptive).toHaveProperty('userReserved');
      expect(status.adaptive).toHaveProperty('backgroundMax');
      expect(status.adaptive).toHaveProperty('backgroundPaused');
      expect(status.adaptive).toHaveProperty('recentUserActivity');
      expect(status.adaptive).toHaveProperty('reason');
    });
  });

  describe('getWaitTime', () => {
    it('should return window time when limit is zero', async () => {
      store.setResourceConfig('zero-limit', { limit: 0, windowMs: 3210 });
      await expect(store.getWaitTime('zero-limit')).resolves.toBe(3210);
    });

    it('should return zero when request can proceed', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 });

      const waitTime = await store.getWaitTime('fresh-resource', 'user');
      expect(waitTime).toBe(0);
    });

    it('should return recalculation interval when background is paused', async () => {
      // Set up high user activity to trigger pause
      const metrics = {
        recentUserRequests: Array.from({ length: 10 }, () => Date.now()),
        recentBackgroundRequests: [] as Array<number>,
        userActivityTrend: 'increasing' as const,
      };
      (
        store as unknown as {
          activityMetrics: Map<string, typeof metrics>;
        }
      ).activityMetrics.set('paused-resource', metrics);

      // Force recalculation
      (
        store as unknown as { lastCapacityUpdate: Map<string, number> }
      ).lastCapacityUpdate.delete('paused-resource');

      // canProceed calls
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Count: 0 }) // user
        .resolvesOnce({ Count: 999 }); // background

      const waitTime = await store.getWaitTime('paused-resource', 'background');
      expect(waitTime).toBe(100); // recalculationIntervalMs
    });

    it('should compute wait time from oldest request via GSI', async () => {
      const now = Date.now();

      // Set up metrics so canProceed fails for background
      const metrics = {
        recentUserRequests: [] as Array<number>,
        recentBackgroundRequests: [now - 500],
        userActivityTrend: 'none' as const,
      };
      (
        store as unknown as {
          activityMetrics: Map<string, typeof metrics>;
        }
      ).activityMetrics.set('gsi-resource', metrics);

      store.setResourceConfig('gsi-resource', { limit: 2, windowMs: 5000 });
      (
        store as unknown as { lastCapacityUpdate: Map<string, number> }
      ).lastCapacityUpdate.delete('gsi-resource');

      // canProceed: getCurrentUsage(user) + getCurrentUsage(background)
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Count: 0 }) // user
        .resolvesOnce({ Count: 140 }) // background at max
        // GSI query for oldest
        .resolvesOnce({
          Items: [
            {
              pk: 'RATELIMIT#gsi-resource',
              sk: `TS#${now - 500}#uuid`,
              timestamp: now - 500,
            },
          ],
        });

      const waitTime = await store.getWaitTime('gsi-resource', 'background');
      expect(waitTime).toBeGreaterThan(0);
      expect(waitTime).toBeLessThanOrEqual(5000);
    });

    it('should return zero when GSI query returns no items', async () => {
      const metrics = {
        recentUserRequests: [] as Array<number>,
        recentBackgroundRequests: [Date.now()],
        userActivityTrend: 'none' as const,
      };
      (
        store as unknown as {
          activityMetrics: Map<string, typeof metrics>;
        }
      ).activityMetrics.set('empty-gsi', metrics);

      store.setResourceConfig('empty-gsi', { limit: 2, windowMs: 5000 });
      (
        store as unknown as { lastCapacityUpdate: Map<string, number> }
      ).lastCapacityUpdate.delete('empty-gsi');

      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 140 })
        .resolvesOnce({ Items: [] }); // No oldest

      const waitTime = await store.getWaitTime('empty-gsi', 'background');
      expect(waitTime).toBe(0);
    });

    it('should return zero when oldest timestamp is undefined', async () => {
      const metrics = {
        recentUserRequests: [] as Array<number>,
        recentBackgroundRequests: [Date.now()],
        userActivityTrend: 'none' as const,
      };
      (
        store as unknown as {
          activityMetrics: Map<string, typeof metrics>;
        }
      ).activityMetrics.set('no-ts', metrics);

      store.setResourceConfig('no-ts', { limit: 2, windowMs: 5000 });
      (
        store as unknown as { lastCapacityUpdate: Map<string, number> }
      ).lastCapacityUpdate.delete('no-ts');

      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 140 })
        .resolvesOnce({
          Items: [{ pk: 'RATELIMIT#no-ts', sk: 'TS#1#uuid' }],
        });

      const waitTime = await store.getWaitTime('no-ts', 'background');
      expect(waitTime).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear database and in-memory state', async () => {
      // Set up some in-memory state
      (
        store as unknown as {
          activityMetrics: Map<string, unknown>;
          cachedCapacity: Map<string, unknown>;
          lastCapacityUpdate: Map<string, number>;
        }
      ).activityMetrics.set('reset-resource', {});
      (
        store as unknown as { cachedCapacity: Map<string, unknown> }
      ).cachedCapacity.set('reset-resource', {});
      (
        store as unknown as { lastCapacityUpdate: Map<string, number> }
      ).lastCapacityUpdate.set('reset-resource', Date.now());

      // Query for each partition key (RATELIMIT#, RATELIMIT_SLOT#user, RATELIMIT_SLOT#background)
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] });

      await store.reset('reset-resource');

      expect(
        (
          store as unknown as { activityMetrics: Map<string, unknown> }
        ).activityMetrics.has('reset-resource'),
      ).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all items and in-memory state', async () => {
      ddbMock.on(ScanCommand).resolvesOnce({ Items: [] });
      await store.clear();

      expect(
        (store as unknown as { activityMetrics: Map<string, unknown> })
          .activityMetrics.size,
      ).toBe(0);
    });
  });

  describe('resource configuration', () => {
    it('should support per-resource rate limits', async () => {
      store.setResourceConfig('custom', { limit: 100, windowMs: 1800000 });

      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 });

      const status = await store.getStatus('custom');
      expect(status.limit).toBe(100);
    });

    it('should return configured resource config', () => {
      store.setResourceConfig('cfg', { limit: 77, windowMs: 1234 });
      expect(store.getResourceConfig('cfg')).toEqual({
        limit: 77,
        windowMs: 1234,
      });
    });

    it('should return default config for unknown resource', () => {
      expect(store.getResourceConfig('unknown')).toEqual(defaultConfig);
    });
  });

  describe('cached capacity', () => {
    it('should use cached capacity within recalculation interval', async () => {
      // First call populates cache
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 })
        // Second call should use cached value
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 });

      await store.getStatus('cached-resource');
      const status = await store.getStatus('cached-resource');
      expect(status.adaptive?.reason).toContain('Initial state');
    });

    it('should fall back to default capacity when no cache exists', () => {
      const privateStore = store as unknown as {
        lastCapacityUpdate: Map<string, number>;
        calculateCurrentCapacity: (
          resource: string,
          metrics: {
            recentUserRequests: Array<number>;
            recentBackgroundRequests: Array<number>;
            userActivityTrend: 'none';
          },
        ) => { reason: string };
      };

      privateStore.lastCapacityUpdate.set('default-cap', Date.now());
      const result = privateStore.calculateCurrentCapacity('default-cap', {
        recentUserRequests: [],
        recentBackgroundRequests: [],
        userActivityTrend: 'none',
      });

      expect(result.reason).toContain('Default capacity allocation');
    });
  });

  describe('client management', () => {
    it('should accept raw DynamoDBClient', () => {
      const rawClient = new DynamoDBClient({ region: 'us-east-1' });
      const s = new DynamoDBAdaptiveRateLimitStore({ client: rawClient });
      expect(s).toBeDefined();
      s.destroy();
    });

    it('should create client internally when none provided', () => {
      const s = new DynamoDBAdaptiveRateLimitStore({ region: 'us-west-2' });
      expect(s).toBeDefined();
      s.destroy();
    });
  });

  describe('destroy', () => {
    it('should close without throwing', () => {
      expect(() => store.destroy()).not.toThrow();
    });

    it('should be safe to call destroy multiple times', () => {
      expect(() => {
        store.destroy();
        store.destroy();
      }).not.toThrow();
    });

    it('should throw on operations after destroy', async () => {
      await store.close();
      await expect(store.canProceed('test')).rejects.toThrow();
      await expect(store.record('test')).rejects.toThrow();
      await expect(store.getStatus('test')).rejects.toThrow();
      await expect(store.reset('test')).rejects.toThrow();
      await expect(store.getWaitTime('test')).rejects.toThrow();
      await expect(store.clear()).rejects.toThrow();
    });
  });

  describe('ensureActivityMetrics', () => {
    it('should load metrics from GSI on first access', async () => {
      const now = Date.now();
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({
          Items: [{ timestamp: now - 100 }, { timestamp: now - 200 }],
        }) // user activity
        .resolvesOnce({
          Items: [{ timestamp: now - 300 }],
        }) // background activity
        // Trigger ensureActivityMetrics
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 });

      const status = await store.getStatus('loaded-resource');
      expect(status.adaptive?.recentUserActivity).toBe(2);
    });

    it('should skip loading if metrics already exist', async () => {
      // Pre-populate metrics
      (
        store as unknown as {
          activityMetrics: Map<
            string,
            {
              recentUserRequests: Array<number>;
              recentBackgroundRequests: Array<number>;
              userActivityTrend: string;
            }
          >;
        }
      ).activityMetrics.set('preloaded', {
        recentUserRequests: [Date.now()],
        recentBackgroundRequests: [],
        userActivityTrend: 'none',
      });

      // Only getCurrentUsage calls, no ensureActivityMetrics queries
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 });

      (
        store as unknown as { lastCapacityUpdate: Map<string, number> }
      ).lastCapacityUpdate.delete('preloaded');

      const status = await store.getStatus('preloaded');
      expect(status.adaptive?.recentUserActivity).toBe(1);
      // Should only have 2 calls (getCurrentUsage x2), not 4
      expect(ddbMock.calls()).toHaveLength(2);
    });

    it('should handle empty Items arrays from GSI', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({}) // user: no Items field
        .resolvesOnce({}) // background: no Items field
        .resolvesOnce({ Count: 0 })
        .resolvesOnce({ Count: 0 });

      const status = await store.getStatus('empty-metrics');
      expect(status.adaptive?.recentUserActivity).toBe(0);
    });
  });
});
