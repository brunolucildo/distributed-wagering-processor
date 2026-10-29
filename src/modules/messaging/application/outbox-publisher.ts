import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnvironment } from "../../../config/environment";
import { SqsQueueClient } from "../infrastructure/sqs-queue-client";

interface OutboxMessage {
  event_id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly environment = loadEnvironment();
  private readonly leaseOwner = randomUUID();
  private stopping = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsQueueClient,
  ) {}

  async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const published = await this.publishBatch();
        if (published === 0)
          await new Promise((resolve) => setTimeout(resolve, 1_000));
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: "outbox_poll_failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  stop(): void {
    this.stopping = true;
  }

  async publishBatch(): Promise<number> {
    const messages = await this.claimBatch();
    for (const message of messages) {
      try {
        await this.sqs.publishEvent(
          this.environment.SQS_EVENTS_QUEUE,
          message.event_id,
          message.aggregate_id,
          JSON.stringify(message.payload),
        );
        await this.markPublished(message.event_id);
      } catch (error) {
        await this.markFailed(message.event_id, error);
      }
    }
    return messages.length;
  }

  async replayFailed(eventId: string): Promise<boolean> {
    const updated = await this.orm.em
      .fork()
      .execute<Array<{ event_id: string }>>(
        `update outbox_messages
       set status = 'PENDING', attempts = 0, next_attempt_at = now(),
           last_error = null
       where event_id = ? and status = 'FAILED'
       returning event_id`,
        [eventId],
      );
    return updated.length > 0;
  }

  private async claimBatch(): Promise<OutboxMessage[]> {
    return this.orm.em.fork().transactional(async (em) =>
      em.execute<OutboxMessage[]>(
        `with due as (
           select event_id
           from outbox_messages
           where (
             status = 'PENDING' and next_attempt_at <= now()
           ) or (
             status = 'PROCESSING' and lease_expires_at <= now()
           )
           order by next_attempt_at, created_at, event_id
           for update skip locked
           limit 10
         )
         update outbox_messages as message
         set status = 'PROCESSING',
             lease_owner = ?,
             lease_expires_at = now() + interval '60 seconds'
         from due
         where message.event_id = due.event_id
         returning message.event_id, message.aggregate_id, message.payload`,
        [this.leaseOwner],
      ),
    );
  }

  private async markPublished(eventId: string): Promise<void> {
    const updated = await this.orm.em
      .fork()
      .execute<Array<{ event_id: string }>>(
        `update outbox_messages
       set status = 'PUBLISHED', published_at = now(),
           lease_owner = null, lease_expires_at = null, last_error = null
       where event_id = ? and status = 'PROCESSING' and lease_owner = ?
       returning event_id`,
        [eventId, this.leaseOwner],
      );
    if (updated.length === 0) {
      this.logger.warn(
        JSON.stringify({
          event: "outbox_lease_lost_after_publish",
          eventId,
        }),
      );
    }
  }

  private async markFailed(eventId: string, error: unknown): Promise<void> {
    const rows = await this.orm.em.fork().execute<Array<{ attempts: number }>>(
      `select attempts from outbox_messages
       where event_id = ? and status = 'PROCESSING' and lease_owner = ?`,
      [eventId, this.leaseOwner],
    );
    const currentAttempt = rows[0]?.attempts;
    if (currentAttempt === undefined) {
      this.logger.warn(
        JSON.stringify({ event: "outbox_lease_lost_after_failure", eventId }),
      );
      return;
    }
    const attempts = currentAttempt + 1;
    const terminal = attempts >= 10;
    const baseDelay = Math.min(1_000 * 2 ** (attempts - 1), 300_000);
    const delay = Math.min(
      300_000,
      Math.round(baseDelay * (0.5 + Math.random())),
    );
    const errorType = error instanceof Error ? error.name : "UnknownError";
    await this.orm.em.fork().execute(
      `update outbox_messages
       set status = ?, attempts = ?, next_attempt_at = now() + (? * interval '1 millisecond'),
           lease_owner = null, lease_expires_at = null, last_error = ?
       where event_id = ? and status = 'PROCESSING' and lease_owner = ?`,
      [
        terminal ? "FAILED" : "PENDING",
        attempts,
        delay,
        errorType.slice(0, 100),
        eventId,
        this.leaseOwner,
      ],
    );
    this.logger.error(
      JSON.stringify({
        event: terminal ? "outbox_publish_exhausted" : "outbox_publish_retry",
        attempts,
        errorType,
        eventId,
        nextAttemptDelayMs: terminal ? null : delay,
      }),
    );
  }
}
