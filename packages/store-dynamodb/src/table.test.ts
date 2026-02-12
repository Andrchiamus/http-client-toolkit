import { describe, it, expect } from 'vitest';
import { DEFAULT_TABLE_NAME, TABLE_SCHEMA } from './table.js';

describe('table schema constants', () => {
  it('exports default table name', () => {
    expect(DEFAULT_TABLE_NAME).toBe('http-client-toolkit');
  });

  it('exports table schema with pk/sk and GSI', () => {
    expect(TABLE_SCHEMA.KeySchema).toEqual([
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ]);
    expect(TABLE_SCHEMA.AttributeDefinitions).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      { AttributeName: 'gsi1pk', AttributeType: 'S' },
      { AttributeName: 'gsi1sk', AttributeType: 'S' },
    ]);
    expect(TABLE_SCHEMA.GlobalSecondaryIndexes).toHaveLength(1);
    expect(TABLE_SCHEMA.GlobalSecondaryIndexes[0]?.IndexName).toBe('gsi1');
  });
});
