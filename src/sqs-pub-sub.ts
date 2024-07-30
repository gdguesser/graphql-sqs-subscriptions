import aws, { AWSError, SQS } from "aws-sdk";
import { PubSubEngine } from "graphql-subscriptions";
import { PubSubAsyncIterator } from "graphql-subscriptions/dist/pubsub-async-iterator";
import uuid from "uuid";
import { errorHandler } from "./utils";

const AWS_SDK_API_VERSION = "2012-11-05";
const PUB_SUB_MESSAGE_ATTRIBUTE = "SQSPubSubTriggerName";

export class SQSPubSub implements PubSubEngine {
  public sqs: SQS;
  private queueUrl: string;
  private stopped: boolean;
  private triggerName: string;

  public constructor(config: SQS.Types.ClientConfiguration = {}, queueUrl?: string) {
    aws.config.update(config);
    this.sqs = new aws.SQS({ apiVersion: AWS_SDK_API_VERSION });
    this.queueUrl = queueUrl;
  }

  public asyncIterator = <T>(triggers: string | string[]): AsyncIterator<T> => {
    return new PubSubAsyncIterator<T>(this, triggers);
  };

  public createQueue = async (): Promise<void> => {
    if (this.queueUrl) return;

    const params = {
      QueueName: `${process.env.NODE_ENV || "local"}-${uuid.v4()}.fifo`,
      Attributes: {
        FifoQueue: "true"
      }
    };

    try {
      const result = await this.sqs.createQueue(params).promise();
      this.queueUrl = result.QueueUrl;
    } catch (error) {
      console.error(error);
    }
  };

  public deleteQueue = async (): Promise<void> => {
    if (!this.queueUrl) return;

    const params = {
      QueueUrl: this.queueUrl
    };

    try {
      await this.sqs.deleteQueue(params).promise();
      this.queueUrl = null;
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
      await this.sqs.deleteMessage(params).promise();
    } catch (error) {
      console.error(error);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public publish = async (triggerName: string, payload: any): Promise<void> => {
    if (!this.queueUrl) {
      await this.createQueue();
    }

    const params: SQS.Types.SendMessageRequest = {
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: triggerName,
      MessageDeduplicationId: uuid.v4(),
      MessageAttributes: {
        [PUB_SUB_MESSAGE_ATTRIBUTE]: {
          DataType: "String",
          StringValue: triggerName
        }
      }
    };

    try {
      await this.sqs.sendMessage(params).promise();
    } catch (error) {
      console.error(error);
    }
  };

  public subscribe = (triggerName: string, onMessage: Function): Promise<number> => {
    this.poll(triggerName, onMessage);
    return Promise.resolve(1);
  };

  public unsubscribe = async (): Promise<void> => {
    if (!this.stopped) {
      this.stopped = true;
      await this.deleteQueue();
      this.stopped = false;
    }
  };

  private readonly poll = async (triggerName: string, onMessage: Function): Promise<void> => {
    if (this.stopped) {
      return;
    }

    if (!this.queueUrl) {
      await this.createQueue();
    }


    console.log('this.queueUrl: ', this.queueUrl);

    const params = {
      MessageAttributeNames: [PUB_SUB_MESSAGE_ATTRIBUTE],
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20
    };

    console.log('params: ', params);

    try {
      const data = await this.receiveMessage(params);

      console.log('data: ', data);

      if (data && data.Messages) {
        for (const message of data.Messages) {
          if (message.MessageAttributes && message.MessageAttributes[PUB_SUB_MESSAGE_ATTRIBUTE]?.StringValue === triggerName) {
            await this.deleteMessage(message.ReceiptHandle);
            onMessage(JSON.parse(message.Body));
          }
        }
      }
    } catch (error) {
      console.error(error);
    }

    setImmediate(() => this.poll(triggerName, onMessage));
  };

  private readonly receiveMessage = async (params: SQS.Types.ReceiveMessageRequest): Promise<SQS.Types.ReceiveMessageResult> => {
    try {
      return await this.sqs.receiveMessage(params).promise();
    } catch (error) {
      console.error(error);
      return {};
    }
  };
}
