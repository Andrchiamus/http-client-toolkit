import * as dynamodb from './index.js';

describe('store-dynamodb index exports', () => {
  it('re-exports DynamoDB store classes and table schema constants', () => {
    expect(dynamodb.DynamoDBCacheStore).toBeTypeOf('function');
    expect(dynamodb.DynamoDBDedupeStore).toBeTypeOf('function');
    expect(dynamodb.DynamoDBRateLimitStore).toBeTypeOf('function');
    expect(dynamodb.DynamoDBAdaptiveRateLimitStore).toBeTypeOf('function');
    expect(dynamodb.DEFAULT_TABLE_NAME).toBe('http-client-toolkit');
    expect(dynamodb.TABLE_SCHEMA).toBeDefined();
  });
});
