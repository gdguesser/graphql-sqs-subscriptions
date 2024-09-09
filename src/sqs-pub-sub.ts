import { SQSClient, CreateQueueCommand, DeleteMessageCommand, SendMessageCommand, ReceiveMessageCommand, SQSClientConfig } from "@aws-sdk/client-sqs";
import { fromWebToken } from "@aws-sdk/credential-providers";
import { PubSubEngine } from "graphql-subscriptions";
import { PubSubAsyncIterator } from "graphql-subscriptions/dist/pubsub-async-iterator";
import { v4 as uuid } from "uuid";

const AWS_SDK_API_VERSION = "2012-11-05";
const PUB_SUB_MESSAGE_ATTRIBUTE = "SQSPubSubTriggerName";

export class SQSPubSub implements PubSubEngine {
  public sqs: SQSClient;
  private queueUrl: string;
  private stopPolling: boolean = false;
  private triggerName: string;

  public constructor(config: SQSClientConfig = {}, queueUrl?: string) {
    this.sqs = new SQSClient(config);
    this.queueUrl = queueUrl;
  }

  public asyncIterator = <T>(triggers: string | string[]): AsyncIterator<T> => {
    return new PubSubAsyncIterator<T>(this, triggers);
  };

  public createQueue = async (): Promise<void> => {
    if (this.queueUrl) return;

    const params = {
      QueueName: `${process.env.NODE_ENV || "local"}-${uuid()}.fifo`,
      Attributes: {
        FifoQueue: "true"
      }
    };

    try {
      const command = new CreateQueueCommand(params);
      const result = await this.sqs.send(command);
      this.queueUrl = result.QueueUrl;
    } catch (error) {
      console.error(error);
    }
  };

  public deleteMessage = async (receiptHandle: string): Promise<void> => {
    const params = {
      QueueUrl: this.queueUrl,
      ReceiptHandle: receiptHandle
    };

    try {
      const command = new DeleteMessageCommand(params);
      await this.sqs.send(command);
    } catch (error) {
      console.error(error);
    }
  };

  public publish = async (triggerName: string, payload: any): Promise<void> => {
    if (!this.queueUrl) {
      await this.createQueue();
    }

    const params = {
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: triggerName,
      MessageDeduplicationId: uuid(),
      MessageAttributes: {
        [PUB_SUB_MESSAGE_ATTRIBUTE]: {
          DataType: "String",
          StringValue: triggerName
        }
      }
    };

    try {
      const command = new SendMessageCommand(params);
      await this.sqs.send(command);
    } catch (error) {
      console.error(error);
    }
  };

  public subscribe = (triggerName: string, onMessage: Function): Promise<number> => {
    this.stopPolling = false;
    this.poll(triggerName, onMessage);
    return Promise.resolve(1);
  };

  public unsubscribe = async (): Promise<void> => {
    this.stopPolling = true;
  };

  private readonly poll = async (triggerName: string, onMessage: Function): Promise<void> => {
    if (this.stopPolling) {
      return;
    }

    if (!this.queueUrl) {
      await this.createQueue();
    }

    const params = {
      MessageAttributeNames: [PUB_SUB_MESSAGE_ATTRIBUTE],
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20
    };

    try {
      const data = await this.receiveMessage(params);

      if (data && data.Messages) {
        for (const message of data.Messages) {
          const messageAttributes = message.MessageAttributes;
          if (messageAttributes && messageAttributes[PUB_SUB_MESSAGE_ATTRIBUTE] && messageAttributes[PUB_SUB_MESSAGE_ATTRIBUTE].StringValue === triggerName) {
            await this.deleteMessage(message.ReceiptHandle);
            onMessage(JSON.parse(message.Body));
          }
        }
      }
    } catch (error) {
      console.error(error);
    }

    if (!this.stopPolling) {
      setImmediate(() => this.poll(triggerName, onMessage));
    }
  };

  private readonly receiveMessage = async (params: any): Promise<any> => {
    try {
      const command = new ReceiveMessageCommand(params);
      return await this.sqs.send(command);
    } catch (error) {
      console.error(error);
      return {};
    }
  };
}