import type { SQSClient, SQSClientConfig } from "@aws-sdk/client-sqs";
/**
 * Message attribute used to route SQS messages to local GraphQL subscribers.
 */
export declare const SQSPubSubTriggerName = "SQSPubSubTriggerName";
export interface SQSPubSubQueueOptions {
    /**
     * Create a queue when no queue URL was supplied. Defaults to true for
     * backwards compatibility and is ignored when a queue URL is supplied.
     */
    autoCreate?: boolean;
    /**
     * Create/publish as FIFO. Standard queues are the default.
     */
    fifo?: boolean;
    /**
     * Queue name used for automatic or explicit queue creation.
     */
    name?: string;
    /**
     * Additional CreateQueue attributes.
     */
    attributes?: Record<string, string>;
}
export interface SQSPubSubReceiveOptions {
    /**
     * SQS long-poll duration. Defaults to 20 seconds.
     */
    waitTimeSeconds?: number;
    /**
     * Number of messages requested per receive. Defaults to 10.
     */
    maxNumberOfMessages?: number;
    /**
     * Optional visibility timeout passed to ReceiveMessage.
     */
    visibilityTimeout?: number;
    /**
     * Delay after a receive failure. Defaults to 1 second.
     */
    errorBackoffMs?: number;
}
export interface SQSPublishOptions {
    /**
     * Include FIFO-only fields even when the queue URL does not end in `.fifo`.
     */
    fifo?: boolean;
    /**
     * FIFO message group. Defaults to the trigger name.
     */
    messageGroupId?: string;
    /**
     * FIFO deduplication ID. Defaults to a generated UUID.
     */
    messageDeduplicationId?: string;
}
export interface SQSPubSubLifecycleEvent {
    state: "starting" | "started" | "closing" | "closed";
    timestamp: number;
}
export interface SQSPubSubReceiveEvent {
    phase: "started" | "completed";
    messageCount?: number;
    timestamp: number;
}
export interface SQSPubSubDispatchEvent {
    messageId?: string;
    triggerName: string;
    listenerCount: number;
    failedListenerCount: number;
    timestamp: number;
}
export interface SQSPubSubDeleteEvent {
    messageId?: string;
    timestamp: number;
}
export type SQSPubSubErrorOperation = "start" | "create_queue" | "receive" | "message" | "dispatch" | "delete" | "publish";
export type SQSPubSubErrorCode = "start_failed" | "queue_url_required" | "create_queue_failed" | "receive_failed" | "missing_receipt_handle" | "missing_trigger_attribute" | "missing_message_body" | "malformed_json" | "listener_failed" | "delete_failed" | "publish_failed";
export interface SQSPubSubErrorEvent {
    operation: SQSPubSubErrorOperation;
    code: SQSPubSubErrorCode;
    error: unknown;
    messageId?: string;
    triggerName?: string;
    timestamp: number;
}
/**
 * Optional, vendor-neutral telemetry hooks. Message bodies and payloads are
 * deliberately excluded from every event.
 */
export interface SQSPubSubObserver {
    lifecycle?(event: SQSPubSubLifecycleEvent): void | Promise<void>;
    receive?(event: SQSPubSubReceiveEvent): void | Promise<void>;
    dispatch?(event: SQSPubSubDispatchEvent): void | Promise<void>;
    delete?(event: SQSPubSubDeleteEvent): void | Promise<void>;
    error?(event: SQSPubSubErrorEvent): void | Promise<void>;
}
export interface SQSPubSubOptions {
    /**
     * Optional client injection for testing or shared AWS client configuration.
     */
    client?: SQSClient;
    observer?: SQSPubSubObserver;
    queue?: SQSPubSubQueueOptions;
    receive?: SQSPubSubReceiveOptions;
}
/**
 * AWS SQS client configuration plus transport-specific options. Existing
 * `SQSClientConfig` values remain valid without changes.
 */
export type SQSPubSubConfig = SQSClientConfig & {
    pubSub?: SQSPubSubOptions;
};
//# sourceMappingURL=types.d.ts.map