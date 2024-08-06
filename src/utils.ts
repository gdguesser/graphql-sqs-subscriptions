import { SQSServiceException } from "@aws-sdk/client-sqs";

export const errorHandler = (err: SQSServiceException): void => {
  if (err) {
    console.error(err);
  }
};
