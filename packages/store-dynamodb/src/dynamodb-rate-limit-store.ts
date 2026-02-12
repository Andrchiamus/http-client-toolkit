import { randomUUID } from 'crypto';
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  type RateLimitConfig,
  type RateLimitStore,
  DEFAULT_RATE_LIMIT,
} from '@http-client-toolkit/core';
import { DEFAULT_TABLE_NAME } from './table.js';
import { throwIfDynamoTableMissing } from './table-missing-error.js';
import {
  batchDeleteWithRetries,
  queryCountAllPages,
} from './dynamodb-utils.js';

export interface DynamoDBRateLimitStoreOptions {
  client?: DynamoDBDocumentClient | DynamoDBClient;
  region?: string;
  tableName?: string;
  defaultConfig?: RateLimitConfig;
  resourceConfigs?: Map<string, RateLimitConfig>;
}

export class DynamoDBRateLimitStore implements RateLimitStore {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly rawClient: DynamoDBClient | undefined;
  private readonly isClientManaged: boolean;
  private readonly tableName: string;
  private readonly readyPromise: Promise<void>;
  private defaultConfig: RateLimitConfig;
  private resourceConfigs: Map<string, RateLimitConfig>;
  private isDestroyed = false;

  constructor({
    client,
    region,
    tableName = DEFAULT_TABLE_NAME,
    defaultConfig = DEFAULT_RATE_LIMIT,
    resourceConfigs = new Map<string, RateLimitConfig>(),
  }: DynamoDBRateLimitStoreOptions = {}) {
    this.tableName = tableName;
    this.defaultConfig = defaultConfig;
    this.resourceConfigs = resourceConfigs;

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

  async canProceed(resource: string): Promise<boolean> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.readyPromise;

    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    const currentCount = await this.countRequestsInWindow(
      resource,
      windowStart,
    );
    return currentCount < config.limit;
  }

  async acquire(resource: string): Promise<boolean> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.readyPromise;

    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;
    if (config.limit <= 0) {
      return false;
    }

    const now = Date.now();
    const windowStart = now - config.windowMs;
    const ttl = Math.floor((now + config.windowMs) / 1000);
    const eventId = randomUUID();
    const slotPrefix = `RATELIMIT_SLOT#${resource}`;
    const startSlot = Math.floor(Math.random() * config.limit);

    for (let offset = 0; offset < config.limit; offset++) {
      const slot = (startSlot + offset) % config.limit;

      try {
        await this.docClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.tableName,
                  Item: {
                    pk: slotPrefix,
                    sk: `SLOT#${slot}`,
                    timestamp: now,
                    ttl,
                  },
                  ConditionExpression:
                    'attribute_not_exists(pk) OR #timestamp < :windowStart',
                  ExpressionAttributeNames: {
                    '#timestamp': 'timestamp',
                  },
                  ExpressionAttributeValues: {
                    ':windowStart': windowStart,
                  },
                },
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: {
                    pk: `RATELIMIT#${resource}`,
                    sk: `TS#${now}#${eventId}`,
                    ttl,
                    timestamp: now,
                  },
                },
              },
            ],
          }),
        );

        return true;
      } catch (error: unknown) {
        throwIfDynamoTableMissing(error, this.tableName);

        const isConditionalTransactionFailure =
          error &&
          typeof error === 'object' &&
          'name' in error &&
          error.name === 'TransactionCanceledException' &&
          'message' in error &&
          typeof error.message === 'string' &&
          error.message.includes('ConditionalCheckFailed');

        if (isConditionalTransactionFailure) {
          continue;
        }

        throw error;
      }
    }

    return false;
  }

  async record(resource: string): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.readyPromise;

    const now = Date.now();
    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;
    const ttl = Math.floor((now + config.windowMs) / 1000);
    const uuid = randomUUID();

    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `RATELIMIT#${resource}`,
            sk: `TS#${now}#${uuid}`,
            ttl,
            timestamp: now,
          },
        }),
      );
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      throw error;
    }
  }

  async getStatus(resource: string): Promise<{
    remaining: number;
    resetTime: Date;
    limit: number;
  }> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.readyPromise;

    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    const currentRequests = await this.countRequestsInWindow(
      resource,
      windowStart,
    );
    const remaining = Math.max(0, config.limit - currentRequests);

    return {
      remaining,
      resetTime: new Date(now + config.windowMs),
      limit: config.limit,
    };
  }

  async reset(resource: string): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.readyPromise;

    await this.deleteResourceItems(resource);
  }

  async getWaitTime(resource: string): Promise<number> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.readyPromise;

    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;

    if (config.limit === 0) {
      return config.windowMs;
    }

    const now = Date.now();
    const windowStart = now - config.windowMs;

    const currentCount = await this.countRequestsInWindow(
      resource,
      windowStart,
    );

    if (currentCount < config.limit) {
      return 0;
    }

    // Find oldest request in window
    let result;
    try {
      result = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND sk >= :skStart',
          ExpressionAttributeValues: {
            ':pk': `RATELIMIT#${resource}`,
            ':skStart': `TS#${windowStart}`,
          },
          Limit: 1,
          ScanIndexForward: true,
        }),
      );
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      throw error;
    }

    const oldestItem = result.Items?.[0];
    if (!oldestItem) {
      return 0;
    }

    const oldestTimestamp = oldestItem['timestamp'] as number | undefined;
    if (!oldestTimestamp) {
      return 0;
    }

    const timeUntilOldestExpires = oldestTimestamp + config.windowMs - now;
    return Math.max(0, timeUntilOldestExpires);
  }

  setResourceConfig(resource: string, config: RateLimitConfig): void {
    this.resourceConfigs.set(resource, config);
  }

  getResourceConfig(resource: string): RateLimitConfig {
    return this.resourceConfigs.get(resource) ?? this.defaultConfig;
  }

  async clear(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
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
            ExpressionAttributeValues: { ':prefix': 'RATELIMIT#' },
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
  }

  async close(): Promise<void> {
    this.isDestroyed = true;

    if (this.isClientManaged && this.rawClient) {
      this.rawClient.destroy();
    }
  }

  destroy(): void {
    this.close();
  }

  private async countRequestsInWindow(
    resource: string,
    windowStart: number,
  ): Promise<number> {
    try {
      return await queryCountAllPages(this.docClient, {
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND sk >= :skStart',
        ExpressionAttributeValues: {
          ':pk': `RATELIMIT#${resource}`,
          ':skStart': `TS#${windowStart}`,
        },
        Select: 'COUNT',
      });
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      throw error;
    }
  }

  private async deleteResourceItems(resource: string): Promise<void> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      let queryResult;
      try {
        queryResult = await this.docClient.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': `RATELIMIT#${resource}` },
            ProjectionExpression: 'pk, sk',
            ExclusiveStartKey: lastEvaluatedKey,
          }),
        );
      } catch (error: unknown) {
        throwIfDynamoTableMissing(error, this.tableName);
        throw error;
      }

      const items = queryResult.Items ?? [];
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

      lastEvaluatedKey = queryResult.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (lastEvaluatedKey);
  }
}
