import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { DomainError } from "../../wallets/domain/errors/domain-error";
import { WalletNotFoundError } from "../../wallets/application/wallet-errors";
import { WagerConflictError } from "../../wagering/application/wager-errors";
import { WagerApplicationService } from "../../wagering/application/wager-application-service";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnvironment } from "../../../config/environment";
import { SqsQueueClient } from "../infrastructure/sqs-queue-client";
import { z } from "zod";
import { MetricsService } from "../../metrics/metrics.service";
import type { WagerStatus } from "../../wagering/domain/entities/wager-transaction";
import {
  correlationIdFromPayload,
  currentCorrelationId,
  runWithCorrelation,
} from "../../../observability/correlation-context";

const Identifier = z.string().trim().min(1).max(200);
const EnvelopeIdentitySchema = z
  .object({ messageId: Identifier })
  .passthrough();
const WagerEnvelopeSchema = z
  .object({
    messageId: Identifier,
    correlationId: z.string().uuid().optional(),
    type: z.literal("WagerTransactionRequested"),
    version: z.literal(1),
    occurredAt: z.string().datetime(),
    data: z
      .object({
        providerId: Identifier,
        externalTransactionId: Identifier,
        playerId: Identifier,
        walletId: z.string().uuid(),
        roundId: Identifier,
        gameId: Identifier,
        kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
        money: z
          .object({
            amount: z.string().regex(/^(?:0|[1-9]\d{0,35})\.\d{2}$/),
            currency: z.string().regex(/^[A-Z]{3}$/),
          })
          .strict(),
        referenceExternalTransactionId: Identifier.optional(),
        idempotencyKey: Identifier,
      })
      .strict(),
  })
  .strict();

type WagerEnvelope = z.infer<typeof WagerEnvelopeSchema>;
type QueueMessage = Awaited<ReturnType<SqsQueueClient["receive"]>>[number];

type InboxDisposition =
  | {
      kind: "completed";
      status: WagerStatus;
      replayed: boolean;
      transactionId: string;
      providerId: string;
      walletId: string;
    }
  | {
      kind: "duplicate";
      transactionId?: string;
      providerId?: string;
      walletId?: string;
    }
  | {
      kind: "dead-letter";
      failureCode: string;
      providerId?: string;
      walletId?: string;
    };

export class SqsWagerConsumer {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly environment = loadEnvironment();
  private stopping = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly wagers: WagerApplicationService,
    private readonly sqs: SqsQueueClient,
    private readonly metrics = new MetricsService(),
  ) {}

  async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.metrics.recordRetry("consumer");
        this.logger.error(
          JSON.stringify({
            event: "wager_queue_poll_failed",
            correlationId: currentCorrelationId(),
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

  async pollOnce(): Promise<number> {
    const messages = await this.sqs.receive(this.environment.SQS_WAGER_QUEUE);
    if (this.stopping) return 0;
    for (const message of messages) {
      await this.processMessage(message);
    }
    return messages.length;
  }

  private async processMessage(message: QueueMessage): Promise<void> {
    const correlationId =
      this.correlationIdFromMessage(message.body) ?? randomUUID();
    await runWithCorrelation(correlationId, async () => {
      const startedAt = performance.now();
      let extendingVisibility = false;
      const visibilityHeartbeat = setInterval(() => {
        if (extendingVisibility) return;
        extendingVisibility = true;
        void this.sqs
          .extendVisibility(
            this.environment.SQS_WAGER_QUEUE,
            message.receiptHandle,
            60,
          )
          .catch((error: unknown) => {
            this.logger.error(
              JSON.stringify({
                event: "wager_message_visibility_extension_failed",
                correlationId: currentCorrelationId(),
                errorType: error instanceof Error ? error.name : "UnknownError",
                messageId: message.messageId,
              }),
            );
          })
          .finally(() => {
            extendingVisibility = false;
          });
      }, 25_000);
      visibilityHeartbeat.unref();
      try {
        await this.processMessageWithLease(message);
      } finally {
        clearInterval(visibilityHeartbeat);
        this.metrics.observeWagerDuration(
          (performance.now() - startedAt) / 1_000,
          "sqs",
        );
      }
    });
  }

  private async processMessageWithLease(message: QueueMessage): Promise<void> {
    const parsed: unknown = this.parseJson(message.body);
    if (parsed === undefined) {
      await this.deadLetterAndDelete(
        message,
        "INVALID_JSON",
        message.messageId,
      );
      return;
    }
    const identity = EnvelopeIdentitySchema.safeParse(parsed);
    if (!identity.success) {
      await this.deadLetterAndDelete(
        message,
        "INVALID_MESSAGE_ENVELOPE",
        message.messageId,
      );
      return;
    }
    const envelope = WagerEnvelopeSchema.safeParse(parsed);
    const messageId = identity.data.messageId;
    const payloadHash = createHash("sha256").update(message.body).digest("hex");
    const inboxOutcome = await this.orm.em.fork().transactional(async (em) => {
      const payload = z.record(z.unknown()).parse(parsed);
      await em.execute(
        `insert into inbox_messages
          (consumer_name, message_id, payload_hash, status, attempts, payload, received_at)
         values (?, ?, ?, 'PROCESSING', 0, ?::jsonb, now())
         on conflict (consumer_name, message_id) do nothing`,
        ["wager-sqs-v1", messageId, payloadHash, JSON.stringify(payload)],
      );
      await em.execute(
        `update inbox_messages
         set attempts = attempts + 1
         where consumer_name = ? and message_id = ?`,
        ["wager-sqs-v1", messageId],
      );
      const rows = await em.execute<
        Array<{
          payload_hash: string;
          status: string;
          failure_code: string | null;
        }>
      >(
        `select payload_hash, status, failure_code
         from inbox_messages
         where consumer_name = ? and message_id = ?
         for update`,
        ["wager-sqs-v1", messageId],
      );
      const row = rows[0];
      if (!row) throw new Error("Inbox claim did not return a persisted row.");
      if (row.payload_hash !== payloadHash) {
        await em.execute(
          `insert into inbox_message_conflicts
            (consumer_name, message_id, payload_hash, payload, received_at)
           values (?, ?, ?, ?::jsonb, now())
           on conflict do nothing`,
          ["wager-sqs-v1", messageId, payloadHash, JSON.stringify(payload)],
        );
        return {
          kind: "dead-letter",
          failureCode: "MESSAGE_ID_PAYLOAD_CONFLICT",
          ...(envelope.success
            ? {
                providerId: envelope.data.data.providerId,
                walletId: envelope.data.data.walletId,
              }
            : {}),
        } satisfies InboxDisposition;
      }
      if (row.status === "COMPLETED") {
        if (envelope.success) {
          const transactions = await em.execute<Array<{ id: string }>>(
            `select id from wager_transactions
             where provider_id = ? and external_transaction_id = ?`,
            [
              envelope.data.data.providerId,
              envelope.data.data.externalTransactionId,
            ],
          );
          return {
            kind: "duplicate",
            ...(transactions[0] ? { transactionId: transactions[0].id } : {}),
            providerId: envelope.data.data.providerId,
            walletId: envelope.data.data.walletId,
          } satisfies InboxDisposition;
        }
        return { kind: "duplicate" } satisfies InboxDisposition;
      }
      if (row.status === "FAILED") {
        return {
          kind: "dead-letter",
          failureCode: row.failure_code ?? "PERMANENT_MESSAGE_FAILURE",
          ...(envelope.success
            ? {
                providerId: envelope.data.data.providerId,
                walletId: envelope.data.data.walletId,
              }
            : {}),
        } satisfies InboxDisposition;
      }
      if (!envelope.success) {
        await em.execute(
          `update inbox_messages
           set status = 'FAILED', completed_at = now(), failure_code = ?
           where consumer_name = ? and message_id = ?`,
          ["INVALID_MESSAGE_CONTRACT", "wager-sqs-v1", messageId],
        );
        return {
          kind: "dead-letter",
          failureCode: "INVALID_MESSAGE_CONTRACT",
        } satisfies InboxDisposition;
      }
      let wagerStatus: WagerStatus;
      let wagerReplayed: boolean;
      let wagerTransactionId: string;
      try {
        const wagerResult = await this.wagers.submit(
          this.toSubmission(envelope.data),
          envelope.data.data.idempotencyKey,
          em,
          envelope.data.correlationId ?? currentCorrelationId(),
        );
        wagerStatus = wagerResult.body.status;
        wagerReplayed = wagerResult.body.idempotentReplay;
        wagerTransactionId = wagerResult.body.transactionId;
      } catch (error) {
        if (
          !(error instanceof DomainError) &&
          !(error instanceof WalletNotFoundError) &&
          !(error instanceof WagerConflictError)
        ) {
          throw error;
        }
        const failureCode =
          error instanceof DomainError
            ? error.code
            : error instanceof WalletNotFoundError
              ? "WALLET_NOT_FOUND"
              : "IDEMPOTENCY_CONFLICT";
        await em.execute(
          `update inbox_messages
           set status = 'FAILED', completed_at = now(), failure_code = ?
           where consumer_name = ? and message_id = ?`,
          [failureCode, "wager-sqs-v1", messageId],
        );
        return {
          kind: "dead-letter",
          failureCode,
          providerId: envelope.data.data.providerId,
          walletId: envelope.data.data.walletId,
        } satisfies InboxDisposition;
      }
      await em.execute(
        `update inbox_messages
         set status = 'COMPLETED', completed_at = now(), failure_code = null
         where consumer_name = ? and message_id = ?`,
        ["wager-sqs-v1", messageId],
      );
      return {
        kind: "completed",
        status: wagerStatus,
        replayed: wagerReplayed,
        transactionId: wagerTransactionId,
        providerId: envelope.data.data.providerId,
        walletId: envelope.data.data.walletId,
      } satisfies InboxDisposition;
    });

    if (inboxOutcome.kind === "dead-letter") {
      if (inboxOutcome.failureCode === "IDEMPOTENCY_CONFLICT") {
        this.metrics.recordIdempotencyConflict();
      }
      await this.deadLetterAndDelete(
        message,
        inboxOutcome.failureCode,
        messageId,
        inboxOutcome,
      );
      return;
    }
    if (inboxOutcome.kind === "duplicate") {
      this.metrics.recordInboxDuplicate();
    } else {
      this.metrics.recordWagerOutcome(
        inboxOutcome.status,
        inboxOutcome.replayed,
      );
    }
    await this.sqs.delete(
      this.environment.SQS_WAGER_QUEUE,
      message.receiptHandle,
    );
    this.logger.log(
      JSON.stringify({
        event: "wager_message_acknowledged",
        disposition: inboxOutcome.kind,
        correlationId: currentCorrelationId(),
        messageId,
        receiveCount: message.receiveCount,
        ...("transactionId" in inboxOutcome &&
        typeof inboxOutcome.transactionId === "string"
          ? { transactionId: inboxOutcome.transactionId }
          : {}),
        ...("providerId" in inboxOutcome &&
        typeof inboxOutcome.providerId === "string"
          ? { providerId: inboxOutcome.providerId }
          : {}),
        ...("walletId" in inboxOutcome &&
        typeof inboxOutcome.walletId === "string"
          ? { walletId: inboxOutcome.walletId }
          : {}),
      }),
    );
  }

  private async deadLetterAndDelete(
    message: QueueMessage,
    failureCode: string,
    messageId: string,
    identifiers: { providerId?: string; walletId?: string } = {},
  ): Promise<void> {
    await this.sqs.sendDeadLetter(
      this.environment.SQS_DLQ_QUEUE,
      message.body,
      messageId,
      failureCode,
      currentCorrelationId(),
    );
    this.metrics.recordDeadLetter(
      failureCode === "MESSAGE_ID_PAYLOAD_CONFLICT"
        ? "message_conflict"
        : failureCode === "INVALID_JSON" ||
            failureCode === "INVALID_MESSAGE_ENVELOPE" ||
            failureCode === "INVALID_MESSAGE_CONTRACT"
          ? "invalid_message"
          : "business_failure",
    );
    await this.sqs.delete(
      this.environment.SQS_WAGER_QUEUE,
      message.receiptHandle,
    );
    this.logger.warn(
      JSON.stringify({
        event: "wager_message_dead_lettered",
        failureCode,
        correlationId: currentCorrelationId(),
        messageId,
        receiveCount: message.receiveCount,
        ...identifiers,
      }),
    );
  }

  private parseJson(value: string): unknown | undefined {
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private correlationIdFromMessage(body: string): string | undefined {
    const parsed = this.parseJson(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return correlationIdFromPayload(parsed);
  }

  private toSubmission(envelope: WagerEnvelope) {
    return {
      providerId: envelope.data.providerId,
      externalTransactionId: envelope.data.externalTransactionId,
      playerId: envelope.data.playerId,
      walletId: envelope.data.walletId,
      roundId: envelope.data.roundId,
      gameId: envelope.data.gameId,
      kind: envelope.data.kind,
      money: envelope.data.money,
      ...(envelope.data.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId:
              envelope.data.referenceExternalTransactionId,
          }
        : {}),
    };
  }
}
