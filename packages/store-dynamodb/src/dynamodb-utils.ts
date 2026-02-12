import {
  BatchWriteCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

type DynamoItem = Record<string, unknown>;

const MAX_BATCH_WRITE_RETRIES = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt: number): number {
  const backoff = Math.min(1000, 50 * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 25);
  return backoff + jitter;
}

export async function batchDeleteWithRetries(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  keys: Array<DynamoItem>,
): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);

    let pendingWrites = batch.map((key) => ({ DeleteRequest: { Key: key } }));

    for (let attempt = 0; pendingWrites.length > 0; attempt++) {
      const response = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: pendingWrites,
          },
        }),
      );

      const unprocessed = response.UnprocessedItems?.[tableName] ?? [];

      if (unprocessed.length === 0) {
        break;
      }

      if (attempt >= MAX_BATCH_WRITE_RETRIES) {
        throw new Error(
          `Failed to delete all items from table "${tableName}" after ${MAX_BATCH_WRITE_RETRIES + 1} attempts`,
        );
      }

      pendingWrites = unprocessed
        .map((request) => request.DeleteRequest?.Key)
        .filter((key): key is DynamoItem => Boolean(key))
        .map((key) => ({ DeleteRequest: { Key: key } }));
      await sleep(getRetryDelayMs(attempt));
    }
  }
}

export async function queryCountAllPages(
  docClient: DynamoDBDocumentClient,
  input: QueryCommandInput,
): Promise<number> {
  let total = 0;
  let lastEvaluatedKey: DynamoItem | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        ...input,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    total += result.Count ?? 0;
    lastEvaluatedKey = result.LastEvaluatedKey as DynamoItem | undefined;
  } while (lastEvaluatedKey);

  return total;
}

export async function queryItemsAllPages(
  docClient: DynamoDBDocumentClient,
  input: QueryCommandInput,
): Promise<Array<DynamoItem>> {
  const items: Array<DynamoItem> = [];
  let lastEvaluatedKey: DynamoItem | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        ...input,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    if (result.Items?.length) {
      items.push(...(result.Items as Array<DynamoItem>));
    }

    lastEvaluatedKey = result.LastEvaluatedKey as DynamoItem | undefined;
  } while (lastEvaluatedKey);

  return items;
}
