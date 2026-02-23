import { SQSClient, SQSClientConfig } from "@aws-sdk/client-sqs";
import { PubSubEngine } from "graphql-subscriptions";
export declare class SQSPubSub implements PubSubEngine {
    sqs: SQSClient;
    private queueUrl;
    private stopPolling;
    private triggerName;
    constructor(config?: SQSClientConfig, queueUrl?: string);
    asyncIterator: <T>(triggers: string | string[]) => AsyncIterator<T>;
    createQueue: () => Promise<void>;
    deleteMessage: (receiptHandle: string) => Promise<void>;
    publish: (triggerName: string, payload: any) => Promise<void>;
    subscribe: (triggerName: string, onMessage: Function) => Promise<number>;
    unsubscribe: () => Promise<void>;
    private readonly poll;
    private readonly receiveMessage;
}
