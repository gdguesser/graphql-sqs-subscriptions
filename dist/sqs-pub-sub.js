"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQSPubSub = void 0;
const node_crypto_1 = require("node:crypto");
const client_sqs_1 = require("@aws-sdk/client-sqs");
const graphql_subscriptions_1 = require("graphql-subscriptions");
const async_iterator_1 = require("./async-iterator");
const types_1 = require("./types");
const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_MAX_NUMBER_OF_MESSAGES = 10;
const DEFAULT_RECEIVE_ERROR_BACKOFF_MS = 1_000;
class SQSPubSub extends graphql_subscriptions_1.PubSubEngine {
    sqs;
    queueUrl;
    observer;
    queueOptions;
    receiveOptions;
    listenersByTrigger = new Map();
    triggerBySubscriptionId = new Map();
    nextSubscriptionId = 1;
    state = "idle";
    startPromise;
    closePromise;
    queueCreationPromise;
    pollPromise;
    abortController;
    constructor(config = {}, queueUrl) {
        super();
        const { pubSub, ...clientConfig } = config;
        this.sqs = pubSub?.client ?? new client_sqs_1.SQSClient(clientConfig);
        this.queueUrl = queueUrl;
        this.observer = pubSub?.observer;
        this.queueOptions = pubSub?.queue ?? {};
        this.receiveOptions = pubSub?.receive ?? {};
    }
    /**
     * Compatibility API used by graphql-subscriptions v2 consumers.
     */
    asyncIterator(triggers) {
        return new async_iterator_1.SQSPubSubAsyncIterator(this, triggers);
    }
    async publish(triggerName, payload, options = {}) {
        try {
            this.assertTriggerName(triggerName);
            const queueUrl = await this.requireQueueUrl();
            const messageBody = JSON.stringify(payload);
            if (messageBody === undefined) {
                throw new TypeError("SQS message payload must be JSON serializable");
            }
            const input = {
                QueueUrl: queueUrl,
                MessageBody: messageBody,
                MessageAttributes: {
                    [types_1.SQSPubSubTriggerName]: {
                        DataType: "String",
                        StringValue: triggerName
                    }
                }
            };
            if (this.isFifoPublish(queueUrl, options)) {
                input.MessageGroupId = options.messageGroupId ?? triggerName;
                input.MessageDeduplicationId =
                    options.messageDeduplicationId ?? (0, node_crypto_1.randomUUID)();
            }
            await this.sqs.send(new client_sqs_1.SendMessageCommand(input));
        }
        catch (error) {
            const code = error instanceof QueueUrlRequiredError
                ? "queue_url_required"
                : "publish_failed";
            this.reportError("publish", code, error, undefined, triggerName);
            throw error;
        }
    }
    async subscribe(triggerName, onMessage, _options = {}) {
        this.assertTriggerName(triggerName);
        if (typeof onMessage !== "function") {
            throw new TypeError("Subscription listener must be a function");
        }
        const subscriptionId = this.nextSubscriptionId++;
        const listeners = this.listenersByTrigger.get(triggerName) ?? new Map();
        listeners.set(subscriptionId, onMessage);
        this.listenersByTrigger.set(triggerName, listeners);
        this.triggerBySubscriptionId.set(subscriptionId, triggerName);
        try {
            await this.start();
            return subscriptionId;
        }
        catch (error) {
            await this.unsubscribe(subscriptionId);
            throw error;
        }
    }
    async unsubscribe(subscriptionId) {
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
    start() {
        if (this.state === "running") {
            return Promise.resolve();
        }
        if (this.state === "closing" || this.state === "closed") {
            return Promise.reject(new Error("Cannot start an SQSPubSub instance after close()"));
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
    close() {
        if (!this.closePromise) {
            this.closePromise = this.closeInternal();
        }
        return this.closePromise;
    }
    /**
     * Explicit queue creation remains available for backwards compatibility.
     */
    async createQueue() {
        if (this.queueUrl) {
            return;
        }
        if (!this.queueCreationPromise) {
            this.queueCreationPromise = this.createQueueInternal();
        }
        try {
            this.queueUrl = await this.queueCreationPromise;
        }
        finally {
            this.queueCreationPromise = undefined;
        }
    }
    async deleteMessage(receiptHandle) {
        const queueUrl = await this.requireQueueUrl();
        await this.deleteReceivedMessage(queueUrl, receiptHandle);
    }
    async startInternal() {
        try {
            await this.requireQueueUrl();
            if (this.state !== "starting") {
                return;
            }
            this.abortController = new AbortController();
            this.state = "running";
            this.pollPromise = this.runPollWorker(this.abortController.signal).catch((error) => {
                if (!this.abortController?.signal.aborted) {
                    this.reportError("receive", "receive_failed", error, undefined, undefined);
                }
            });
            this.notifyLifecycle("started");
        }
        catch (error) {
            if (this.state === "starting") {
                this.state = "idle";
            }
            const code = error instanceof QueueUrlRequiredError
                ? "queue_url_required"
                : "start_failed";
            this.reportError("start", code, error, undefined, undefined);
            throw error;
        }
        finally {
            this.startPromise = undefined;
        }
    }
    async closeInternal() {
        if (this.state === "closed") {
            return;
        }
        this.notifyLifecycle("closing");
        const pendingStart = this.startPromise;
        this.state = "closing";
        if (pendingStart) {
            try {
                await pendingStart;
            }
            catch {
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
    async createQueueInternal() {
        const configuredName = this.queueOptions.name;
        const fifo = this.queueOptions.fifo === true ||
            configuredName?.endsWith(".fifo") === true;
        const defaultName = `${process.env.NODE_ENV || "local"}-${(0, node_crypto_1.randomUUID)()}`;
        let queueName = configuredName ?? defaultName;
        if (fifo && !queueName.endsWith(".fifo")) {
            queueName += ".fifo";
        }
        const attributes = {
            ...this.queueOptions.attributes,
            ...(fifo ? { FifoQueue: "true" } : {})
        };
        try {
            const result = await this.sqs.send(new client_sqs_1.CreateQueueCommand({
                QueueName: queueName,
                ...(Object.keys(attributes).length > 0
                    ? { Attributes: attributes }
                    : {})
            }));
            if (!result.QueueUrl) {
                throw new Error("CreateQueue did not return a queue URL");
            }
            return result.QueueUrl;
        }
        catch (error) {
            this.reportError("create_queue", "create_queue_failed", error, undefined, undefined);
            throw error;
        }
    }
    async requireQueueUrl() {
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
    async runPollWorker(signal) {
        const queueUrl = await this.requireQueueUrl();
        const receiveInput = {
            QueueUrl: queueUrl,
            MessageAttributeNames: [types_1.SQSPubSubTriggerName],
            MaxNumberOfMessages: this.receiveOptions.maxNumberOfMessages ??
                DEFAULT_MAX_NUMBER_OF_MESSAGES,
            WaitTimeSeconds: this.receiveOptions.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS,
            ...(this.receiveOptions.visibilityTimeout === undefined
                ? {}
                : { VisibilityTimeout: this.receiveOptions.visibilityTimeout })
        };
        while (!signal.aborted) {
            this.notifyReceive({
                phase: "started",
                timestamp: Date.now()
            });
            let messages;
            try {
                const response = await this.sqs.send(new client_sqs_1.ReceiveMessageCommand(receiveInput), { abortSignal: signal });
                messages = response.Messages ?? [];
            }
            catch (error) {
                if (this.isAbortError(error, signal)) {
                    break;
                }
                this.reportError("receive", "receive_failed", error, undefined, undefined);
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
    async processMessage(queueUrl, message) {
        const messageId = message.MessageId;
        const receiptHandle = message.ReceiptHandle;
        if (!receiptHandle) {
            this.reportError("message", "missing_receipt_handle", new Error("Received SQS message without a receipt handle"), messageId, undefined);
            return;
        }
        const triggerName = message.MessageAttributes?.[types_1.SQSPubSubTriggerName]?.StringValue;
        if (!triggerName) {
            this.reportError("message", "missing_trigger_attribute", new Error(`Received SQS message without ${types_1.SQSPubSubTriggerName} attribute`), messageId, undefined);
            return;
        }
        if (message.Body === undefined) {
            this.reportError("message", "missing_message_body", new Error("Received SQS message without a body"), messageId, triggerName);
            return;
        }
        let payload;
        try {
            payload = JSON.parse(message.Body);
        }
        catch (error) {
            this.reportError("message", "malformed_json", error, messageId, triggerName);
            return;
        }
        const listeners = [
            ...(this.listenersByTrigger.get(triggerName)?.values() ?? [])
        ];
        const results = await Promise.allSettled(listeners.map((listener) => Promise.resolve().then(() => listener(payload))));
        let failedListenerCount = 0;
        for (const result of results) {
            if (result.status === "rejected") {
                failedListenerCount += 1;
                this.reportError("dispatch", "listener_failed", result.reason, messageId, triggerName);
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
            await this.deleteReceivedMessage(queueUrl, receiptHandle, messageId, triggerName);
        }
        catch {
            // Failed deletes are observable and SQS will make the message visible
            // again; the worker should continue processing the rest of the batch.
        }
    }
    async deleteReceivedMessage(queueUrl, receiptHandle, messageId, triggerName) {
        try {
            await this.sqs.send(new client_sqs_1.DeleteMessageCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: receiptHandle
            }));
            this.notifyDelete({
                messageId,
                timestamp: Date.now()
            });
        }
        catch (error) {
            this.reportError("delete", "delete_failed", error, messageId, triggerName);
            throw error;
        }
    }
    waitAfterReceiveError(signal) {
        const delay = this.receiveOptions.errorBackoffMs ?? DEFAULT_RECEIVE_ERROR_BACKOFF_MS;
        return new Promise((resolve) => {
            if (signal.aborted) {
                resolve(false);
                return;
            }
            const onAbort = () => {
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
    isFifoPublish(queueUrl, options) {
        return (options.fifo === true ||
            this.queueOptions.fifo === true ||
            queueUrl.endsWith(".fifo"));
    }
    isAbortError(error, signal) {
        return (signal.aborted || (error instanceof Error && error.name === "AbortError"));
    }
    assertTriggerName(triggerName) {
        if (typeof triggerName !== "string" || triggerName.length === 0) {
            throw new TypeError("Trigger name must be a non-empty string");
        }
    }
    reportError(operation, code, error, messageId, triggerName) {
        this.notify(this.observer?.error, {
            operation,
            code,
            error,
            messageId,
            triggerName,
            timestamp: Date.now()
        });
    }
    notifyLifecycle(state) {
        this.notify(this.observer?.lifecycle, {
            state,
            timestamp: Date.now()
        });
    }
    notifyReceive(event) {
        this.notify(this.observer?.receive, event);
    }
    notifyDispatch(event) {
        this.notify(this.observer?.dispatch, event);
    }
    notifyDelete(event) {
        this.notify(this.observer?.delete, event);
    }
    notify(hook, event) {
        if (!hook) {
            return;
        }
        try {
            void Promise.resolve(hook(event)).catch(() => undefined);
        }
        catch {
            // Observer failures must never alter message delivery.
        }
    }
}
exports.SQSPubSub = SQSPubSub;
class QueueUrlRequiredError extends Error {
    constructor() {
        super("An SQS queue URL is required when pubSub.queue.autoCreate is false");
        this.name = "QueueUrlRequiredError";
    }
}
//# sourceMappingURL=sqs-pub-sub.js.map