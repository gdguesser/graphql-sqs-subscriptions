"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQSPubSub = void 0;
const client_sqs_1 = require("@aws-sdk/client-sqs");
const pubsub_async_iterator_1 = require("graphql-subscriptions/dist/pubsub-async-iterator");
const uuid_1 = require("uuid");
const AWS_SDK_API_VERSION = "2012-11-05";
const PUB_SUB_MESSAGE_ATTRIBUTE = "SQSPubSubTriggerName";
class SQSPubSub {
    constructor(config = {}, queueUrl) {
        this.stopPolling = false;
        this.asyncIterator = (triggers) => {
            return new pubsub_async_iterator_1.PubSubAsyncIterator(this, triggers);
        };
        this.createQueue = () => __awaiter(this, void 0, void 0, function* () {
            if (this.queueUrl)
                return;
            const params = {
                QueueName: `${process.env.NODE_ENV || "local"}-${(0, uuid_1.v4)()}.fifo`,
                Attributes: {
                    FifoQueue: "true"
                }
            };
            try {
                const command = new client_sqs_1.CreateQueueCommand(params);
                const result = yield this.sqs.send(command);
                this.queueUrl = result.QueueUrl;
            }
            catch (error) {
                console.error(error);
            }
        });
        this.deleteMessage = (receiptHandle) => __awaiter(this, void 0, void 0, function* () {
            const params = {
                QueueUrl: this.queueUrl,
                ReceiptHandle: receiptHandle
            };
            try {
                const command = new client_sqs_1.DeleteMessageCommand(params);
                yield this.sqs.send(command);
            }
            catch (error) {
                console.error(error);
            }
        });
        this.publish = (triggerName, payload) => __awaiter(this, void 0, void 0, function* () {
            if (!this.queueUrl) {
                yield this.createQueue();
            }
            const params = {
                QueueUrl: this.queueUrl,
                MessageBody: JSON.stringify(payload),
                MessageGroupId: triggerName,
                MessageDeduplicationId: (0, uuid_1.v4)(),
                MessageAttributes: {
                    [PUB_SUB_MESSAGE_ATTRIBUTE]: {
                        DataType: "String",
                        StringValue: triggerName
                    }
                }
            };
            try {
                const command = new client_sqs_1.SendMessageCommand(params);
                yield this.sqs.send(command);
            }
            catch (error) {
                console.error(error);
            }
        });
        this.subscribe = (triggerName, onMessage) => {
            this.stopPolling = false;
            this.poll(triggerName, onMessage);
            return Promise.resolve(1);
        };
        this.unsubscribe = () => __awaiter(this, void 0, void 0, function* () {
            this.stopPolling = true;
        });
        this.poll = (triggerName, onMessage) => __awaiter(this, void 0, void 0, function* () {
            if (this.stopPolling) {
                return;
            }
            if (!this.queueUrl) {
                yield this.createQueue();
            }
            const params = {
                MessageAttributeNames: [PUB_SUB_MESSAGE_ATTRIBUTE],
                QueueUrl: this.queueUrl,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 20
            };
            try {
                const data = yield this.receiveMessage(params);
                if (data && data.Messages) {
                    for (const message of data.Messages) {
                        const messageAttributes = message.MessageAttributes;
                        if (messageAttributes && messageAttributes[PUB_SUB_MESSAGE_ATTRIBUTE] && messageAttributes[PUB_SUB_MESSAGE_ATTRIBUTE].StringValue === triggerName) {
                            yield this.deleteMessage(message.ReceiptHandle);
                            onMessage(JSON.parse(message.Body));
                        }
                    }
                }
            }
            catch (error) {
                console.error(error);
            }
            if (!this.stopPolling) {
                setImmediate(() => this.poll(triggerName, onMessage));
            }
        });
        this.receiveMessage = (params) => __awaiter(this, void 0, void 0, function* () {
            try {
                const command = new client_sqs_1.ReceiveMessageCommand(params);
                return yield this.sqs.send(command);
            }
            catch (error) {
                console.error(error);
                return {};
            }
        });
        this.sqs = new client_sqs_1.SQSClient(config);
        this.queueUrl = queueUrl;
    }
}
exports.SQSPubSub = SQSPubSub;
//# sourceMappingURL=sqs-pub-sub.js.map