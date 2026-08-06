# graphql-sqs-subscriptions

An AWS SDK v3 SQS transport for
[`graphql-subscriptions`](https://github.com/apollographql/graphql-subscriptions).
Each `SQSPubSub` instance runs one long-poll worker for one queue and fans a
received event out to every matching listener in that Node.js process.

## Important topology limit

Direct SQS is a competing-consumer transport, not a broadcast transport.
This package supports local fan-out in **one consuming server process**.

If multiple GraphQL server replicas consume the same queue, SQS sends each
message to only one replica. Subscribers connected to the other replicas will
not receive that live event. Multi-replica broadcast requires another
topology, such as SNS fan-out to one SQS queue per replica. This package does
not claim multi-replica support.

GraphQL events are live notifications:

- valid events are drained after the worker starts, even with zero listeners;
- reconnecting clients do not receive replay from this package;
- applications should query canonical state after reconnecting;
- SQS is at-least-once, so consumers must tolerate duplicate delivery.

## Requirements and installation

- Node.js 20 or newer
- `graphql` 15.7+ or 16
- `graphql-subscriptions` 2 or 3

The maintained fork can be installed directly from GitHub:

```bash
npm install github:gdguesser/graphql-sqs-subscriptions#master
```

## Existing API

The original constructor and `asyncIterator()` API remain supported. Passing
no credentials uses the AWS SDK v3 default credential provider chain.

```ts
import { SQSPubSub } from "graphql-sqs-subscriptions";

const pubsub = new SQSPubSub(
  {
    region: process.env.AWS_REGION
  },
  process.env.GRAPHQL_EVENTS_QUEUE_URL
);

export const resolvers = {
  Subscription: {
    fooAdded: {
      subscribe: () => pubsub.asyncIterator("foo_added")
    }
  }
};
```

`graphql-subscriptions` v3 consumers may use its inherited
`asyncIterableIterator()` API instead.

Publishing preserves the `SQSPubSubTriggerName` message attribute:

```ts
await pubsub.publish("foo_added", {
  fooAdded: { id: "123" }
});
```

Call `close()` from the server shutdown path. It is idempotent, cancels an
active AWS long poll with `AbortController`, and waits for message dispatch
and deletion already in progress.

```ts
process.once("SIGTERM", async () => {
  await pubsub.close();
});
```

Subscriptions start the worker lazily. `start()` is also public and
idempotent when a process should drain live events before the first GraphQL
client subscribes. A closed instance is terminal and cannot be restarted.

## Queue and receive options

Transport-specific options live under `config.pubSub`, so every existing
`SQSClientConfig` remains valid:

```ts
const pubsub = new SQSPubSub(
  {
    region: "eu-west-1",
    pubSub: {
      queue: {
        autoCreate: false,
        fifo: false
      },
      receive: {
        waitTimeSeconds: 20,
        maxNumberOfMessages: 10,
        errorBackoffMs: 1000
      }
    }
  },
  queueUrl
);
```

- An external queue URL is always used as supplied and is never
  auto-created.
- With no URL, `autoCreate` defaults to `true` for compatibility. Set it to
  `false` to require an externally managed queue.
- Auto-created queues and published messages are standard by default.
- A `.fifo` queue URL or `queue.fifo: true` enables FIFO publishing.
- `queue.name` and `queue.attributes` customize `CreateQueue`.
- `pubSub.client` can inject an existing AWS SDK v3 `SQSClient`.

FIFO-only send fields are omitted for standard queues:

```ts
await pubsub.publish("foo_added", payload, {
  fifo: true,
  messageGroupId: "foo",
  messageDeduplicationId: eventId
});
```

When FIFO mode is active, the trigger name and a generated UUID are the
default group and deduplication IDs.

## Delivery and error policy

Every SQS message body is parsed once. Its trigger is looked up in the local
registry, all matching listeners are attempted, and only then is the message
deleted.

- One listener throwing or rejecting does not block other listeners.
- Listener failures are reported and the broker message is still deleted
  after all local listeners have been attempted.
- Valid events with no matching listener are deleted because this is a live,
  non-replay transport.
- Malformed JSON, a missing body, a missing receipt handle, or a missing
  `SQSPubSubTriggerName` attribute is reported and not deleted. Configure an
  SQS redrive policy if those messages should eventually reach a DLQ.
- Receive failures are reported and retried after the configured backoff.
- Delete failures are reported; SQS can redeliver the message after its
  visibility timeout.
- Duplicate broker deliveries are intentionally not hidden.

## Observer hooks

Optional observer hooks provide vendor-neutral lifecycle, receive, dispatch,
delete, and error events:

```ts
const pubsub = new SQSPubSub(
  {
    region: "eu-west-1",
    pubSub: {
      observer: {
        lifecycle: (event) => metrics.lifecycle(event.state),
        dispatch: (event) =>
          metrics.dispatched(event.triggerName, event.listenerCount),
        error: (event) =>
          logger.error(event.error, {
            operation: event.operation,
            code: event.code,
            messageId: event.messageId
          })
      }
    }
  },
  queueUrl
);
```

There is no logging-vendor dependency and no telemetry is emitted by
default. Observer events never contain the SQS body or parsed payload.
Applications control how reported errors and metadata are handled.
Observer failures do not affect transport behavior.

## Migration notes

From the earlier fork:

- `new SQSPubSub(config, queueUrl?)`, `publish()`, and `asyncIterator()` are
  unchanged.
- Every subscription now receives a unique numeric ID.
  `unsubscribe(id)` removes only that listener.
- Subscriptions share one receive worker instead of competing poll loops.
- Unsubscribing the last listener does not stop or pause the worker; call
  `close()` during process shutdown.
- AWS failures are no longer swallowed with `console.error`; operations
  reject where applicable and worker errors go to observer hooks.
- New queues and ordinary sends are standard by default. The previous
  implementation always sent FIFO fields and auto-created a FIFO queue.
- Imports from `graphql-subscriptions/dist/*` have been removed.

## Development

```bash
npm test
npm run typecheck
npm run build
npm run lint
npm run format:check
npm pack --dry-run
npm audit --omit=dev
```

Unit tests use a deterministic injected AWS SDK v3 client and do not need
Docker. A LocalStack integration suite is opt-in:

```bash
docker run --rm -p 4566:4566 -e SERVICES=sqs localstack/localstack
npm run test:integration:localstack
```

Set `LOCALSTACK_ENDPOINT` when LocalStack is not available at
`http://localhost:4566`.

## Attribution

This maintained fork retains the original MIT license and attribution:
Copyright (c) 2019 John Flockton.
