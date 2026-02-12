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
  AdaptiveCapacityCalculator,
  type AdaptiveRateLimitStore as IAdaptiveRateLimitStore,
  type RequestPriority,
  type AdaptiveConfigSchema,
  type RateLimitConfig,
  type ActivityMetrics,
  type DynamicCapacityResult,
} from '@http-client-toolkit/core';
import { z } from 'zod';
import {
  batchDeleteWithRetries,
  queryCountAllPages,
  queryItemsAllPages,
} from './dynamodb-utils.js';
import { throwIfDynamoTableMissing } from './table-missing-error.js';
import { DEFAULT_TABLE_NAME } from './table.js';

const DEFAULT_ADAPTIVE_RATE_LIMIT: RateLimitConfig = {
  limit: 200,
  windowMs: 3600000, // 1 hour
};

export interface DynamoDBAdaptiveRateLimitStoreOptions {
  client?: DynamoDBDocumentClient | DynamoDBClient;
  region?: string;
  tableName?: string;
  defaultConfig?: RateLimitConfig;
  resourceConfigs?: Map<string, RateLimitConfig>;
  adaptiveConfig?: Partial<z.input<typeof AdaptiveConfigSchema>>;
}

export class DynamoDBAdaptiveRateLimitStore implements IAdaptiveRateLimitStore {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly rawClient: DynamoDBClient | undefined;
  private readonly isClientManaged: boolean;
  private readonly tableName: string;
  private defaultConfig: RateLimitConfig;
  private resourceConfigs: Map<string, RateLimitConfig>;
  private isDestroyed = false;

  // Adaptive rate limiting components
  private capacityCalculator: AdaptiveCapacityCalculator;
  private activityMetrics = new Map<string, ActivityMetrics>();
  private lastCapacityUpdate = new Map<string, number>();
  private cachedCapacity = new Map<string, DynamicCapacityResult>();

  constructor({
    client,
    region,
    tableName = DEFAULT_TABLE_NAME,
    defaultConfig = DEFAULT_ADAPTIVE_RATE_LIMIT,
    resourceConfigs = new Map<string, RateLimitConfig>(),
    adaptiveConfig = {},
  }: DynamoDBAdaptiveRateLimitStoreOptions = {}) {
    this.tableName = tableName;
    this.defaultConfig = defaultConfig;
    this.resourceConfigs = resourceConfigs;
    this.capacityCalculator = new AdaptiveCapacityCalculator(adaptiveConfig);

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
  }

  async canProceed(
    resource: string,
    priority: RequestPriority = 'background',
  ): Promise<boolean> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.ensureActivityMetrics(resource);
    const metrics = this.getOrCreateActivityMetrics(resource);
    const capacity = this.calculateCurrentCapacity(resource, metrics);

    if (priority === 'background' && capacity.backgroundPaused) {
      return false;
    }

    const currentUserRequests = await this.getCurrentUsage(resource, 'user');
    const currentBackgroundRequests = await this.getCurrentUsage(
      resource,
      'background',
    );

    if (priority === 'user') {
      return currentUserRequests < capacity.userReserved;
    } else {
      return currentBackgroundRequests < capacity.backgroundMax;
    }
  }

  async acquire(
    resource: string,
    priority: RequestPriority = 'background',
  ): Promise<boolean> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.ensureActivityMetrics(resource);
    const metrics = this.getOrCreateActivityMetrics(resource);
    const capacity = this.calculateCurrentCapacity(resource, metrics);

    if (priority === 'background' && capacity.backgroundPaused) {
      return false;
    }

    const limitForPriority =
      priority === 'user' ? capacity.userReserved : capacity.backgroundMax;

    if (limitForPriority <= 0) {
      return false;
    }

    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;
    const now = Date.now();
    const windowStart = now - config.windowMs;
    const ttl = Math.floor((now + config.windowMs) / 1000);
    const uuid = randomUUID();
    const slotPrefix = `RATELIMIT_SLOT#${resource}#${priority}`;
    const startSlot = Math.floor(Math.random() * limitForPriority);

    for (let offset = 0; offset < limitForPriority; offset++) {
      const slot = (startSlot + offset) % limitForPriority;

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
                    sk: `TS#${now}#${uuid}`,
                    gsi1pk: `RATELIMIT#${resource}#${priority}`,
                    gsi1sk: `TS#${now}#${uuid}`,
                    ttl,
                    timestamp: now,
                    priority,
                  },
                },
              },
            ],
          }),
        );

        if (priority === 'user') {
          metrics.recentUserRequests.push(now);
          this.cleanupOldRequests(metrics.recentUserRequests);
        } else {
          metrics.recentBackgroundRequests.push(now);
          this.cleanupOldRequests(metrics.recentBackgroundRequests);
        }

        metrics.userActivityTrend =
          this.capacityCalculator.calculateActivityTrend(
            metrics.recentUserRequests,
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

  async record(
    resource: string,
    priority: RequestPriority = 'background',
  ): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

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
            gsi1pk: `RATELIMIT#${resource}#${priority}`,
            gsi1sk: `TS#${now}#${uuid}`,
            ttl,
            timestamp: now,
            priority,
          },
        }),
      );
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      throw error;
    }

    // Update in-memory activity metrics
    const metrics = this.getOrCreateActivityMetrics(resource);

    if (priority === 'user') {
      metrics.recentUserRequests.push(now);
      this.cleanupOldRequests(metrics.recentUserRequests);
    } else {
      metrics.recentBackgroundRequests.push(now);
      this.cleanupOldRequests(metrics.recentBackgroundRequests);
    }

    metrics.userActivityTrend = this.capacityCalculator.calculateActivityTrend(
      metrics.recentUserRequests,
    );
  }

  async getStatus(resource: string): Promise<{
    remaining: number;
    resetTime: Date;
    limit: number;
    adaptive?: {
      userReserved: number;
      backgroundMax: number;
      backgroundPaused: boolean;
      recentUserActivity: number;
      reason: string;
    };
  }> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.ensureActivityMetrics(resource);
    const metrics = this.getOrCreateActivityMetrics(resource);
    const capacity = this.calculateCurrentCapacity(resource, metrics);

    const [currentUserUsage, currentBackgroundUsage] = await Promise.all([
      this.getCurrentUsage(resource, 'user'),
      this.getCurrentUsage(resource, 'background'),
    ]);

    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;

    return {
      remaining:
        capacity.userReserved -
        currentUserUsage +
        (capacity.backgroundMax - currentBackgroundUsage),
      resetTime: new Date(Date.now() + config.windowMs),
      limit: this.getResourceLimit(resource),
      adaptive: {
        userReserved: capacity.userReserved,
        backgroundMax: capacity.backgroundMax,
        backgroundPaused: capacity.backgroundPaused,
        recentUserActivity: this.capacityCalculator.getRecentActivity(
          metrics.recentUserRequests,
        ),
        reason: capacity.reason,
      },
    };
  }

  async reset(resource: string): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    await this.deleteResourceItems(resource);
    this.activityMetrics.delete(resource);
    this.cachedCapacity.delete(resource);
    this.lastCapacityUpdate.delete(resource);
  }

  async getWaitTime(
    resource: string,
    priority: RequestPriority = 'background',
  ): Promise<number> {
    if (this.isDestroyed) {
      throw new Error('Rate limit store has been destroyed');
    }

    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;

    if (config.limit === 0) {
      return config.windowMs;
    }

    const canProceed = await this.canProceed(resource, priority);
    if (canProceed) {
      return 0;
    }

    // For background requests that are paused, check back after recalculation interval
    await this.ensureActivityMetrics(resource);
    const metrics = this.getOrCreateActivityMetrics(resource);
    const capacity = this.calculateCurrentCapacity(resource, metrics);

    if (priority === 'background' && capacity.backgroundPaused) {
      return this.capacityCalculator.config.recalculationIntervalMs;
    }

    // Find the oldest request for this priority using GSI
    const now = Date.now();
    const windowStart = now - config.windowMs;

    let result;
    try {
      result = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :skStart',
          ExpressionAttributeValues: {
            ':gsi1pk': `RATELIMIT#${resource}#${priority}`,
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

    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      let scanResult;
      try {
        scanResult = await this.docClient.send(
          new ScanCommand({
            TableName: this.tableName,
            FilterExpression:
              'begins_with(pk, :prefix) OR begins_with(pk, :slotPrefix)',
            ExpressionAttributeValues: {
              ':prefix': 'RATELIMIT#',
              ':slotPrefix': 'RATELIMIT_SLOT#',
            },
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

    this.activityMetrics.clear();
    this.cachedCapacity.clear();
    this.lastCapacityUpdate.clear();
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

  // Private helper methods

  private calculateCurrentCapacity(
    resource: string,
    metrics: ActivityMetrics,
  ): DynamicCapacityResult {
    const lastUpdate = this.lastCapacityUpdate.get(resource) ?? 0;
    const recalcInterval =
      this.capacityCalculator.config.recalculationIntervalMs;

    if (Date.now() - lastUpdate < recalcInterval) {
      return (
        this.cachedCapacity.get(resource) ?? this.getDefaultCapacity(resource)
      );
    }

    const totalLimit = this.getResourceLimit(resource);
    const capacity = this.capacityCalculator.calculateDynamicCapacity(
      resource,
      totalLimit,
      metrics,
    );

    this.cachedCapacity.set(resource, capacity);
    this.lastCapacityUpdate.set(resource, Date.now());

    return capacity;
  }

  private getOrCreateActivityMetrics(resource: string): ActivityMetrics {
    if (!this.activityMetrics.has(resource)) {
      this.activityMetrics.set(resource, {
        recentUserRequests: [],
        recentBackgroundRequests: [],
        userActivityTrend: 'none',
      });
    }
    return this.activityMetrics.get(resource)!;
  }

  private async ensureActivityMetrics(resource: string): Promise<void> {
    if (this.activityMetrics.has(resource)) {
      return;
    }

    // Load recent activity from DynamoDB to populate in-memory metrics
    const now = Date.now();
    const windowStart = now - this.capacityCalculator.config.monitoringWindowMs;

    let userItems: Array<Record<string, unknown>>;
    let backgroundItems: Array<Record<string, unknown>>;
    try {
      [userItems, backgroundItems] = await Promise.all([
        queryItemsAllPages(this.docClient, {
          TableName: this.tableName,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :skStart',
          ExpressionAttributeValues: {
            ':gsi1pk': `RATELIMIT#${resource}#user`,
            ':skStart': `TS#${windowStart}`,
          },
          ProjectionExpression: '#ts',
          ExpressionAttributeNames: { '#ts': 'timestamp' },
        }),
        queryItemsAllPages(this.docClient, {
          TableName: this.tableName,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :skStart',
          ExpressionAttributeValues: {
            ':gsi1pk': `RATELIMIT#${resource}#background`,
            ':skStart': `TS#${windowStart}`,
          },
          ProjectionExpression: '#ts',
          ExpressionAttributeNames: { '#ts': 'timestamp' },
        }),
      ]);
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      throw error;
    }

    const metrics: ActivityMetrics = {
      recentUserRequests: userItems.map((item) => item['timestamp'] as number),
      recentBackgroundRequests: backgroundItems.map(
        (item) => item['timestamp'] as number,
      ),
      userActivityTrend: 'none',
    };

    metrics.userActivityTrend = this.capacityCalculator.calculateActivityTrend(
      metrics.recentUserRequests,
    );

    this.activityMetrics.set(resource, metrics);
  }

  private async getCurrentUsage(
    resource: string,
    priority: RequestPriority,
  ): Promise<number> {
    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    try {
      return await queryCountAllPages(this.docClient, {
        TableName: this.tableName,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :skStart',
        ExpressionAttributeValues: {
          ':gsi1pk': `RATELIMIT#${resource}#${priority}`,
          ':skStart': `TS#${windowStart}`,
        },
        Select: 'COUNT',
      });
    } catch (error: unknown) {
      throwIfDynamoTableMissing(error, this.tableName);
      throw error;
    }
  }

  private cleanupOldRequests(requests: Array<number>): void {
    const cutoff =
      Date.now() - this.capacityCalculator.config.monitoringWindowMs;
    const idx = requests.findIndex((t) => t >= cutoff);
    if (idx > 0) {
      requests.splice(0, idx);
    } else if (idx === -1 && requests.length > 0) {
      requests.length = 0;
    }
  }

  private getResourceLimit(resource: string): number {
    const config = this.resourceConfigs.get(resource) ?? this.defaultConfig;
    return config.limit;
  }

  private getDefaultCapacity(resource: string): DynamicCapacityResult {
    const limit = this.getResourceLimit(resource);
    const userReserved = Math.floor(limit * 0.3);
    const backgroundMax = Math.max(0, limit - userReserved);
    return {
      userReserved,
      backgroundMax,
      backgroundPaused: false,
      reason: 'Default capacity allocation',
    };
  }

  private async deleteResourceItems(resource: string): Promise<void> {
    const partitionKeys = [
      `RATELIMIT#${resource}`,
      `RATELIMIT_SLOT#${resource}#user`,
      `RATELIMIT_SLOT#${resource}#background`,
    ];

    for (const pk of partitionKeys) {
      let lastEvaluatedKey: Record<string, unknown> | undefined;

      do {
        let queryResult;
        try {
          queryResult = await this.docClient.send(
            new QueryCommand({
              TableName: this.tableName,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': pk },
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
}
