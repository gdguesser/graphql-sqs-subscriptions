import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SQSClient
} from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SQSPubSub } from "../../src";

const endpoint = process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566";

describe("LocalStack SQS integration", () => {
  const client = new SQSClient({
    endpoint,
    region: process.env.AWS_REGION ?? "eu-west-1",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test"
    }
  });
  let queueUrl: string;
  let pubSub: SQSPubSub;

  beforeAll(async () => {
    const result = await client.send(
      new CreateQueueCommand({
        QueueName: `graphql-subscriptions-${randomUUID()}`
      })
    );

    if (!result.QueueUrl) {
      throw new Error("LocalStack did not return a queue URL");
    }

    queueUrl = result.QueueUrl;
    pubSub = new SQSPubSub(
      {
        endpoint,
        region: "eu-west-1",
        credentials: {
          accessKeyId: "test",
          secretAccessKey: "test"
        },
        pubSub: {
          client,
          receive: {
            waitTimeSeconds: 1
          }
        }
      },
      queueUrl
    );
  });

  afterAll(async () => {
    await pubSub?.close();
    if (queueUrl) {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    client.destroy();
  });

  it("publishes and locally fans out the real SQS message", async () => {
    const first = pubSub.asyncIterator<{ id: string }>("job.completed");
    const second = pubSub.asyncIterator<{ id: string }>("job.completed");
    const firstResult = first.next();
    const secondResult = second.next();
    await pubSub.start();

    await pubSub.publish("job.completed", { id: "localstack-job" });

    await expect(firstResult).resolves.toEqual({
      value: { id: "localstack-job" },
      done: false
    });
    await expect(secondResult).resolves.toEqual({
      value: { id: "localstack-job" },
      done: false
    });

    await first.return?.();
    await second.return?.();
  });
});
