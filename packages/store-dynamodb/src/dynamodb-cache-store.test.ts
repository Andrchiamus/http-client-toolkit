import {
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DynamoDBCacheStore } from './dynamodb-cache-store.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('DynamoDBCacheStore', () => {
  let store: DynamoDBCacheStore;

  beforeEach(() => {
    ddbMock.reset();
    store = new DynamoDBCacheStore({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    });
  });

  afterEach(() => {
    store.destroy();
  });

  describe('basic operations', () => {
    it('should set and get values', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.set('key1', 'value1', 60);

      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'CACHE#key1',
          sk: 'CACHE#key1',
          value: '"value1"',
          ttl: Math.floor(Date.now() / 1000) + 60,
          createdAt: Date.now(),
        },
      });
      const value = await store.get('key1');
      expect(value).toBe('value1');
    });

    it('should return undefined for non-existent keys', async () => {
      ddbMock.on(GetCommand).resolvesOnce({});
      const value = await store.get('non-existent');
      expect(value).toBeUndefined();
    });

    it('should delete values', async () => {
      ddbMock.on(DeleteCommand).resolvesOnce({});
      await expect(store.delete('key1')).resolves.not.toThrow();
    });

    it('should handle deletion of non-existent keys', async () => {
      ddbMock.on(DeleteCommand).resolvesOnce({});
      await expect(store.delete('non-existent')).resolves.not.toThrow();
    });

    it('should clear all cache values', async () => {
      ddbMock.on(ScanCommand).resolvesOnce({
        Items: [
          { pk: 'CACHE#k1', sk: 'CACHE#k1' },
          { pk: 'CACHE#k2', sk: 'CACHE#k2' },
        ],
      });
      ddbMock.on(BatchWriteCommand).resolvesOnce({});
      await expect(store.clear()).resolves.not.toThrow();
    });

    it('should handle clear with empty table', async () => {
      ddbMock.on(ScanCommand).resolvesOnce({ Items: [] });
      await expect(store.clear()).resolves.not.toThrow();
    });

    it('should handle clear with pagination', async () => {
      ddbMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: [{ pk: 'CACHE#k1', sk: 'CACHE#k1' }],
          LastEvaluatedKey: { pk: 'CACHE#k1', sk: 'CACHE#k1' },
        })
        .resolvesOnce({
          Items: [{ pk: 'CACHE#k2', sk: 'CACHE#k2' }],
        });
      ddbMock.on(BatchWriteCommand).resolves({});

      await expect(store.clear()).resolves.not.toThrow();
      expect(ddbMock.calls()).toHaveLength(4);
    });

    it('should batch deletes in groups of 25', async () => {
      const items = Array.from({ length: 30 }, (_, i) => ({
        pk: `CACHE#k${i}`,
        sk: `CACHE#k${i}`,
      }));
      ddbMock.on(ScanCommand).resolvesOnce({ Items: items });
      ddbMock.on(BatchWriteCommand).resolves({});

      await store.clear();
      expect(ddbMock.calls()).toHaveLength(3);
    });
  });

  describe('TTL functionality', () => {
    it('should expire values after TTL', async () => {
      const pastTtl = Math.floor(Date.now() / 1000) - 10;
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'CACHE#key1',
          sk: 'CACHE#key1',
          value: '"value1"',
          ttl: pastTtl,
          createdAt: Date.now() - 70000,
        },
      });
      ddbMock.on(DeleteCommand).resolvesOnce({});
      const value = await store.get('key1');
      expect(value).toBeUndefined();
    });

    it('should not expire values before TTL', async () => {
      const futureTtl = Math.floor(Date.now() / 1000) + 3600;
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'CACHE#key1',
          sk: 'CACHE#key1',
          value: '"value1"',
          ttl: futureTtl,
          createdAt: Date.now(),
        },
      });
      const value = await store.get('key1');
      expect(value).toBe('value1');
    });

    it('should handle zero TTL (never expires)', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.set('key1', 'value1', 0);

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.ttl).toBe(0);
    });

    it('should handle negative TTL (immediately expired)', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.set('key1', 'value1', -1);

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      const nowEpoch = Math.floor(Date.now() / 1000);
      expect(putInput.Item?.ttl).toBeCloseTo(nowEpoch, 0);
    });

    it('should not expire items with ttl=0', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'CACHE#key1',
          sk: 'CACHE#key1',
          value: '"permanent"',
          ttl: 0,
          createdAt: Date.now(),
        },
      });
      const value = await store.get('key1');
      expect(value).toBe('permanent');
    });
  });

  describe('data types', () => {
    it('should handle string values', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.set('key1', 'string value', 60);

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.value).toBe('"string value"');
    });

    it('should handle object values', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'CACHE#key1',
          sk: 'CACHE#key1',
          value: '{"id":1,"name":"test"}',
          ttl: Math.floor(Date.now() / 1000) + 60,
          createdAt: Date.now(),
        },
      });
      const value = await store.get('key1');
      expect(value).toEqual({ id: 1, name: 'test' });
    });

    it('should handle null values', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'CACHE#key1',
          sk: 'CACHE#key1',
          value: 'null',
          ttl: Math.floor(Date.now() / 1000) + 60,
          createdAt: Date.now(),
        },
      });
      const value = await store.get('key1');
      expect(value).toBeNull();
    });

    it('should handle undefined values', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.set('key1', undefined, 60);

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.value).toBe('__UNDEFINED__');
    });

    it('should deserialize __UNDEFINED__ sentinel', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'CACHE#key1',
          sk: 'CACHE#key1',
          value: '__UNDEFINED__',
          ttl: Math.floor(Date.now() / 1000) + 60,
          createdAt: Date.now(),
        },
      });
      const value = await store.get('key1');
      expect(value).toBeUndefined();
    });
  });

  describe('size guard', () => {
    it('should skip caching values that exceed maxEntrySizeBytes', async () => {
      const smallStore = new DynamoDBCacheStore({
        client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
        maxEntrySizeBytes: 100,
      });

      const largeValue = 'x'.repeat(200);
      await smallStore.set('too-big', largeValue, 60);

      // PutCommand should NOT have been called
      expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
      smallStore.destroy();
    });

    it('should cache values within maxEntrySizeBytes', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.set('fits', 'small', 60);
      expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 1);
    });
  });

  describe('serialization errors', () => {
    it('should throw on circular reference', async () => {
      const circular: { self?: unknown } = {};
      circular.self = circular;

      await expect(store.set('circular', circular, 60)).rejects.toThrow(
        /Failed to serialize value/,
      );
    });

    it('should format non-Error serialization failures', async () => {
      const stringifySpy = vi
        .spyOn(JSON, 'stringify')
        .mockImplementation(() => {
          throw 'boom';
        });

      try {
        await expect(store.set('fail', 'value', 60)).rejects.toThrow(
          /Failed to serialize value: boom/,
        );
      } finally {
        stringifySpy.mockRestore();
      }
    });

    it('should remove corrupted items on get', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'CACHE#corrupt',
          sk: 'CACHE#corrupt',
          value: '{not-valid-json',
          ttl: Math.floor(Date.now() / 1000) + 60,
          createdAt: Date.now(),
        },
      });
      ddbMock.on(DeleteCommand).resolvesOnce({});

      const value = await store.get('corrupt');
      expect(value).toBeUndefined();
      expect(ddbMock.calls()).toHaveLength(2);
    });
  });

  describe('client management', () => {
    it('should accept DynamoDBDocumentClient directly', () => {
      const s = new DynamoDBCacheStore({
        client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      });
      expect(s).toBeDefined();
      s.destroy();
    });

    it('should accept raw DynamoDBClient and wrap it', () => {
      const rawClient = new DynamoDBClient({ region: 'us-east-1' });
      const s = new DynamoDBCacheStore({ client: rawClient });
      expect(s).toBeDefined();
      s.destroy();
    });

    it('should create client internally when none provided', () => {
      const s = new DynamoDBCacheStore({ region: 'us-west-2' });
      expect(s).toBeDefined();
      s.destroy();
    });

    it('should throw a clear error when the table is missing', async () => {
      ddbMock.on(GetCommand).rejectsOnce(
        new ResourceNotFoundException({
          message: 'Requested resource not found',
          $metadata: {},
        }),
      );

      await expect(store.get('missing')).rejects.toThrow(
        'was not found. Create the table using your infrastructure',
      );
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

      await expect(store.get('key')).rejects.toThrow(
        'Cache store has been destroyed',
      );
      await expect(store.set('key', 'value', 60)).rejects.toThrow(
        'Cache store has been destroyed',
      );
      await expect(store.delete('key')).rejects.toThrow(
        'Cache store has been destroyed',
      );
      await expect(store.clear()).rejects.toThrow(
        'Cache store has been destroyed',
      );
    });
  });

  describe('DynamoDB key structure', () => {
    it('should use CACHE# prefix for pk and sk', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.set('my-hash', 'value', 60);

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.pk).toBe('CACHE#my-hash');
      expect(putInput.Item?.sk).toBe('CACHE#my-hash');
    });

    it('should use correct key structure for get', async () => {
      ddbMock.on(GetCommand).resolvesOnce({});
      await store.get('my-hash');

      const getInput = ddbMock.commandCalls(GetCommand)[0]!.args[0].input;
      expect(getInput.Key?.pk).toBe('CACHE#my-hash');
      expect(getInput.Key?.sk).toBe('CACHE#my-hash');
    });
  });
});
