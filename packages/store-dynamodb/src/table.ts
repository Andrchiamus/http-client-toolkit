import type {
  KeySchemaElement,
  AttributeDefinition,
  GlobalSecondaryIndex,
} from '@aws-sdk/client-dynamodb';

export const DEFAULT_TABLE_NAME = 'http-client-toolkit';

export const TABLE_SCHEMA: {
  KeySchema: Array<KeySchemaElement>;
  AttributeDefinitions: Array<AttributeDefinition>;
  GlobalSecondaryIndexes: Array<GlobalSecondaryIndex>;
} = {
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ],
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
    { AttributeName: 'gsi1pk', AttributeType: 'S' },
    { AttributeName: 'gsi1sk', AttributeType: 'S' },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi1',
      KeySchema: [
        { AttributeName: 'gsi1pk', KeyType: 'HASH' },
        { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
  ],
};
