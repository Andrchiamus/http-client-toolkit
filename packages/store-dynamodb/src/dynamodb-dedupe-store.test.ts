import {
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  BatchWriteCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DynamoDBDedupeStore } from './dynamodb-dedupe-store.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('DynamoDBDedupeStore', () => {
  let store: DynamoDBDedupeStore;

  beforeEach(() => {
    ddbMock.reset();
    store = new DynamoDBDedupeStore({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      jobTimeoutMs: 300_000,
      pollIntervalMs: 50,
    });
  });

  afterEach(() => {
    store.destroy();
  });

  describe('register and registerOrJoin', () => {
    it('should register new jobs as owner', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      const result = await store.registerOrJoin('test-hash');
      expect(result.isOwner).toBe(true);
      expect(result.jobId).toBeTruthy();
    });

    it('should join existing pending jobs as non-owner', async () => {
      // First call: ConditionalCheckFailedException
      const conditionError = new Error('Condition not met');
      conditionError.name = 'ConditionalCheckFailedException';
      ddbMock.on(PutCommand).rejectsOnce(conditionError);

      // GetCommand to read existing item
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#test-hash',
          sk: 'DEDUPE#test-hash',
          jobId: 'existing-job-id',
          status: 'pending',
        },
      });

      const result = await store.registerOrJoin('test-hash');
      expect(result.isOwner).toBe(false);
      expect(result.jobId).toBe('existing-job-id');
    });

    it('should retry registerOrJoin on race condition (item deleted between put and get)', async () => {
      // First attempt: condition fails
      const conditionError = new Error('Condition not met');
      conditionError.name = 'ConditionalCheckFailedException';
      ddbMock
        .on(PutCommand)
        .rejectsOnce(conditionError)
        // Retry: put succeeds
        .resolvesOnce({});

      // Get returns empty (item deleted)
      ddbMock.on(GetCommand).resolvesOnce({});

      const result = await store.registerOrJoin('test-hash');
      expect(result.isOwner).toBe(true);
    });

    it('should rethrow non-condition errors', async () => {
      ddbMock.on(PutCommand).rejectsOnce(new Error('Access denied'));
      await expect(store.registerOrJoin('test-hash')).rejects.toThrow(
        'Access denied',
      );
    });

    it('should throw a clear error when the table is missing', async () => {
      ddbMock.on(PutCommand).rejectsOnce(
        new ResourceNotFoundException({
          message: 'Requested resource not found',
          $metadata: {},
        }),
      );

      await expect(store.registerOrJoin('test-hash')).rejects.toThrow(
        'was not found. Create the table using your infrastructure',
      );
    });

    it('register delegates to registerOrJoin', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      const jobId = await store.register('test-hash');
      expect(typeof jobId).toBe('string');
    });
  });

  describe('waitFor', () => {
    it('should return undefined for non-existent jobs', async () => {
      ddbMock.on(GetCommand).resolvesOnce({});
      const result = await store.waitFor('non-existent');
      expect(result).toBeUndefined();
    });

    it('should return result for completed jobs', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#test-hash',
          sk: 'DEDUPE#test-hash',
          jobId: 'job-1',
          status: 'completed',
          result: '"test-value"',
        },
      });

      const result = await store.waitFor('test-hash');
      expect(result).toBe('test-value');
    });

    it('should return undefined for failed jobs', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#test-hash',
          sk: 'DEDUPE#test-hash',
          jobId: 'job-1',
          status: 'failed',
          error: 'some error',
        },
      });

      const result = await store.waitFor('test-hash');
      expect(result).toBeUndefined();
    });

    it('should poll for pending jobs until completed', async () => {
      ddbMock
        .on(GetCommand)
        // First call: pending
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#test-hash',
            sk: 'DEDUPE#test-hash',
            jobId: 'job-1',
            status: 'pending',
            createdAt: Date.now(),
          },
        })
        // Poll: still pending
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#test-hash',
            sk: 'DEDUPE#test-hash',
            jobId: 'job-1',
            status: 'pending',
            createdAt: Date.now(),
          },
        })
        // Poll: completed
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#test-hash',
            sk: 'DEDUPE#test-hash',
            jobId: 'job-1',
            status: 'completed',
            result: '"done"',
          },
        });

      const result = await store.waitFor('test-hash');
      expect(result).toBe('done');
    });

    it('should return shared promise for repeated waitFor calls', async () => {
      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#test-hash',
            sk: 'DEDUPE#test-hash',
            jobId: 'job-1',
            status: 'pending',
            createdAt: Date.now(),
          },
        })
        // Poll returns completed
        .resolves({
          Item: {
            pk: 'DEDUPE#test-hash',
            sk: 'DEDUPE#test-hash',
            jobId: 'job-1',
            status: 'completed',
            result: '"shared-result"',
          },
        });

      const p1 = store.waitFor('test-hash');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const p2 = store.waitFor('test-hash');

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('shared-result');
      expect(r2).toBe('shared-result');
    });

    it('should propagate errors when initial get query throws', async () => {
      ddbMock.on(GetCommand).rejectsOnce(new Error('db error'));
      await expect(store.waitFor('fail-hash')).rejects.toThrow('db error');
    });

    it('should settle on poll failure', async () => {
      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#poll-fail',
            sk: 'DEDUPE#poll-fail',
            jobId: 'job-1',
            status: 'pending',
            createdAt: Date.now(),
          },
        })
        // All subsequent polls fail
        .rejects(new Error('poll failure'));

      const result = await store.waitFor('poll-fail');
      expect(result).toBeUndefined();
    });

    it('should settle when polled item disappears', async () => {
      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#disappear',
            sk: 'DEDUPE#disappear',
            jobId: 'job-1',
            status: 'pending',
            createdAt: Date.now(),
          },
        })
        // Poll returns no item
        .resolves({});

      const result = await store.waitFor('disappear');
      expect(result).toBeUndefined();
    });

    it('should settle when poll finds failed status', async () => {
      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#poll-failed',
            sk: 'DEDUPE#poll-failed',
            jobId: 'job-1',
            status: 'pending',
            createdAt: Date.now(),
          },
        })
        .resolves({
          Item: {
            pk: 'DEDUPE#poll-failed',
            sk: 'DEDUPE#poll-failed',
            jobId: 'job-1',
            status: 'failed',
            error: 'some error',
          },
        });

      const result = await store.waitFor('poll-failed');
      expect(result).toBeUndefined();
    });
  });

  describe('complete', () => {
    it('should complete a job with a value', async () => {
      ddbMock.on(UpdateCommand).resolvesOnce({});
      await store.complete('test-hash', 'test-value');
      expect(ddbMock.calls()).toHaveLength(1);
    });

    it('should skip double completion', async () => {
      const error = new Error('The conditional request failed');
      error.name = 'ConditionalCheckFailedException';
      ddbMock.on(UpdateCommand).rejectsOnce(error);
      await store.complete('test-hash', 'new-value');
      // Only 1 call (the conditional update), no error thrown
      expect(ddbMock.calls()).toHaveLength(1);
    });

    it('should handle null and undefined values', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await store.complete('hash-undef', undefined);

      const updateInputUndef =
        ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(updateInputUndef.ExpressionAttributeValues?.[':result']).toBe(
        '__UNDEFINED__',
      );

      // null
      await store.complete('hash-null', null);

      const updateInputNull =
        ddbMock.commandCalls(UpdateCommand)[1]!.args[0].input;
      expect(updateInputNull.ExpressionAttributeValues?.[':result']).toBe(
        '__NULL__',
      );
    });

    it('should throw on circular reference serialization', async () => {
      const circular: { self?: unknown } = {};
      circular.self = circular;

      await expect(
        store.complete('circular', circular as unknown),
      ).rejects.toThrow(/Failed to serialize result/);
    });

    it('should format non-Error serialization failures', async () => {
      const stringifySpy = vi
        .spyOn(JSON, 'stringify')
        .mockImplementation(() => {
          throw 'boom';
        });

      try {
        await expect(
          store.complete('non-error-ser', { value: 'x' } as unknown),
        ).rejects.toThrow(/Failed to serialize result: boom/);
      } finally {
        stringifySpy.mockRestore();
      }
    });

    it('should settle in-memory waiters on complete', async () => {
      let settledWith: unknown = Symbol('unset');
      (
        store as unknown as {
          jobSettlers: Map<string, (value: unknown) => void>;
        }
      ).jobSettlers.set('settler-hash', (value) => {
        settledWith = value;
      });

      ddbMock.on(UpdateCommand).resolvesOnce({});
      await store.complete('settler-hash', 'settled-value');

      expect(settledWith).toBe('settled-value');
    });
  });

  describe('fail', () => {
    it('should fail a job', async () => {
      ddbMock.on(UpdateCommand).resolvesOnce({});
      await store.fail('test-hash', new Error('test error'));

      const updateInput = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(updateInput.ExpressionAttributeValues?.[':error']).toBe(
        'Job failed',
      );
    });

    it('should settle in-memory waiters on fail', async () => {
      let settledWith: unknown = Symbol('unset');
      (
        store as unknown as {
          jobSettlers: Map<string, (value: unknown) => void>;
        }
      ).jobSettlers.set('fail-hash', (value) => {
        settledWith = value;
      });

      ddbMock.on(UpdateCommand).resolvesOnce({});
      await store.fail('fail-hash', new Error('boom'));
      expect(settledWith).toBeUndefined();
    });
  });

  describe('isInProgress', () => {
    it('should return false for non-existent jobs', async () => {
      ddbMock.on(GetCommand).resolvesOnce({});
      expect(await store.isInProgress('non-existent')).toBe(false);
    });

    it('should return true for pending jobs', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#test-hash',
          sk: 'DEDUPE#test-hash',
          status: 'pending',
          createdAt: Date.now(),
        },
      });
      expect(await store.isInProgress('test-hash')).toBe(true);
    });

    it('should return false for completed jobs', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#test-hash',
          sk: 'DEDUPE#test-hash',
          status: 'completed',
          createdAt: Date.now(),
        },
      });
      expect(await store.isInProgress('test-hash')).toBe(false);
    });

    it('should detect and clean up expired jobs', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#expired',
          sk: 'DEDUPE#expired',
          status: 'pending',
          createdAt: Date.now() - 400_000,
        },
      });
      ddbMock.on(DeleteCommand).resolvesOnce({});

      expect(await store.isInProgress('expired')).toBe(false);
      expect(ddbMock.calls()).toHaveLength(2);
    });
  });

  describe('clear', () => {
    it('should clear all dedupe items', async () => {
      ddbMock.on(ScanCommand).resolvesOnce({
        Items: [
          { pk: 'DEDUPE#h1', sk: 'DEDUPE#h1' },
          { pk: 'DEDUPE#h2', sk: 'DEDUPE#h2' },
        ],
      });
      ddbMock.on(BatchWriteCommand).resolvesOnce({});
      await store.clear();
      expect(ddbMock.calls()).toHaveLength(2);
    });

    it('should settle pending waiters on clear', async () => {
      let settledWith: unknown = Symbol('unset');
      (
        store as unknown as {
          jobSettlers: Map<string, (value: unknown) => void>;
        }
      ).jobSettlers.set('clear-hash', (value) => {
        settledWith = value;
      });

      ddbMock.on(ScanCommand).resolvesOnce({ Items: [] });
      await store.clear();
      expect(settledWith).toBeUndefined();
    });
  });

  describe('deserialization', () => {
    it('handles __UNDEFINED__ sentinel', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#undef',
          sk: 'DEDUPE#undef',
          jobId: 'j1',
          status: 'completed',
          result: '__UNDEFINED__',
        },
      });
      const result = await store.waitFor('undef');
      expect(result).toBeUndefined();
    });

    it('handles __NULL__ sentinel', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#null',
          sk: 'DEDUPE#null',
          jobId: 'j1',
          status: 'completed',
          result: '__NULL__',
        },
      });
      const result = await store.waitFor('null');
      expect(result).toBeNull();
    });

    it('handles empty result', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#empty',
          sk: 'DEDUPE#empty',
          jobId: 'j1',
          status: 'completed',
          result: '',
        },
      });
      const result = await store.waitFor('empty');
      expect(result).toBeUndefined();
    });

    it('handles invalid JSON result', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: 'DEDUPE#bad',
          sk: 'DEDUPE#bad',
          jobId: 'j1',
          status: 'completed',
          result: '{bad-json',
        },
      });
      const result = await store.waitFor('bad');
      expect(result).toBeUndefined();
    });
  });

  describe('client management', () => {
    it('should accept raw DynamoDBClient and wrap it', () => {
      const rawClient = new DynamoDBClient({ region: 'us-east-1' });
      const s = new DynamoDBDedupeStore({ client: rawClient });
      expect(s).toBeDefined();
      s.destroy();
    });

    it('should create client internally when none provided', () => {
      const s = new DynamoDBDedupeStore({ region: 'us-west-2' });
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
      await expect(store.waitFor('test')).rejects.toThrow();
      await expect(store.register('test')).rejects.toThrow();
      await expect(store.isInProgress('test')).rejects.toThrow();
      await expect(store.complete('test', 'value')).rejects.toThrow();
      await expect(store.fail('test', new Error('boom'))).rejects.toThrow();
    });

    it('should settle pending waiters on destroy', async () => {
      let settledWith: unknown = Symbol('unset');
      (
        store as unknown as {
          jobSettlers: Map<string, (value: unknown) => void>;
        }
      ).jobSettlers.set('destroy-hash', (value) => {
        settledWith = value;
      });

      await store.close();
      expect(settledWith).toBeUndefined();
    });
  });

  describe('timeout handling', () => {
    it('should mark expired jobs as failed during poll', async () => {
      const shortStore = new DynamoDBDedupeStore({
        client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
        jobTimeoutMs: 10,
        pollIntervalMs: 5,
      });

      // Initial get: pending, old createdAt
      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#timeout',
            sk: 'DEDUPE#timeout',
            jobId: 'j1',
            status: 'pending',
            createdAt: Date.now() - 20,
          },
        })
        // Poll: still pending, expired
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#timeout',
            sk: 'DEDUPE#timeout',
            jobId: 'j1',
            status: 'pending',
            createdAt: Date.now() - 20,
          },
        });

      // Update (marking as failed)
      ddbMock.on(UpdateCommand).resolvesOnce({});

      const result = await shortStore.waitFor('timeout');
      expect(result).toBeUndefined();

      shortStore.destroy();
    });

    it('should handle timeout callback when store is destroyed', async () => {
      const shortStore = new DynamoDBDedupeStore({
        client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
        jobTimeoutMs: 15,
        pollIntervalMs: 100,
      });

      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            pk: 'DEDUPE#timeout-destroy',
            sk: 'DEDUPE#timeout-destroy',
            jobId: 'j1',
            status: 'pending',
            createdAt: Date.now(),
          },
        })
        // Ongoing polls return pending
        .resolves({
          Item: {
            pk: 'DEDUPE#timeout-destroy',
            sk: 'DEDUPE#timeout-destroy',
            jobId: 'j1',
            status: 'pending',
            createdAt: Date.now(),
          },
        });

      const waiting = shortStore.waitFor('timeout-destroy');
      shortStore.destroy();
      await expect(waiting).resolves.toBeUndefined();
    });
  });

  describe('DynamoDB key structure', () => {
    it('should use DEDUPE# prefix for pk and sk', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.register('my-hash');

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.pk).toBe('DEDUPE#my-hash');
      expect(putInput.Item?.sk).toBe('DEDUPE#my-hash');
    });

    it('should include TTL based on jobTimeoutMs', async () => {
      ddbMock.on(PutCommand).resolvesOnce({});
      await store.register('ttl-hash');

      const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(putInput.Item?.ttl).toBeGreaterThan(0);
    });
  });
});
