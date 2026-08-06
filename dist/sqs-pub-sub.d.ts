import { SQSClient } from "@aws-sdk/client-sqs";
import { PubSubEngine } from "graphql-subscriptions";
import { type SQSPublishOptions, type SQSPubSubConfig } from "./types";
type Listener = (payload: unknown) => unknown;
export declare class SQSPubSub extends PubSubEngine {
    sqs: SQSClient;
    private queueUrl?;
    private readonly observer?;
    private readonly queueOptions;
    private readonly receiveOptions;
    private readonly listenersByTrigger;
    private readonly triggerBySubscriptionId;
    private nextSubscriptionId;
    private state;
    private startPromise?;
    private closePromise?;
    private queueCreationPromise?;
    private pollPromise?;
    private abortController?;
    constructor(config?: SQSPubSubConfig, queueUrl?: string);
    /**
     * Compatibility API used by graphql-subscriptions v2 consumers.
     */
    asyncIterator<T>(triggers: string | readonly string[]): AsyncIterableIterator<T>;
    publish(triggerName: string, payload: unknown, options?: SQSPublishOptions): Promise<void>;
    subscribe(triggerName: string, onMessage: Listener, _options?: object): Promise<number>;
    unsubscribe(subscriptionId: number): Promise<void>;
    /**
     * Starts one receive worker for this SQSPubSub instance.
     */
    start(): Promise<void>;
    /**
     * Aborts an active long poll, then waits for received messages already being
     * dispatched/deleted to finish.
     */
    close(): Promise<void>;
    /**
     * Explicit queue creation remains available for backwards compatibility.
     */
    createQueue(): Promise<void>;
    deleteMessage(receiptHandle: string): Promise<void>;
    private startInternal;
    private closeInternal;
    private createQueueInternal;
    private requireQueueUrl;
    private runPollWorker;
    private processMessage;
    private deleteReceivedMessage;
    private waitAfterReceiveError;
    private isFifoPublish;
    private isAbortError;
    private assertTriggerName;
    private reportError;
    private notifyLifecycle;
    private notifyReceive;
    private notifyDispatch;
    private notifyDelete;
    private notify;
}
export {};
//# sourceMappingURL=sqs-pub-sub.d.ts.map