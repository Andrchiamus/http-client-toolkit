import { ResourceNotFoundException } from '@aws-sdk/client-dynamodb';

export function throwIfDynamoTableMissing(
  error: unknown,
  tableName: string,
): void {
  if (
    error instanceof ResourceNotFoundException ||
    (error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'ResourceNotFoundException')
  ) {
    throw new Error(
      `DynamoDB table "${tableName}" was not found. Create the table using your infrastructure before using DynamoDB stores.`,
    );
  }
}
