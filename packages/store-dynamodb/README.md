# @http-client-toolkit/store-dynamodb

DynamoDB store implementations for HTTP client toolkit caching, deduplication, and rate limiting. Designed for distributed, serverless-friendly environments.

## Installation

```bash
npm install @http-client-toolkit/store-dynamodb @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

The AWS SDK packages are peer dependencies — you likely already have them in a serverless project.

Requires Node.js >= 20.

## Table Setup

All stores share a single DynamoDB table (default name: `http-client-toolkit`) with a partition key `pk` (String), sort key `sk` (String), and a GSI named `gsi1`.

The library does **not** create tables at runtime. You must provision the table in infrastructure first.

At runtime, store operations throw a clear error if the table is missing:

`DynamoDB table "<table-name>" was not found. Create the table using your infrastructure before using DynamoDB stores.`

You can still reference the required schema from code via `TABLE_SCHEMA`:

```typescript
import {
  TABLE_SCHEMA,
  DEFAULT_TABLE_NAME,
} from '@http-client-toolkit/store-dynamodb';
```

Enable DynamoDB native TTL on the `ttl` attribute for automatic item expiration.

### Infrastructure Examples

#### SST v3

```typescript
import { StackContext } from 'sst/constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export function Storage({ stack }: StackContext) {
  const table = new dynamodb.Table(stack, 'HttpClientToolkitTable', {
    tableName: 'http-client-toolkit',
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    timeToLiveAttribute: 'ttl',
  });

  table.addGlobalSecondaryIndex({
    indexName: 'gsi1',
    partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });
}
```

#### AWS CDK

```typescript
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

const app = new cdk.App();
const stack = new cdk.Stack(app, 'HttpClientToolkitStack');

const table = new dynamodb.Table(stack, 'HttpClientToolkitTable', {
  tableName: 'http-client-toolkit',
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  timeToLiveAttribute: 'ttl',
});

table.addGlobalSecondaryIndex({
  indexName: 'gsi1',
  partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});
```

#### Pulumi (TypeScript)

```typescript
import * as aws from '@pulumi/aws';

const table = new aws.dynamodb.Table('httpClientToolkitTable', {
  name: 'http-client-toolkit',
  billingMode: 'PAY_PER_REQUEST',
  hashKey: 'pk',
  rangeKey: 'sk',
  ttl: { attributeName: 'ttl', enabled: true },
  attributes: [
    { name: 'pk', type: 'S' },
    { name: 'sk', type: 'S' },
    { name: 'gsi1pk', type: 'S' },
    { name: 'gsi1sk', type: 'S' },
  ],
  globalSecondaryIndexes: [
    {
      name: 'gsi1',
      hashKey: 'gsi1pk',
      rangeKey: 'gsi1sk',
      projectionType: 'ALL',
    },
  ],
});
```

#### Terraform

```hcl
resource "aws_dynamodb_table" "http_client_toolkit" {
  name         = "http-client-toolkit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
```

#### CloudFormation

```yaml
Resources:
  HttpClientToolkitTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: http-client-toolkit
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: pk
          AttributeType: S
        - AttributeName: sk
          AttributeType: S
        - AttributeName: gsi1pk
          AttributeType: S
        - AttributeName: gsi1sk
          AttributeType: S
      KeySchema:
        - AttributeName: pk
          KeyType: HASH
        - AttributeName: sk
          KeyType: RANGE
      GlobalSecondaryIndexes:
        - IndexName: gsi1
          KeySchema:
            - AttributeName: gsi1pk
              KeyType: HASH
            - AttributeName: gsi1sk
              KeyType: RANGE
          Projection:
            ProjectionType: ALL
      TimeToLiveSpecification:
        AttributeName: ttl
        Enabled: true
```

## Usage

```typescript
import { HttpClient } from '@http-client-toolkit/core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBCacheStore,
  DynamoDBDedupeStore,
  DynamoDBRateLimitStore,
} from '@http-client-toolkit/store-dynamodb';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });

const client = new HttpClient({
  cache: new DynamoDBCacheStore({ client: dynamoClient }),
  dedupe: new DynamoDBDedupeStore({ client: dynamoClient }),
  rateLimit: new DynamoDBRateLimitStore({ client: dynamoClient }),
});
```

All stores accept a `DynamoDBDocumentClient`, a plain `DynamoDBClient` (auto-wrapped), or no client (created internally with optional `region`).

### DynamoDBCacheStore

```typescript
new DynamoDBCacheStore({
  client: dynamoClient,
  tableName: 'http-client-toolkit', // Default
  maxEntrySizeBytes: 390 * 1024, // Default: 390 KB (DynamoDB 400 KB limit minus overhead)
});
```

### DynamoDBDedupeStore

```typescript
new DynamoDBDedupeStore({
  client: dynamoClient,
  jobTimeoutMs: 300_000, // Default: 5 minutes
  pollIntervalMs: 500, // Default: 500ms (higher than SQLite to reduce API calls)
});
```

### DynamoDBRateLimitStore

```typescript
new DynamoDBRateLimitStore({
  client: dynamoClient,
  defaultConfig: { limit: 60, windowMs: 60_000 },
  resourceConfigs: new Map([['slow-api', { limit: 10, windowMs: 60_000 }]]),
});
```

### DynamoDBAdaptiveRateLimitStore

```typescript
new DynamoDBAdaptiveRateLimitStore({
  client: dynamoClient,
  defaultConfig: { limit: 200, windowMs: 3_600_000 },
  adaptiveConfig: {
    highActivityThreshold: 10,
    moderateActivityThreshold: 3,
  },
});
```

## Key Design Notes

- **No cleanup intervals**: Unlike SQLite/memory stores, DynamoDB native TTL handles automatic item expiration. No background timers are needed.
- **TTL lag**: DynamoDB TTL deletion can be delayed up to 48 hours. Stores check `ttl` in `get()` to filter expired items immediately.
- **Single-table design**: All store types share one table, separated by key prefixes (`CACHE#`, `DEDUPE#`, `RATELIMIT#`).
- **`clear()` is expensive**: Uses Scan + BatchWriteItem. DynamoDB has no truncate operation.
- **GSI for priority queries**: The adaptive rate limit store uses the `gsi1` GSI to efficiently query requests by priority.

## License

ISC
