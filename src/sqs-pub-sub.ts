import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type ReceiveMessageCommandInput,
  SendMessageCommand,
  type SendMessageCommandInput,
  SQSClient,
  type SQSClientConfig
} from "@aws-sdk/client-sqs";
import { PubSubEngine } from "graphql-subscriptions";

import { SQSPubSubAsyncIterator } from "./async-iterator";
import {
  type SQSPublishOptions,
  type SQSPubSubConfig,
  type SQSPubSubDeleteEvent,
  type SQSPubSubDispatchEvent,
  type SQSPubSubErrorCode,
  type SQSPubSubErrorOperation,
  type SQSPubSubLifecycleEvent,
  type SQSPubSubObserver,
  type SQSPubSubQueueOptions,
  type SQSPubSubReceiveEvent,
  type SQSPubSubReceiveOptions,
  SQSPubSubTriggerName
} from "./types";

type Listener = (payload: unknown) => unknown;
type LifecycleState = "idle" | "starting" | "running" | "closing" | "closed";

const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_MAX_NUMBER_OF_MESSAGES = 10;
const DEFAULT_RECEIVE_ERROR_BACKOFF_MS = 1_000;

export class SQSPubSub extends PubSubEngine {
  public sqs: SQSClient;

  private queueUrl?: string;
  private readonly observer?: SQSPubSubObserver;
  private readonly queueOptions: SQSPubSubQueueOptions;
  private readonly receiveOptions: SQSPubSubReceiveOptions;
  private readonly listenersByTrigger = new Map<
    string,
    Map<number, Listener>
  >();
  private readonly triggerBySubscriptionId = new Map<number, string>();
  private nextSubscriptionId = 1;
  private state: LifecycleState = "idle";
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private queueCreationPromise?: Promise<string>;
  private pollPromise?: Promise<void>;
  private abortController?: AbortController;

  public constructor(config: SQSPubSubConfig = {}, queueUrl?: string) {
    super();

    const { pubSub, ...clientConfig } = config;
    this.sqs = pubSub?.client ?? new SQSClient(clientConfig as SQSClientConfig);
    this.queueUrl = queueUrl;
    this.observer = pubSub?.observer;
    this.queueOptions = pubSub?.queue ?? {};
    this.receiveOptions = pubSub?.receive ?? {};
  }

  /**
   * Compatibility API used by graphql-subscriptions v2 consumers.
   */
  public asyncIterator<T>(
    triggers: string | readonly string[]
  ): AsyncIterableIterator<T> {
    return new SQSPubSubAsyncIterator<T>(this, triggers);
  }

  public async publish(
    triggerName: string,
    payload: unknown,
    options: SQSPublishOptions = {}
  ): Promise<void> {
    try {
      this.assertTriggerName(triggerName);
      const queueUrl = await this.requireQueueUrl();
      const messageBody = JSON.stringify(payload);

      if (messageBody === undefined) {
        throw new TypeError("SQS message payload must be JSON serializable");
      }

      const input: SendMessageCommandInput = {
        QueueUrl: queueUrl,
        MessageBody: messageBody,
        MessageAttributes: {
          [SQSPubSubTriggerName]: {
            DataType: "String",
            StringValue: triggerName
          }
        }
      };

      if (this.isFifoPublish(queueUrl, options)) {
        input.MessageGroupId = options.messageGroupId ?? triggerName;
        input.MessageDeduplicationId =
          options.messageDeduplicationId ?? randomUUID();
      }

      await this.sqs.send(new SendMessageCommand(input));
    } catch (error) {
      const code =
        error instanceof QueueUrlRequiredError
          ? "queue_url_required"
          : "publish_failed";
      this.reportError("publish", code, error, undefined, triggerName);
      throw error;
    }
  }

  public async subscribe(
    triggerName: string,
    onMessage: Listener,
    _options: object = {}
  ): Promise<number> {
    this.assertTriggerName(triggerName);

    if (typeof onMessage !== "function") {
      throw new TypeError("Subscription listener must be a function");
    }

    const subscriptionId = this.nextSubscriptionId++;
    const listeners =
      this.listenersByTrigger.get(triggerName) ?? new Map<number, Listener>();
    listeners.set(subscriptionId, onMessage);
    this.listenersByTrigger.set(triggerName, listeners);
    this.triggerBySubscriptionId.set(subscriptionId, triggerName);

    try {
      await this.start();
      return subscriptionId;
    } catch (error) {
      await this.unsubscribe(subscriptionId);
      throw error;
    }
  }

  public async unsubscribe(subscriptionId: number): Promise<void> {
    const triggerName = this.triggerBySubscriptionId.get(subscriptionId);
    if (!triggerName) {
      return;
    }

    this.triggerBySubscriptionId.delete(subscriptionId);
    const listeners = this.listenersByTrigger.get(triggerName);
    listeners?.delete(subscriptionId);

    if (listeners?.size === 0) {
      this.listenersByTrigger.delete(triggerName);
    }
  }

  /**
   * Starts one receive worker for this SQSPubSub instance.
   */
  public start(): Promise<void> {
    if (this.state === "running") {
      return Promise.resolve();
    }

    if (this.state === "closing" || this.state === "closed") {
      return Promise.reject(
        new Error("Cannot start an SQSPubSub instance after close()")
      );
    }

    if (!this.startPromise) {
      this.state = "starting";
      this.notifyLifecycle("starting");
      this.startPromise = this.startInternal();
    }

    return this.startPromise;
  }

  /**
   * Aborts an active long poll, then waits for received messages already being
   * dispatched/deleted to finish.
   */
  public close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal();
    }

    return this.closePromise;
  }

  /**
   * Explicit queue creation remains available for backwards compatibility.
   */
  public async createQueue(): Promise<void> {
    if (this.queueUrl) {
      return;
    }

    if (!this.queueCreationPromise) {
      this.queueCreationPromise = this.createQueueInternal();
    }

    try {
      this.queueUrl = await this.queueCreationPromise;
    } finally {
      this.queueCreationPromise = undefined;
    }
  }

  public async deleteMessage(receiptHandle: string): Promise<void> {
    const queueUrl = await this.requireQueueUrl();
    await this.deleteReceivedMessage(queueUrl, receiptHandle);
  }

  private async startInternal(): Promise<void> {
    try {
      await this.requireQueueUrl();

      if (this.state !== "starting") {
        return;
      }

      this.abortController = new AbortController();
      this.state = "running";
      this.pollPromise = this.runPollWorker(this.abortController.signal).catch(
        (error: unknown) => {
          if (!this.abortController?.signal.aborted) {
            this.reportError(
              "receive",
              "receive_failed",
              error,
              undefined,
              undefined
            );
          }
        }
      );
      this.notifyLifecycle("started");
    } catch (error) {
      if (this.state === "starting") {
        this.state = "idle";
      }
      const code =
        error instanceof QueueUrlRequiredError
          ? "queue_url_required"
          : "start_failed";
      this.reportError("start", code, error, undefined, undefined);
      throw error;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async closeInternal(): Promise<void> {
    if (this.state === "closed") {
      return;
    }

    this.notifyLifecycle("closing");
    const pendingStart = this.startPromise;
    this.state = "closing";

    if (pendingStart) {
      try {
        await pendingStart;
      } catch {
        // The start error was already surfaced to the caller and observer.
      }
    }

    this.abortController?.abort();

    if (this.pollPromise) {
      await this.pollPromise;
    }

    this.listenersByTrigger.clear();
    this.triggerBySubscriptionId.clear();
    this.state = "closed";
    this.notifyLifecycle("closed");
  }

  private async createQueueInternal(): Promise<string> {
    const configuredName = this.queueOptions.name;
    const fifo =
      this.queueOptions.fifo === true ||
      configuredName?.endsWith(".fifo") === true;
    const defaultName = `${process.env.NODE_ENV || "local"}-${randomUUID()}`;
    let queueName = configuredName ?? defaultName;

    if (fifo && !queueName.endsWith(".fifo")) {
      queueName += ".fifo";
    }

    const attributes = {
      ...this.queueOptions.attributes,
      ...(fifo ? { FifoQueue: "true" } : {})
    };

    try {
      const result = await this.sqs.send(
        new CreateQueueCommand({
          QueueName: queueName,
          ...(Object.keys(attributes).length > 0
            ? { Attributes: attributes }
            : {})
        })
      );

      if (!result.QueueUrl) {
        throw new Error("CreateQueue did not return a queue URL");
      }

      return result.QueueUrl;
    } catch (error) {
      this.reportError(
        "create_queue",
        "create_queue_failed",
        error,
        undefined,
        undefined
      );
      throw error;
    }
  }

  private async requireQueueUrl(): Promise<string> {
    if (this.queueUrl) {
      return this.queueUrl;
    }

    if (this.queueOptions.autoCreate === false) {
      throw new QueueUrlRequiredError();
    }

    await this.createQueue();

    if (!this.queueUrl) {
      throw new Error("SQS queue URL is unavailable");
    }

    return this.queueUrl;
  }

  private async runPollWorker(signal: AbortSignal): Promise<void> {
    const queueUrl = await this.requireQueueUrl();
    const receiveInput: ReceiveMessageCommandInput = {
      QueueUrl: queueUrl,
      MessageAttributeNames: [SQSPubSubTriggerName],
      MaxNumberOfMessages:
        this.receiveOptions.maxNumberOfMessages ??
        DEFAULT_MAX_NUMBER_OF_MESSAGES,
      WaitTimeSeconds:
        this.receiveOptions.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS,
      ...(this.receiveOptions.visibilityTimeout === undefined
        ? {}
        : { VisibilityTimeout: this.receiveOptions.visibilityTimeout })
    };

    while (!signal.aborted) {
      this.notifyReceive({
        phase: "started",
        timestamp: Date.now()
      });

      let messages: Message[];
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand(receiveInput),
          { abortSignal: signal }
        );
        messages = response.Messages ?? [];
      } catch (error) {
        if (this.isAbortError(error, signal)) {
          break;
        }

        this.reportError(
          "receive",
          "receive_failed",
          error,
          undefined,
          undefined
        );

        const shouldContinue = await this.waitAfterReceiveError(signal);
        if (!shouldContinue) {
          break;
        }
        continue;
      }

      this.notifyReceive({
        phase: "completed",
        messageCount: messages.length,
        timestamp: Date.now()
      });

      for (const message of messages) {
        await this.processMessage(queueUrl, message);
      }
    }
  }

  private async processMessage(
    queueUrl: string,
    message: Message
  ): Promise<void> {
    const messageId = message.MessageId;
    const receiptHandle = message.ReceiptHandle;

    if (!receiptHandle) {
      this.reportError(
        "message",
        "missing_receipt_handle",
        new Error("Received SQS message without a receipt handle"),
        messageId,
        undefined
      );
      return;
    }

    const triggerName =
      message.MessageAttributes?.[SQSPubSubTriggerName]?.StringValue;
    if (!triggerName) {
      this.reportError(
        "message",
        "missing_trigger_attribute",
        new Error(
          `Received SQS message without ${SQSPubSubTriggerName} attribute`
        ),
        messageId,
        undefined
      );
      return;
    }

    if (message.Body === undefined) {
      this.reportError(
        "message",
        "missing_message_body",
        new Error("Received SQS message without a body"),
        messageId,
        triggerName
      );
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(message.Body) as unknown;
    } catch (error) {
      this.reportError(
        "message",
        "malformed_json",
        error,
        messageId,
        triggerName
      );
      return;
    }

    const listeners = [
      ...(this.listenersByTrigger.get(triggerName)?.values() ?? [])
    ];
    const results = await Promise.allSettled(
      listeners.map((listener) =>
        Promise.resolve().then(() => listener(payload))
      )
    );
    let failedListenerCount = 0;

    for (const result of results) {
      if (result.status === "rejected") {
        failedListenerCount += 1;
        this.reportError(
          "dispatch",
          "listener_failed",
          result.reason,
          messageId,
          triggerName
        );
      }
    }

    this.notifyDispatch({
      messageId,
      triggerName,
      listenerCount: listeners.length,
      failedListenerCount,
      timestamp: Date.now()
    });

    try {
      await this.deleteReceivedMessage(
        queueUrl,
        receiptHandle,
        messageId,
        triggerName
      );
    } catch {
      // Failed deletes are observable and SQS will make the message visible
      // again; the worker should continue processing the rest of the batch.
    }
  }

  private async deleteReceivedMessage(
    queueUrl: string,
    receiptHandle: string,
    messageId?: string,
    triggerName?: string
  ): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle
        })
      );
      this.notifyDelete({
        messageId,
        timestamp: Date.now()
      });
    } catch (error) {
      this.reportError(
        "delete",
        "delete_failed",
        error,
        messageId,
        triggerName
      );
      throw error;
    }
  }

  private waitAfterReceiveError(signal: AbortSignal): Promise<boolean> {
    const delay =
      this.receiveOptions.errorBackoffMs ?? DEFAULT_RECEIVE_ERROR_BACKOFF_MS;

    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }

      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(!signal.aborted);
      }, delay);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private isFifoPublish(queueUrl: string, options: SQSPublishOptions): boolean {
    return (
      options.fifo === true ||
      this.queueOptions.fifo === true ||
      queueUrl.endsWith(".fifo")
    );
  }

  private isAbortError(error: unknown, signal: AbortSignal): boolean {
    return (
      signal.aborted || (error instanceof Error && error.name === "AbortError")
    );
  }

  private assertTriggerName(triggerName: string): void {
    if (typeof triggerName !== "string" || triggerName.length === 0) {
      throw new TypeError("Trigger name must be a non-empty string");
    }
  }

  private reportError(
    operation: SQSPubSubErrorOperation,
    code: SQSPubSubErrorCode,
    error: unknown,
    messageId?: string,
    triggerName?: string
  ): void {
    this.notify(this.observer?.error, {
      operation,
      code,
      error,
      messageId,
      triggerName,
      timestamp: Date.now()
    });
  }

  private notifyLifecycle(state: SQSPubSubLifecycleEvent["state"]): void {
    this.notify(this.observer?.lifecycle, {
      state,
      timestamp: Date.now()
    });
  }

  private notifyReceive(event: SQSPubSubReceiveEvent): void {
    this.notify(this.observer?.receive, event);
  }

  private notifyDispatch(event: SQSPubSubDispatchEvent): void {
    this.notify(this.observer?.dispatch, event);
  }

  private notifyDelete(event: SQSPubSubDeleteEvent): void {
    this.notify(this.observer?.delete, event);
  }

  private notify<T>(
    hook: ((event: T) => void | Promise<void>) | undefined,
    event: T
  ): void {
    if (!hook) {
      return;
    }

    try {
      void Promise.resolve(hook(event)).catch(() => undefined);
    } catch {
      // Observer failures must never alter message delivery.
    }
  }
}

class QueueUrlRequiredError extends Error {
  public constructor() {
    super("An SQS queue URL is required when pubSub.queue.autoCreate is false");
    this.name = "QueueUrlRequiredError";
  }
}
