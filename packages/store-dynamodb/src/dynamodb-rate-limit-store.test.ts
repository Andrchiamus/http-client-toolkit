import {
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DynamoDBRateLimitStore } from './dynamodb-rate-limit-store.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('DynamoDBRateLimitStore', () => {
  let store: DynamoDBRateLimitStore;
  const defaultConfig = { limit: 5, windowMs: 1000 };

  beforeEach(() => {
    ddbMock.reset();
    store = new DynamoDBRateLimitStore({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      defaultConfig,
    });
  });

  afterEach(() => {
    store.destroy();
  });

  describe('basic operations', () => {
    it('should allow requests within limit', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Count: 2 });
      const canProceed = await store.canProceed('test-resource');
      expect(canProceed).toBe(true);
    });

    it('should block requests over limit', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Count: 5 });
      const canProceed = await store.canProceed('test-resource');
      expect(canProceed).toBe(false);
    });

    it('should record requests', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.record('test-resource');

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.pk).toBe('RATELIMIT#test-resource');
      expect(putInput.Item?.sk).toMatch(/^TS#\d+#/);
      expect(putInput.Item?.ttl).toBeGreaterThan(0);
    });

    it('should throw a clear error when the table is missing', async () => {
      ddbMock.on(PutCommand).rejectsOnce(
        new ResourceNotFoundException({
          message: 'Requested resource not found',
          $metadata: {},
        }),
      );

      await expect(store.record('missing-table')).rejects.toThrow(
        'was not found. Create the table using your infrastructure',
      );
    });

    it('should provide status information', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Count: 2 });
      const status = await store.getStatus('test-resource');
      expect(status.remaining).toBe(3);
      expect(status.limit).toBe(5);
      expect(status.resetTime).toBeInstanceOf(Date);
    });

    it('should reset rate limits', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({
        Items: [
          { pk: 'RATELIMIT#test', sk: 'TS#123#uuid1' },
          { pk: 'RATELIMIT#test', sk: 'TS#124#uuid2' },
        ],
      });
      ddbMock.on(BatchWriteCommand).resolvesOnce({});

      await store.reset('test');
      expect(ddbMock.calls()).toHaveLength(2);
    });

    it('should handle reset with pagination', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({
          Items: [{ pk: 'RATELIMIT#test', sk: 'TS#1#u1' }],
          LastEvaluatedKey: { pk: 'RATELIMIT#test', sk: 'TS#1#u1' },
        })
        .resolvesOnce({
          Items: [{ pk: 'RATELIMIT#test', sk: 'TS#2#u2' }],
        });
      ddbMock.on(BatchWriteCommand).resolves({});

      await store.reset('test');
      expect(ddbMock.calls()).toHaveLength(4);
    });
  });

  describe('wait time calculation', () => {
    it('should return zero when under limit', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Count: 2 });
      const waitTime = await store.getWaitTime('test-resource');
      expect(waitTime).toBe(0);
    });

    it('should return window time when limit is zero', async () => {
      const zeroLimitStore = new DynamoDBRateLimitStore({
        client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
        defaultConfig: { limit: 0, windowMs: 1000 },
      });
      const waitTime = await zeroLimitStore.getWaitTime('test');
      expect(waitTime).toBe(1000);
      zeroLimitStore.destroy();
    });

    it('should calculate wait time from oldest request', async () => {
      const now = Date.now();
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Count: 5 })
        .resolvesOnce({
          Items: [
            {
              pk: 'RATELIMIT#test',
              sk: `TS#${now - 500}#uuid`,
              timestamp: now - 500,
            },
          ],
        });

      const waitTime = await store.getWaitTime('test');
      expect(waitTime).toBeGreaterThan(0);
      expect(waitTime).toBeLessThanOrEqual(1000);
    });

    it('should return zero when oldest result is missing', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Count: 5 })
        .resolvesOnce({ Items: [] });
      const waitTime = await store.getWaitTime('test');
      expect(waitTime).toBe(0);
    });

    it('should return zero when oldest timestamp is undefined', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Count: 5 })
        .resolvesOnce({
          Items: [{ pk: 'RATELIMIT#test', sk: 'TS#1#uuid' }],
        });
      const waitTime = await store.getWaitTime('test');
      expect(waitTime).toBe(0);
    });
  });

  describe('resource-specific configurations', () => {
    it('should use default config for unspecified resources', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Count: 0 });
      const status = await store.getStatus('unknown-resource');
      expect(status.limit).toBe(defaultConfig.limit);
    });

    it('should use resource-specific configs', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Count: 0 });

      const configStore = new DynamoDBRateLimitStore({
        client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
        defaultConfig,
        resourceConfigs: new Map([['special', { limit: 10, windowMs: 2000 }]]),
      });

      const status = await configStore.getStatus('special');
      expect(status.limit).toBe(10);
      configStore.destroy();
    });

    it('should update resource configs dynamically', () => {
      store.setResourceConfig('dynamic', { limit: 20, windowMs: 5000 });
      expect(store.getResourceConfig('dynamic')).toEqual({
        limit: 20,
        windowMs: 5000,
      });
    });

    it('should return default config for unknown resource', () => {
      expect(store.getResourceConfig('unknown')).toEqual(defaultConfig);
    });
  });

  describe('clear', () => {
    it('should clear all rate limit items', async () => {
      ddbMock.on(ScanCommand).resolvesOnce({
        Items: [
          { pk: 'RATELIMIT#r1', sk: 'TS#1#u1' },
          { pk: 'RATELIMIT#r2', sk: 'TS#2#u2' },
        ],
      });
      ddbMock.on(BatchWriteCommand).resolvesOnce({});
      await store.clear();
      expect(ddbMock.calls()).toHaveLength(2);
    });

    it('should handle clear with empty table', async () => {
      ddbMock.on(ScanCommand).resolvesOnce({ Items: [] });
      await store.clear();
      expect(ddbMock.calls()).toHaveLength(1);
    });

    it('should handle clear with pagination', async () => {
      ddbMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: [{ pk: 'RATELIMIT#r1', sk: 'TS#1#u1' }],
          LastEvaluatedKey: { pk: 'RATELIMIT#r1', sk: 'TS#1#u1' },
        })
        .resolvesOnce({ Items: [] });
      ddbMock.on(BatchWriteCommand).resolvesOnce({});
      await store.clear();
      expect(ddbMock.calls()).toHaveLength(3);
    });
  });

  describe('DynamoDB key structure', () => {
    it('should use RATELIMIT# prefix and TS# sort key', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.record('my-resource');

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.pk).toBe('RATELIMIT#my-resource');
      expect(putInput.Item?.sk).toMatch(/^TS#\d+#[a-f0-9-]+$/);
    });

    it('should use COUNT query for canProceed', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Count: 0 });
      await store.canProceed('test');

      const queryInput = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(queryInput.Select).toBe('COUNT');
      expect(queryInput.KeyConditionExpression).toContain('pk = :pk');
    });

    it('should handle undefined Count in query result', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({});
      const canProceed = await store.canProceed('test');
      expect(canProceed).toBe(true);
    });
  });

  describe('client management', () => {
    it('should accept raw DynamoDBClient', () => {
      const rawClient = new DynamoDBClient({ region: 'us-east-1' });
      const s = new DynamoDBRateLimitStore({ client: rawClient });
      expect(s).toBeDefined();
      s.destroy();
    });

    it('should create client internally when none provided', () => {
      const s = new DynamoDBRateLimitStore({ region: 'us-west-2' });
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
      store.destroy();
      await expect(store.canProceed('test')).rejects.toThrow();
      await expect(store.record('test')).rejects.toThrow();
      await expect(store.getStatus('test')).rejects.toThrow();
      await expect(store.getWaitTime('test')).rejects.toThrow();
      await expect(store.reset('test')).rejects.toThrow();
      await expect(store.clear()).rejects.toThrow();
    });
  });
});
