import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { OutboxPublisher } from "../../../src/modules/messaging/application/outbox-publisher";
import { SqsWagerConsumer } from "../../../src/modules/messaging/application/sqs-wager-consumer";
import { SqsQueueClient } from "../../../src/modules/messaging/infrastructure/sqs-queue-client";
import { WorkerModule } from "../../../src/worker.module";

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (
    mode !== "inbox-before-ack" &&
    mode !== "outbox-after-publish" &&
    mode !== "outbox-after-claim" &&
    mode !== "outbox-once"
  ) {
    throw new Error("Unknown messaging crash-worker mode.");
  }
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });
  const sqs = app.get(SqsQueueClient);

  if (mode === "inbox-before-ack") {
    const receive = sqs.receive.bind(sqs);
    sqs.receive = async (queueName, maximumMessages) => {
      const messages = await receive(queueName, maximumMessages, 0, 0);
      if (messages[0]) {
        process.stdout.write(
          `${JSON.stringify({
            event: "message-received",
            receiptHandle: messages[0].receiptHandle,
          })}\n`,
        );
      }
      return messages;
    };
    const consumer = app.get(SqsWagerConsumer);
    const removeMessage = sqs.delete.bind(sqs);
    sqs.delete = async (...args) => {
      process.stdout.write(`${JSON.stringify({ event: "before-ack" })}\n`);
      await new Promise<void>(() => undefined);
      await removeMessage(...args);
    };
    await consumer.pollOnce();
    return;
  }

  const publisher = app.get(OutboxPublisher);
  if (mode === "outbox-after-claim") {
    sqs.publishEvent = async (...args) => {
      process.stdout.write(
        `${JSON.stringify({ event: "after-claim", eventId: args[1] })}\n`,
      );
      await new Promise<void>(() => undefined);
    };
    await publisher.publishBatch();
    return;
  }
  if (mode === "outbox-after-publish") {
    const publish = sqs.publishEvent.bind(sqs);
    sqs.publishEvent = async (...args) => {
      await publish(...args);
      process.stdout.write(`${JSON.stringify({ event: "after-publish" })}\n`);
      await new Promise<void>(() => undefined);
    };
    await publisher.publishBatch();
    return;
  }

  await publisher.publishBatch();
  await app.close();
  process.stdout.write(
    `${JSON.stringify({ event: "publish-batch-complete" })}\n`,
  );
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: "crash-worker-failed",
      error: error instanceof Error ? error.message : "Unknown failure.",
    })}\n`,
  );
  process.exitCode = 1;
});
