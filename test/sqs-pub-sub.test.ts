import {
  CreateQueueCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type ReceiveMessageCommandOutput,
  SendMessageCommand,
  type SQSClient
} from "@aws-sdk/client-sqs";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  SQSPubSub,
  type SQSPubSubDeleteEvent,
  type SQSPubSubDispatchEvent,
  type SQSPubSubErrorEvent,
  type SQSPubSubLifecycleEvent,
  type SQSPubSubObserver,
  type SQSPubSubReceiveEvent,
  SQSPubSubTriggerName
} from "../src";

const STANDARD_QUEUE_URL = "http://localhost:4566/000000000000/graphql-events";
const FIFO_QUEUE_URL = `${STANDARD_QUEUE_URL}.fifo`;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ObserverSpies {
  lifecycle: Mock<(event: SQSPubSubLifecycleEvent) => void>;
  receive: Mock<(event: SQSPubSubReceiveEvent) => void>;
  dispatch: Mock<(event: SQSPubSubDispatchEvent) => void>;
  delete: Mock<(event: SQSPubSubDeleteEvent) => void>;
  error: Mock<(event: SQSPubSubErrorEvent) => void>;
}

type ReceiveAction = (
  signal: AbortSignal | undefined
) => Promise<ReceiveMessageCommandOutput>;

class MockSqsClient {
  public readonly commands: unknown[] = [];
  public readonly receiveSignals: Array<AbortSignal | undefined> = [];
  public readonly deleteFailures: Error[] = [];
  public createQueueUrl = STANDARD_QUEUE_URL;
  public activeReceives = 0;
  public maxActiveReceives = 0;
  public abortedReceives = 0;
  private readonly receiveActions: ReceiveAction[] = [];

  public readonly send = vi.fn(
    async (
      command: unknown,
      options?: { abortSignal?: AbortSignal }
    ): Promise<unknown> => {
      this.commands.push(command);

      if (command instanceof ReceiveMessageCommand) {
        const signal = options?.abortSignal;
        this.receiveSignals.push(signal);
        this.activeReceives += 1;
        this.maxActiveReceives = Math.max(
          this.maxActiveReceives,
          this.activeReceives
        );

        try {
          const action =
            this.receiveActions.shift() ??
            ((
              receiveSignal: AbortSignal | undefined
            ): Promise<ReceiveMessageCommandOutput> =>
              this.waitForAbort(receiveSignal));
          return await action(signal);
        } finally {
          this.activeReceives -= 1;
        }
      }

      if (command instanceof DeleteMessageCommand) {
        const failure = this.deleteFailures.shift();
        if (failure) {
          throw failure;
        }
        return {};
      }

      if (command instanceof CreateQueueCommand) {
        return { QueueUrl: this.createQueueUrl };
      }

      if (command instanceof SendMessageCommand) {
        return { MessageId: "published-message" };
      }

      throw new Error(`Unexpected command: ${String(command)}`);
    }
  );

  public enqueueReceive(...messages: Message[]): void {
    this.receiveActions.push(async () => ({
      Messages: messages,
      $metadata: {}
    }));
  }

  public enqueueReceiveError(error: Error): void {
    this.receiveActions.push(async () => {
      throw error;
    });
  }

  public deferReceive(): Deferred<ReceiveMessageCommandOutput> {
    const pending = deferred<ReceiveMessageCommandOutput>();
    this.receiveActions.push(() => pending.promise);
    return pending;
  }

  public commandsOf<T>(constructor: new (...args: never[]) => T): T[] {
    return this.commands.filter(
      (command): command is T => command instanceof constructor
    );
  }

  private waitForAbort(
    signal: AbortSignal | undefined
  ): Promise<ReceiveMessageCommandOutput> {
    return new Promise((_, reject) => {
      const abort = (): void => {
        this.abortedReceives += 1;
        const error = new Error("Long poll aborted");
        error.name = "AbortError";
        reject(error);
      };

      if (signal?.aborted) {
        abort();
        return;
      }

      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

const openPubSubs: SQSPubSub[] = [];

afterEach(async () => {
  await Promise.allSettled(
    openPubSubs.splice(0).map((pubSub) => pubSub.close())
  );
});

describe("subscription registry and local fan-out", () => {
  it("regression: fans one broker delivery out to two users on one trigger with one poller", async () => {
    const client = new MockSqsClient();
    const receive = client.deferReceive();
    const pubSub = createPubSub(client);
    const firstUser = vi.fn();
    const secondUser = vi.fn();

    const [firstId, secondId] = await Promise.all([
      pubSub.subscribe("job.completed", firstUser),
      pubSub.subscribe("job.completed", secondUser)
    ]);

    receive.resolve(receiveOutput(brokerMessage("job.completed", { id: 7 })));

    await eventually(() => {
      expect(firstUser).toHaveBeenCalledOnce();
      expect(secondUser).toHaveBeenCalledOnce();
      expect(deleteCommands(client)).toHaveLength(1);
    });
    expect(firstId).not.toBe(secondId);
    expect(client.maxActiveReceives).toBe(1);
  });

  it("dispatches to every matching listener", async () => {
    const client = new MockSqsClient();
    const receive = client.deferReceive();
    const pubSub = createPubSub(client);
    const listeners = [vi.fn(), vi.fn(), vi.fn()];
    await Promise.all(
      listeners.map((listener) => pubSub.subscribe("shared.trigger", listener))
    );

    receive.resolve(
      receiveOutput(brokerMessage("shared.trigger", { status: "done" }))
    );

    await eventually(() => {
      for (const listener of listeners) {
        expect(listener).toHaveBeenCalledWith({ status: "done" });
      }
    });
  });

  it("deletes a valid nonmatching event without dispatching it", async () => {
    const client = new MockSqsClient();
    client.enqueueReceive(brokerMessage("other.trigger", { status: "done" }));
    const pubSub = createPubSub(client);
    const listener = vi.fn();

    await pubSub.subscribe("wanted.trigger", listener);

    await eventually(() => expect(deleteCommands(client)).toHaveLength(1));
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns unique subscription IDs", async () => {
    const client = new MockSqsClient();
    const pubSub = createPubSub(client);

    const ids = await Promise.all([
      pubSub.subscribe("same.trigger", vi.fn()),
      pubSub.subscribe("same.trigger", vi.fn()),
      pubSub.subscribe("other.trigger", vi.fn())
    ]);

    expect(new Set(ids).size).toBe(3);
  });

  it("unsubscribes only the requested listener", async () => {
    const client = new MockSqsClient();
    const receive = client.deferReceive();
    const pubSub = createPubSub(client);
    const removed = vi.fn();
    const active = vi.fn();
    const removedId = await pubSub.subscribe("job.completed", removed);
    await pubSub.subscribe("job.completed", active);

    await pubSub.unsubscribe(removedId);
    receive.resolve(
      receiveOutput(brokerMessage("job.completed", { id: "job-1" }))
    );

    await eventually(() => expect(active).toHaveBeenCalledOnce());
    expect(removed).not.toHaveBeenCalled();
  });

  it("closing one async iterator leaves the other iterator active", async () => {
    const client = new MockSqsClient();
    const receive = client.deferReceive();
    const pubSub = createPubSub(client);
    const first = pubSub.asyncIterator<{ id: string }>("job.completed");
    const second = pubSub.asyncIterator<{ id: string }>("job.completed");

    const firstResult = first.next();
    const secondResult = second.next();
    await eventually(() =>
      expect(client.commandsOf(ReceiveMessageCommand)).toHaveLength(1)
    );
    await first.return?.();

    receive.resolve(
      receiveOutput(brokerMessage("job.completed", { id: "job-2" }))
    );

    await expect(firstResult).resolves.toEqual({
      value: undefined,
      done: true
    });
    await expect(secondResult).resolves.toEqual({
      value: { id: "job-2" },
      done: false
    });
    await second.return?.();
  });

  it("supports the graphql-subscriptions v3 asyncIterableIterator API", async () => {
    const client = new MockSqsClient();
    const receive = client.deferReceive();
    const pubSub = createPubSub(client);
    const iterator = pubSub.asyncIterableIterator<{ id: string }>(
      "job.completed"
    );
    const result = iterator.next();

    receive.resolve(
      receiveOutput(brokerMessage("job.completed", { id: "v3-api" }))
    );

    await expect(result).resolves.toEqual({
      value: { id: "v3-api" },
      done: false
    });
    await iterator.return?.();
  });

  it("routes mixed triggers to their matching registries", async () => {
    const client = new MockSqsClient();
    const receive = client.deferReceive();
    const pubSub = createPubSub(client);
    const alpha = vi.fn();
    const beta = vi.fn();
    await Promise.all([
      pubSub.subscribe("alpha", alpha),
      pubSub.subscribe("beta", beta)
    ]);

    receive.resolve(
      receiveOutput(
        brokerMessage("alpha", { value: "a" }, "message-a"),
        brokerMessage("beta", { value: "b" }, "message-b")
      )
    );

    await eventually(() => {
      expect(alpha).toHaveBeenCalledWith({ value: "a" });
      expect(beta).toHaveBeenCalledWith({ value: "b" });
      expect(deleteCommands(client)).toHaveLength(2);
    });
  });

  it("keeps draining valid events after the last listener unsubscribes", async () => {
    const client = new MockSqsClient();
    const receive = client.deferReceive();
    const pubSub = createPubSub(client);
    const subscriptionId = await pubSub.subscribe("live.event", vi.fn());
    await pubSub.unsubscribe(subscriptionId);

    receive.resolve(
      receiveOutput(brokerMessage("live.event", { transient: true }))
    );

    await eventually(() => expect(deleteCommands(client)).toHaveLength(1));
  });
});

describe("receive, dispatch, and delete policy", () => {
  it("does not delete malformed JSON and reports it", async () => {
    const client = new MockSqsClient();
    const observer = observerSpies();
    const malformed = brokerMessage("job.completed", { ok: true });
    malformed.Body = "{not-json";
    client.enqueueReceive(malformed);
    const pubSub = createPubSub(client, { observer });

    await pubSub.start();

    await eventually(() =>
      expect(observer.error).toHaveBeenCalledWith(
        expect.objectContaining({ code: "malformed_json" })
      )
    );
    expect(deleteCommands(client)).toHaveLength(0);
  });

  it("does not delete a message missing its trigger attribute", async () => {
    const client = new MockSqsClient();
    const observer = observerSpies();
    const missingTrigger = brokerMessage("ignored", { ok: true });
    missingTrigger.MessageAttributes = {};
    client.enqueueReceive(missingTrigger);
    const pubSub = createPubSub(client, { observer });

    await pubSub.start();

    await eventually(() =>
      expect(observer.error).toHaveBeenCalledWith(
        expect.objectContaining({ code: "missing_trigger_attribute" })
      )
    );
    expect(deleteCommands(client)).toHaveLength(0);
  });

  it("recovers after a receive failure", async () => {
    const client = new MockSqsClient();
    const observer = observerSpies();
    const listener = vi.fn();
    client.enqueueReceiveError(new Error("temporary receive failure"));
    client.enqueueReceive(brokerMessage("job.completed", { recovered: true }));
    const pubSub = createPubSub(client, { observer });

    await pubSub.subscribe("job.completed", listener);

    await eventually(() => {
      expect(listener).toHaveBeenCalledWith({ recovered: true });
      expect(deleteCommands(client)).toHaveLength(1);
    });
    expect(observer.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "receive",
        code: "receive_failed"
      })
    );
  });

  it("reports a delete failure and leaves the message eligible for redelivery", async () => {
    const client = new MockSqsClient();
    const observer = observerSpies();
    const listener = vi.fn();
    client.deleteFailures.push(new Error("delete failed"));
    client.enqueueReceive(brokerMessage("job.completed", { id: 1 }));
    const pubSub = createPubSub(client, { observer });

    await pubSub.subscribe("job.completed", listener);

    await eventually(() =>
      expect(observer.error).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "delete",
          code: "delete_failed"
        })
      )
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(deleteCommands(client)).toHaveLength(1);
  });

  it("isolates a throwing listener, dispatches the others, then deletes", async () => {
    const client = new MockSqsClient();
    const receive = client.deferReceive();
    const observer = observerSpies();
    const failing = vi.fn(() => {
      throw new Error("listener failed");
    });
    const succeeding = vi.fn();
    const pubSub = createPubSub(client, { observer });
    await Promise.all([
      pubSub.subscribe("job.completed", failing),
      pubSub.subscribe("job.completed", succeeding)
    ]);

    receive.resolve(
      receiveOutput(brokerMessage("job.completed", { id: "job-3" }))
    );

    await eventually(() => {
      expect(succeeding).toHaveBeenCalledWith({ id: "job-3" });
      expect(deleteCommands(client)).toHaveLength(1);
    });
    expect(observer.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "dispatch",
        code: "listener_failed"
      })
    );
    expect(observer.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        listenerCount: 2,
        failedListenerCount: 1
      })
    );
  });

  it("parses each broker message body exactly once", async () => {
    const client = new MockSqsClient();
    const parse = vi.spyOn(JSON, "parse");
    client.enqueueReceive(brokerMessage("job.completed", { id: "parse-1" }));
    const pubSub = createPubSub(client);

    await pubSub.subscribe("job.completed", vi.fn());

    await eventually(() => expect(deleteCommands(client)).toHaveLength(1));
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockRestore();
  });

  it("delivers duplicate SQS messages without claiming exactly-once semantics", async () => {
    const client = new MockSqsClient();
    const listener = vi.fn();
    client.enqueueReceive(
      brokerMessage("job.completed", { id: 4 }, "duplicate", "receipt-1"),
      brokerMessage("job.completed", { id: 4 }, "duplicate", "receipt-2")
    );
    const pubSub = createPubSub(client);

    await pubSub.subscribe("job.completed", listener);

    await eventually(() => {
      expect(listener).toHaveBeenCalledTimes(2);
      expect(deleteCommands(client)).toHaveLength(2);
    });
  });

  it("never includes payload data in observer event objects", async () => {
    const client = new MockSqsClient();
    const events: unknown[] = [];
    const secret = "customer-private-value";
    const observer: SQSPubSubObserver = {
      receive: (event) => {
        events.push(event);
      },
      dispatch: (event) => {
        events.push(event);
      },
      delete: (event) => {
        events.push(event);
      }
    };
    client.enqueueReceive(
      brokerMessage("job.completed", { secret }, "safe-message-id")
    );
    const pubSub = createPubSub(client, { observer });

    await pubSub.start();

    await eventually(() => expect(deleteCommands(client)).toHaveLength(1));
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe("standard and FIFO publishing", () => {
  it("publishes to a standard queue without FIFO-only fields by default", async () => {
    const client = new MockSqsClient();
    const pubSub = createPubSub(client);

    await pubSub.publish("job.completed", { id: 5 });

    const input = sendCommands(client)[0].input;
    expect(input).toMatchObject({
      QueueUrl: STANDARD_QUEUE_URL,
      MessageBody: JSON.stringify({ id: 5 }),
      MessageAttributes: {
        [SQSPubSubTriggerName]: {
          DataType: "String",
          StringValue: "job.completed"
        }
      }
    });
    expect(input).not.toHaveProperty("MessageGroupId");
    expect(input).not.toHaveProperty("MessageDeduplicationId");
  });

  it("publishes FIFO fields for a FIFO queue URL", async () => {
    const client = new MockSqsClient();
    const pubSub = createPubSub(client, { queueUrl: FIFO_QUEUE_URL });

    await pubSub.publish(
      "job.completed",
      { id: 6 },
      {
        messageGroupId: "group-1",
        messageDeduplicationId: "dedupe-1"
      }
    );

    expect(sendCommands(client)[0].input).toMatchObject({
      QueueUrl: FIFO_QUEUE_URL,
      MessageGroupId: "group-1",
      MessageDeduplicationId: "dedupe-1"
    });
  });

  it("publishes FIFO fields when explicitly requested", async () => {
    const client = new MockSqsClient();
    const pubSub = createPubSub(client);

    await pubSub.publish(
      "job.completed",
      { id: 6 },
      {
        fifo: true,
        messageGroupId: "group-option",
        messageDeduplicationId: "dedupe-option"
      }
    );

    expect(sendCommands(client)[0].input).toMatchObject({
      QueueUrl: STANDARD_QUEUE_URL,
      MessageGroupId: "group-option",
      MessageDeduplicationId: "dedupe-option"
    });
  });

  it("auto-creates a standard queue only when no URL was supplied", async () => {
    const client = new MockSqsClient();
    const pubSub = createPubSub(client, { queueUrl: null });

    await pubSub.publish("job.completed", { id: 7 });

    const createInput = client.commandsOf(CreateQueueCommand)[0].input;
    expect(createInput.QueueName).not.toMatch(/\.fifo$/);
    expect(createInput.Attributes).toBeUndefined();
    expect(sendCommands(client)[0].input.QueueUrl).toBe(STANDARD_QUEUE_URL);
  });

  it("never creates a queue when an external URL was supplied", async () => {
    const client = new MockSqsClient();
    const pubSub = createPubSub(client, {
      queue: { autoCreate: true, fifo: false }
    });

    await pubSub.publish("job.completed", { id: 8 });

    expect(client.commandsOf(CreateQueueCommand)).toHaveLength(0);
  });

  it("supports opting out of queue auto-creation", async () => {
    const client = new MockSqsClient();
    const pubSub = createPubSub(client, {
      queueUrl: null,
      queue: { autoCreate: false }
    });

    await expect(pubSub.publish("job.completed", { id: 9 })).rejects.toThrow(
      /queue URL is required/i
    );
    expect(client.commandsOf(CreateQueueCommand)).toHaveLength(0);
    expect(sendCommands(client)).toHaveLength(0);
  });

  it("creates and publishes FIFO only when configured", async () => {
    const client = new MockSqsClient();
    client.createQueueUrl = FIFO_QUEUE_URL;
    const pubSub = createPubSub(client, {
      queueUrl: null,
      queue: { fifo: true, name: "events" }
    });

    await pubSub.publish("job.completed", { id: 10 });

    expect(client.commandsOf(CreateQueueCommand)[0].input).toMatchObject({
      QueueName: "events.fifo",
      Attributes: { FifoQueue: "true" }
    });
    expect(sendCommands(client)[0].input).toEqual(
      expect.objectContaining({
        MessageGroupId: "job.completed",
        MessageDeduplicationId: expect.any(String)
      })
    );
  });
});

describe("worker lifecycle", () => {
  it("makes start and close idempotent", async () => {
    const client = new MockSqsClient();
    const observer = observerSpies();
    const pubSub = createPubSub(client, { observer });

    await Promise.all([pubSub.start(), pubSub.start(), pubSub.start()]);
    await eventually(() =>
      expect(client.commandsOf(ReceiveMessageCommand)).toHaveLength(1)
    );
    await Promise.all([pubSub.close(), pubSub.close(), pubSub.close()]);

    expect(client.maxActiveReceives).toBe(1);
    expect(observer.lifecycle.mock.calls.map(([event]) => event.state)).toEqual(
      ["starting", "started", "closing", "closed"]
    );
  });

  it("aborts an active AWS SDK v3 long poll during shutdown", async () => {
    const client = new MockSqsClient();
    const pubSub = createPubSub(client);
    await pubSub.start();
    await eventually(() => expect(client.receiveSignals).toHaveLength(1));
    const signal = client.receiveSignals[0];

    await pubSub.close();

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(client.abortedReceives).toBe(1);
  });

  it("waits for in-flight listener dispatch and delete before closing", async () => {
    const client = new MockSqsClient();
    const receive = client.deferReceive();
    const listenerCompletion = deferred<void>();
    const listener = vi.fn(() => listenerCompletion.promise);
    const pubSub = createPubSub(client);
    await pubSub.subscribe("job.completed", listener);
    receive.resolve(
      receiveOutput(brokerMessage("job.completed", { id: "in-flight" }))
    );
    await eventually(() => expect(listener).toHaveBeenCalledOnce());

    let closed = false;
    const closing = pubSub.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    listenerCompletion.resolve();
    await closing;
    expect(deleteCommands(client)).toHaveLength(1);
  });
});

interface CreatePubSubOptions {
  observer?: SQSPubSubObserver;
  queue?: {
    autoCreate?: boolean;
    fifo?: boolean;
    name?: string;
  };
  queueUrl?: string | null;
}

function createPubSub(
  client: MockSqsClient,
  options: CreatePubSubOptions = {}
): SQSPubSub {
  const queueUrl =
    options.queueUrl === null
      ? undefined
      : (options.queueUrl ?? STANDARD_QUEUE_URL);
  const pubSub = new SQSPubSub(
    {
      region: "eu-west-1",
      pubSub: {
        client: client as unknown as SQSClient,
        observer: options.observer,
        queue: options.queue,
        receive: {
          waitTimeSeconds: 0,
          errorBackoffMs: 0
        }
      }
    },
    queueUrl
  );
  openPubSubs.push(pubSub);
  return pubSub;
}

function brokerMessage(
  triggerName: string,
  payload: unknown,
  messageId = "message-1",
  receiptHandle = `receipt-${messageId}`
): Message {
  return {
    MessageId: messageId,
    ReceiptHandle: receiptHandle,
    Body: JSON.stringify(payload),
    MessageAttributes: {
      [SQSPubSubTriggerName]: {
        DataType: "String",
        StringValue: triggerName
      }
    }
  };
}

function receiveOutput(...messages: Message[]): ReceiveMessageCommandOutput {
  return {
    Messages: messages,
    $metadata: {}
  };
}

function sendCommands(client: MockSqsClient): SendMessageCommand[] {
  return client.commandsOf(SendMessageCommand);
}

function deleteCommands(client: MockSqsClient): DeleteMessageCommand[] {
  return client.commandsOf(DeleteMessageCommand);
}

function observerSpies(): ObserverSpies {
  return {
    lifecycle: vi.fn(),
    receive: vi.fn(),
    dispatch: vi.fn(),
    delete: vi.fn(),
    error: vi.fn()
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  throw lastError;
}
