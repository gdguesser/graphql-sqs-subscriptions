# graphql-sqs-subscriptions

## About this fork

I maintain this fork for a project at Mercedes-Benz.io. It moves the SQS
integration to AWS SDK v3 and includes the fixes needed by that project.

This package implements the PubSubEngine Interface from the [graphql-subscriptions](https://github.com/apollographql/graphql-subscriptions) package. It allows you to connect your subscriptions manager to an AWS SQS (Simple Queue Service) queue.

## Installation

```bash
npm install github:gdguesser/graphql-sqs-subscriptions#master
```

## Usage

Define your GraphQL schema with a `Subscription` type:

```graphql
schema {
  query: Query
  mutation: Mutation
  subscription: Subscription
}

type Subscription {
  fooAdded: Result
}

type Result {
  id: String
}
```

Create an `SQSPubSub` instance with an AWS SDK v3 `SQSClientConfig`. This
example uses the SDK’s default credential provider chain:

```js
import { SQSPubSub } from "graphql-sqs-subscriptions";

const pubsub = new SQSPubSub({
  region: process.env.AWS_REGION
});
```

Now, implement your Subscription resolver, using the `pubsub.asyncIterator` method, passing in the relevant trigger name:

```js
export const resolvers = {
  Subscription: {
    fooAdded: {
      subscribe: () => pubsub.asyncIterator("foo_added")
    }
  }
};
```

Calling the `asyncIterator` method will subscribe the `SQSPubSub` instance to any new message on the SQS queue.

Any time `pubsub.publish` is then called, with a matching trigger name (i.e. `"foo_added"`), GraphQL will publish the data to all subscribed clients.

```js
pubsub.publish("foo_added", { fooAdded: { id: "123" } });
```
