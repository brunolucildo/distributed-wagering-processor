import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { z } from "zod";
import { AppModule } from "../../app.module";
import { OutboxPublisher } from "./application/outbox-publisher";

async function replayFailedOutboxMessage(): Promise<void> {
  const eventId = z.string().uuid().parse(process.env.OUTBOX_EVENT_ID);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const replayed = await app.get(OutboxPublisher).replayFailed(eventId);
    if (!replayed) {
      throw new Error(`No FAILED Outbox event found for eventId ${eventId}.`);
    }
    Logger.log(
      JSON.stringify({ event: "outbox_event_requeued", eventId }),
      "OutboxReplay",
    );
  } finally {
    await app.close();
  }
}

void replayFailedOutboxMessage().catch((error: unknown) => {
  Logger.error(
    JSON.stringify({
      event: "outbox_replay_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unexpected failure.",
    }),
    undefined,
    "OutboxReplay",
  );
  process.exitCode = 1;
});
