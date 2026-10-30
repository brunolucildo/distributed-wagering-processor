import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createHash, randomUUID } from "node:crypto";
import { loadEnvironment } from "../../../config/environment";

export class SqsQueueClient {
  private readonly client: SQSClient;
  private readonly queueUrls = new Map<string, string>();

  constructor() {
    const environment = loadEnvironment();
    const endpoint = environment.SQS_ENDPOINT;
    this.client = new SQSClient({
      region: environment.AWS_REGION,
      ...(endpoint ? { endpoint } : {}),
      ...(endpoint || environment.AWS_ACCESS_KEY_ID
        ? {
            credentials: {
              accessKeyId: environment.AWS_ACCESS_KEY_ID ?? "test",
              secretAccessKey: environment.AWS_SECRET_ACCESS_KEY ?? "test",
            },
          }
        : {}),
      maxAttempts: 2,
    });
  }

  async receive(
    queueName: string,
    maximumMessages = 1,
    visibilityTimeoutSeconds = 60,
    waitTimeSeconds = 10,
  ): Promise<
    Array<{
      body: string;
      receiptHandle: string;
      messageId: string;
      receiveCount: number;
    }>
  > {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MaxNumberOfMessages: maximumMessages,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    return (result.Messages ?? [])
      .filter(
        (
          message,
        ): message is typeof message & {
          Body: string;
          ReceiptHandle: string;
        } => Boolean(message.Body && message.ReceiptHandle),
      )
      .map((message) => ({
        body: message.Body,
        receiptHandle: message.ReceiptHandle,
        messageId: message.MessageId ?? "",
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
      }));
  }

  async sendWager(
    queueName: string,
    body: string,
    walletId: string,
    messageId: string,
  ) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MessageBody: body,
        MessageGroupId: walletId,
        MessageDeduplicationId: this.deduplicationId(messageId),
      }),
    );
  }

  async sendDeadLetter(
    queueName: string,
    body: string,
    messageId: string,
    failureCode: string,
    correlationId?: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MessageBody: body,
        MessageGroupId: "invalid-wager-messages",
        MessageDeduplicationId: this.deduplicationId(
          `${messageId}:${createHash("sha256").update(body).digest("hex")}`,
        ),
        MessageAttributes: {
          failureCode: {
            DataType: "String",
            StringValue: failureCode.slice(0, 100),
          },
          ...(correlationId
            ? {
                correlationId: {
                  DataType: "String",
                  StringValue: correlationId,
                },
              }
            : {}),
        },
      }),
    );
  }

  async publishEvent(
    queueName: string,
    eventId: string,
    aggregateId: string,
    body: string,
  ) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MessageBody: body,
        MessageGroupId: aggregateId,
        MessageDeduplicationId: eventId,
      }),
    );
  }

  async delete(queueName: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async extendVisibility(
    queueName: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(queueName),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  async checkConnectivity(queueNames: string[]): Promise<void> {
    await Promise.all(queueNames.map((queueName) => this.queueUrl(queueName)));
  }

  async getApproximateQueueDepth(queueName: string): Promise<number> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.queueUrl(queueName),
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );
    const visible = Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
    const inFlight = Number(
      result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0,
    );
    return visible + inFlight;
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  private async queueUrl(queueName: string): Promise<string> {
    const cached = this.queueUrls.get(queueName);
    if (cached) return cached;
    const result = await this.client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );
    if (!result.QueueUrl) {
      throw new Error(`SQS did not return a URL for queue ${queueName}.`);
    }
    this.queueUrls.set(queueName, result.QueueUrl);
    return result.QueueUrl;
  }

  private deduplicationId(value: string): string {
    return value.length > 128
      ? createHash("sha256").update(value).digest("hex")
      : value || randomUUID();
  }
}
