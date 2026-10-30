import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { WagerApplicationService } from "../../wagering/application/wager-application-service";
import {
  currentCorrelationId,
  runWithCorrelation,
  validCorrelationId,
} from "../../../observability/correlation-context";

export class PendingReferenceReprocessor {
  private readonly logger = new Logger(PendingReferenceReprocessor.name);
  private readonly leaseOwner = randomUUID();
  private stopping = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly wagers: WagerApplicationService,
  ) {}

  async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const processed = await this.reprocessBatch();
        if (processed === 0)
          await new Promise((resolve) => setTimeout(resolve, 1_000));
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: "pending_reference_poll_failed",
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

  async reprocessBatch(): Promise<number> {
    const claimed = await this.orm.em.fork().transactional(async (em) =>
      em.execute<
        Array<{
          id: string;
          provider_id: string | null;
          wallet_id: string;
          correlation_id: string | null;
        }>
      >(
        `with due as (
           select id
           from wager_transactions
           where status = 'PENDING_REFERENCE'
             and next_retry_at <= now()
             and (lease_expires_at is null or lease_expires_at <= now())
           order by next_retry_at, id
           for update skip locked
           limit 10
         )
         update wager_transactions as wager
         set lease_owner = ?,
             lease_expires_at = now() + interval '60 seconds'
         from due
         where wager.id = due.id
         returning wager.id,
           wager.provider_id,
           wager.wallet_id,
           (select payload->>'correlationId'
            from outbox_messages
            where aggregate_id = wager.id::text
              and event_type = 'WagerTransactionPendingReference'
            order by created_at, event_id
            limit 1) as correlation_id`,
        [this.leaseOwner],
      ),
    );
    for (const { id, provider_id, wallet_id, correlation_id } of claimed) {
      const correlationId =
        validCorrelationId(correlation_id) ?? currentCorrelationId();
      await runWithCorrelation(correlationId ?? randomUUID(), async () => {
        try {
          await this.wagers.reprocessPendingReference(id, this.leaseOwner);
        } catch (error) {
          this.logger.error(
            JSON.stringify({
              event: "pending_reference_processing_failed",
              correlationId: currentCorrelationId(),
              errorType: error instanceof Error ? error.name : "UnknownError",
              transactionId: id,
              ...(provider_id ? { providerId: provider_id } : {}),
              walletId: wallet_id,
            }),
          );
        }
      });
    }
    return claimed.length;
  }
}
