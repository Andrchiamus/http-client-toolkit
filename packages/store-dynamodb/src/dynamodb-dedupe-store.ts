import { randomUUID } from 'crypto';
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DedupeStore } from '@http-client-toolkit/core';
import { DEFAULT_TABLE_NAME } from './table.js';
import { throwIfDynamoTableMissing } from './table-missing-error.js';
import { batchDeleteWithRetries } from './dynamodb-utils.js';

export interface DynamoDBDedupeStoreOptions {
  client?: DynamoDBDocumentClient | DynamoDBClient;
  region?: string;
  tableName?: string;
  jobTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class DynamoDBDedupeStore<T = unknown> implements DedupeStore<T> {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly rawClient: DynamoDBClient | undefined;
  private readonly isClientManaged: boolean;
  private readonly tableName: string;
  private readonly jobTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly readyPromise: Promise<void>;
  private jobPromises = new Map<string, Promise<T | undefined>>();
  private jobSettlers = new Map<string, (value: T | undefined) => void>();
  private isDestroyed = false;

  constructor({
    client,
    region,
    tableName = DEFAULT_TABLE_NAME,
    jobTimeoutMs = 300_000,
    pollIntervalMs = 500,
  }: DynamoDBDedupeStoreOptions = {}) {
    this.tableName = tableName;
    this.jobTimeoutMs = jobTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;

    if (client instanceof DynamoDBDocumentClient) {
      this.docClient = client;
      this.isClientManaged = false;
    } else if (client instanceof DynamoDBClient) {
      this.docClient = DynamoDBDocumentClient.from(client);
      this.isClientManaged = false;
    } else {
      const config: DynamoDBClientConfig = {};
      if (region) config.region = region;
      this.rawClient = new DynamoDBClient(config);
      this.docClient = DynamoDBDocumentClient.from(this.rawClient);
      this.isClientManaged = true;
    }

    this.readyPromise = Promise.resolve();
  }

  async waitFor(hash: string): Promise<T | undefined> {
    if (this.isDestroyed) {
      throw new Error('Dedupe store has been destroyed');
    }

    await this.readyPromise;

    const existingPromise = this.jobPromises.get(hash);
    if (existingPromise) {
      return existingPromise;
    }

    const pk = `DEDUPE#${hash}`;

    let item: Record<string, unknown> | undefined;
    try {
      const result = await this.docClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk, sk: pk },
        }),
      );
      item = result.Item as Record<string, unknown> | undefined;
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      return undefined;
    }

    if (!item) {
      return undefined;
    }

    if (item['status'] === 'completed') {
      return this.deserializeResult(item['result']);
    }

    if (item['status'] === 'failed') {
      return undefined;
    }

    // Job is pending — poll DynamoDB for completion
    const promise = new Promise<T | undefined>((resolve) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const settle = (value: T | undefined) => {
        if (settled) return;
        settled = true;

        if (timeoutHandle) clearTimeout(timeoutHandle);
        clearInterval(pollHandle);

        this.jobSettlers.delete(hash);
        this.jobPromises.delete(hash);
        resolve(value);
      };

      this.jobSettlers.set(hash, settle);

      const poll = async () => {
        if (this.isDestroyed) {
          settle(undefined);
          return;
        }

        try {
          const latest = await this.docClient.send(
            new GetCommand({
              TableName: this.tableName,
              Key: { pk, sk: pk },
            }),
          );

          const latestItem = latest.Item as Record<string, unknown> | undefined;
          if (!latestItem) {
            settle(undefined);
            return;
          }

          const isExpired =
            this.jobTimeoutMs > 0 &&
            Date.now() - (latestItem['createdAt'] as number) >=
              this.jobTimeoutMs;

          if (isExpired) {
            try {
              await this.docClient.send(
                new UpdateCommand({
                  TableName: this.tableName,
                  Key: { pk, sk: pk },
                  UpdateExpression:
                    'SET #status = :failed, #error = :error, updatedAt = :now',
                  ExpressionAttributeNames: {
                    '#status': 'status',
                    '#error': 'error',
                  },
                  ExpressionAttributeValues: {
                    ':failed': 'failed',
                    ':error': 'Job timed out',
                    ':now': Date.now(),
                  },
                }),
              );
            } catch {
              // Ignore update errors during timeout handling
            }
            settle(undefined);
            return;
          }

          if (latestItem['status'] === 'completed') {
            settle(this.deserializeResult(latestItem['result']));
            return;
          }

          if (latestItem['status'] === 'failed') {
            settle(undefined);
          }
        } catch {
          settle(undefined);
        }
      };

      let isPolling = false;

      const pollHandle = setInterval(() => {
        if (isPolling) {
          return;
        }

        isPolling = true;
        void poll().finally(() => {
          isPolling = false;
        });
      }, this.pollIntervalMs);

      if (typeof pollHandle.unref === 'function') {
        pollHandle.unref();
      }

      void poll();

      if (this.jobTimeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (this.isDestroyed) {
            settle(undefined);
            return;
          }

          void (async () => {
            try {
              await this.docClient.send(
                new UpdateCommand({
                  TableName: this.tableName,
                  Key: { pk, sk: pk },
                  UpdateExpression:
                    'SET #status = :failed, #error = :error, updatedAt = :now',
                  ExpressionAttributeNames: {
                    '#status': 'status',
                    '#error': 'error',
                  },
                  ExpressionAttributeValues: {
                    ':failed': 'failed',
                    ':error': 'Job timed out',
                    ':now': Date.now(),
                  },
                }),
              );
            } catch {
              // Ignore DB errors on timeout settlement
            } finally {
              settle(undefined);
            }
          })();
        }, this.jobTimeoutMs);

        if (typeof timeoutHandle.unref === 'function') {
          timeoutHandle.unref();
        }
      }
    });

    this.jobPromises.set(hash, promise);
    return promise;
  }

  async register(hash: string): Promise<string> {
    const registration = await this.registerOrJoin(hash);
    return registration.jobId;
  }

  async registerOrJoin(
    hash: string,
  ): Promise<{ jobId: string; isOwner: boolean }> {
    if (this.isDestroyed) {
      throw new Error('Dedupe store has been destroyed');
    }

    await this.readyPromise;

    const pk = `DEDUPE#${hash}`;
    const candidateJobId = randomUUID();
    const now = Date.now();
    const ttl =
      this.jobTimeoutMs > 0 ? Math.floor((now + this.jobTimeoutMs) / 1000) : 0;

    // Conditional put: only succeed if item doesn't exist or isn't pending
    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk,
            sk: pk,
            jobId: candidateJobId,
            status: 'pending',
            result: null,
            error: null,
            createdAt: now,
            updatedAt: now,
            ttl,
          },
          ConditionExpression:
            'attribute_not_exists(pk) OR #status <> :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':pending': 'pending' },
        }),
      );

      return { jobId: candidateJobId, isOwner: true };
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      // ConditionalCheckFailedException means a pending job already exists
      if (
        error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'ConditionalCheckFailedException'
      ) {
        // Read the existing item to get its jobId
        const existing = await this.docClient.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk, sk: pk },
          }),
        );

        if (existing.Item) {
          return {
            jobId: existing.Item['jobId'] as string,
            isOwner: false,
          };
        }

        // Race condition: item was deleted between the failed put and the get
        // Try again
        return this.registerOrJoin(hash);
      }
      throw error;
    }
  }

  async complete(hash: string, value: T | undefined): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Dedupe store has been destroyed');
    }

    await this.readyPromise;

    let serializedResult: string;
    if (value === undefined) {
      serializedResult = '__UNDEFINED__';
    } else if (value === null) {
      serializedResult = '__NULL__';
    } else {
      try {
        serializedResult = JSON.stringify(value);
      } catch (error) {
        throw new Error(
          `Failed to serialize result: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const pk = `DEDUPE#${hash}`;

    // Check if already completed to prevent double completion
    let existing;
    try {
      existing = await this.docClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk, sk: pk },
        }),
      );
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      throw error;
    }

    if (existing.Item && existing.Item['status'] === 'completed') {
      return;
    }

    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk, sk: pk },
          UpdateExpression:
            'SET #status = :completed, #result = :result, updatedAt = :now',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#result': 'result',
          },
          ExpressionAttributeValues: {
            ':completed': 'completed',
            ':result': serializedResult,
            ':now': Date.now(),
          },
        }),
      );
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      throw error;
    }

    // Resolve any waiting promises in this process immediately
    const settle = this.jobSettlers.get(hash);
    if (settle) {
      settle(value);
    }
  }

  async fail(hash: string, error: Error): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Dedupe store has been destroyed');
    }

    await this.readyPromise;

    const pk = `DEDUPE#${hash}`;

    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk, sk: pk },
          UpdateExpression:
            'SET #status = :failed, #error = :error, updatedAt = :now',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#error': 'error',
          },
          ExpressionAttributeValues: {
            ':failed': 'failed',
            ':error': 'Job failed',
            ':now': Date.now(),
          },
        }),
      );
    } catch (dynamoError: unknown) {
      throwIfDynamoTableMissing(dynamoError, this.tableName);
      throw dynamoError;
    }

    // Resolve waiters to undefined on failure
    const settle = this.jobSettlers.get(hash);
    if (settle) {
      settle(undefined);
    }
  }

  async isInProgress(hash: string): Promise<boolean> {
    if (this.isDestroyed) {
      throw new Error('Dedupe store has been destroyed');
    }

    await this.readyPromise;

    const pk = `DEDUPE#${hash}`;

    let result;
    try {
      result = await this.docClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk, sk: pk },
        }),
      );
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      throw error;
    }

    if (!result.Item) {
      return false;
    }

    const jobExpired =
      this.jobTimeoutMs > 0 &&
      Date.now() - (result.Item['createdAt'] as number) >= this.jobTimeoutMs;

    if (jobExpired) {
      await this.docClient.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk, sk: pk },
        }),
      );
      return false;
    }

    return result.Item['status'] === 'pending';
  }

  async clear(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Dedupe store has been destroyed');
    }

    await this.readyPromise;

    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      let scanResult;
      try {
        scanResult = await this.docClient.send(
          new ScanCommand({
            TableName: this.tableName,
            FilterExpression: 'begins_with(pk, :prefix)',
            ExpressionAttributeValues: { ':prefix': 'DEDUPE#' },
            ProjectionExpression: 'pk, sk',
            ExclusiveStartKey: lastEvaluatedKey,
          }),
        );
      } catch (error: unknown) {
        throwIfDynamoTableMissing(error, this.tableName);
        throw error;
      }

      const items = scanResult.Items ?? [];
      if (items.length > 0) {
        try {
          await batchDeleteWithRetries(
            this.docClient,
            this.tableName,
            items.map((item) => ({ pk: item['pk'], sk: item['sk'] })),
          );
        } catch (error: unknown) {
          throwIfDynamoTableMissing(error, this.tableName);
          throw error;
        }
      }

      lastEvaluatedKey = scanResult.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (lastEvaluatedKey);

    for (const settle of this.jobSettlers.values()) {
      settle(undefined);
    }
    this.jobPromises.clear();
    this.jobSettlers.clear();
  }

  async close(): Promise<void> {
    this.isDestroyed = true;

    for (const settle of this.jobSettlers.values()) {
      settle(undefined);
    }
    this.jobPromises.clear();
    this.jobSettlers.clear();

    if (this.isClientManaged && this.rawClient) {
      this.rawClient.destroy();
    }
  }

  destroy(): void {
    this.close();
  }

  private deserializeResult(serializedResult: unknown): T | undefined {
    try {
      if (serializedResult === '__UNDEFINED__') {
        return undefined;
      }
      if (serializedResult === '__NULL__') {
        return null as unknown as T;
      }
      if (serializedResult) {
        return JSON.parse(serializedResult as string);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
