import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnvironment } from "../../../config/environment";
import { SqsQueueClient } from "../infrastructure/sqs-queue-client";
import { MetricsService } from "../../metrics/metrics.service";
import {
  correlationIdFromPayload,
  currentCorrelationId,
  runWithCorrelation,
} from "../../../observability/correlation-context";

interface OutboxMessage {
  event_id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

interface OutboxLogIdentifiers {
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly environment = loadEnvironment();
  private readonly leaseOwner = randomUUID();
  private stopping = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsQueueClient,
    private readonly metrics = new MetricsService(),
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
      const correlationId =
        correlationIdFromPayload(message.payload) ?? randomUUID();
      const identifiers = this.logIdentifiers(message.payload);
      await runWithCorrelation(correlationId, async () => {
        try {
          await this.sqs.publishEvent(
            this.environment.SQS_EVENTS_QUEUE,
            message.event_id,
            message.aggregate_id,
            JSON.stringify(message.payload),
          );
          await this.markPublished(message.event_id, identifiers);
        } catch (error) {
          await this.markFailed(message.event_id, error, identifiers);
        }
      });
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

  private async markPublished(
    eventId: string,
    identifiers: OutboxLogIdentifiers,
  ): Promise<void> {
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
          correlationId: currentCorrelationId(),
          ...identifiers,
        }),
      );
    }
  }

  private async markFailed(
    eventId: string,
    error: unknown,
    identifiers: OutboxLogIdentifiers,
  ): Promise<void> {
    const rows = await this.orm.em.fork().execute<Array<{ attempts: number }>>(
      `select attempts from outbox_messages
       where event_id = ? and status = 'PROCESSING' and lease_owner = ?`,
      [eventId, this.leaseOwner],
    );
    const currentAttempt = rows[0]?.attempts;
    if (currentAttempt === undefined) {
      this.logger.warn(
        JSON.stringify({
          event: "outbox_lease_lost_after_failure",
          eventId,
          correlationId: currentCorrelationId(),
          ...identifiers,
        }),
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
    const updated = await this.orm.em
      .fork()
      .execute<Array<{ event_id: string }>>(
        `update outbox_messages
       set status = ?, attempts = ?, next_attempt_at = now() + (? * interval '1 millisecond'),
           lease_owner = null, lease_expires_at = null, last_error = ?
       where event_id = ? and status = 'PROCESSING' and lease_owner = ?
       returning event_id`,
        [
          terminal ? "FAILED" : "PENDING",
          attempts,
          delay,
          errorType.slice(0, 100),
          eventId,
          this.leaseOwner,
        ],
      );
    if (updated.length === 0) {
      this.logger.warn(
        JSON.stringify({
          event: "outbox_lease_lost_after_failure",
          eventId,
          correlationId: currentCorrelationId(),
          ...identifiers,
        }),
      );
      return;
    }
    this.metrics.recordRetry("outbox");
    this.logger.error(
      JSON.stringify({
        event: terminal ? "outbox_publish_exhausted" : "outbox_publish_retry",
        correlationId: currentCorrelationId(),
        eventId,
        ...identifiers,
        attempts,
        errorType,
        nextAttemptDelayMs: terminal ? null : delay,
      }),
    );
  }

  private logIdentifiers(
    payload: Record<string, unknown>,
  ): OutboxLogIdentifiers {
    const data = payload.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const record = data as Record<string, unknown>;
    return {
      ...(typeof record.transactionId === "string"
        ? { transactionId: record.transactionId }
        : {}),
      ...(typeof record.walletId === "string"
        ? { walletId: record.walletId }
        : {}),
      ...(typeof record.providerId === "string"
        ? { providerId: record.providerId }
        : {}),
    };
  }
}
