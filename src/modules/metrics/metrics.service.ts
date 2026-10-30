import { Injectable } from "@nestjs/common";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly wagerTransactions: Counter<"status">;
  private readonly wagerReplays: Counter<"status">;
  private readonly inboxDuplicates: Counter<"">;
  private readonly idempotencyConflicts: Counter<"kind">;
  private readonly retries: Counter<"source">;
  private readonly deadLetters: Counter<"reason">;
  private readonly lockConflicts: Counter<"kind">;
  private readonly wagerDuration: Histogram<"transport">;
  private readonly outboxPending: Gauge<"">;
  private readonly outboxOldestAge: Gauge<"">;
  private readonly deadLetterQueueDepth: Gauge<"">;
  private readonly reconciliationDiscrepancies: Counter<"">;

  constructor() {
    this.registry.setDefaultLabels({
      service: "distributed-wagering-processor",
      role: process.env.WORKER_ROLE ?? "api",
    });
    collectDefaultMetrics({ register: this.registry });
    this.wagerTransactions = new Counter({
      name: "wager_transactions_total",
      help: "Wager submission outcomes recorded by this process.",
      labelNames: ["status"],
      registers: [this.registry],
    });
    this.wagerReplays = new Counter({
      name: "wager_replays_total",
      help: "Idempotent wager replays returned by this process.",
      labelNames: ["status"],
      registers: [this.registry],
    });
    this.inboxDuplicates = new Counter({
      name: "inbox_duplicate_deliveries_total",
      help: "Completed Inbox messages redelivered and safely acknowledged.",
      registers: [this.registry],
    });
    this.idempotencyConflicts = new Counter({
      name: "wager_idempotency_conflicts_total",
      help: "Wager identity or idempotency conflicts detected.",
      labelNames: ["kind"],
      registers: [this.registry],
    });
    this.retries = new Counter({
      name: "processing_retries_total",
      help: "Retryable failures encountered by processing components.",
      labelNames: ["source"],
      registers: [this.registry],
    });
    this.deadLetters = new Counter({
      name: "messages_dead_lettered_total",
      help: "Messages explicitly routed to the dead-letter queue.",
      labelNames: ["reason"],
      registers: [this.registry],
    });
    this.lockConflicts = new Counter({
      name: "database_lock_conflicts_total",
      help: "Retryable PostgreSQL concurrency conflicts.",
      labelNames: ["kind"],
      registers: [this.registry],
    });
    this.wagerDuration = new Histogram({
      name: "wager_processing_duration_seconds",
      help: "Duration of wager submission attempts.",
      labelNames: ["transport"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.outboxPending = new Gauge({
      name: "outbox_pending_messages",
      help: "Outbox messages pending publication or currently leased.",
      registers: [this.registry],
    });
    this.outboxOldestAge = new Gauge({
      name: "outbox_oldest_pending_age_seconds",
      help: "Age of the oldest pending or leased outbox message.",
      registers: [this.registry],
    });
    this.deadLetterQueueDepth = new Gauge({
      name: "sqs_dead_letter_queue_messages",
      help: "Approximate visible and in-flight message count in the configured DLQ.",
      registers: [this.registry],
    });
    this.reconciliationDiscrepancies = new Counter({
      name: "wallet_reconciliation_discrepancies_total",
      help: "Wallet reconciliation discrepancies observed by this process.",
      registers: [this.registry],
    });
  }

  recordWagerOutcome(status: string, replayed: boolean): void {
    this.wagerTransactions.inc({ status });
    if (replayed) this.wagerReplays.inc({ status });
  }

  recordIdempotencyConflict(): void {
    this.idempotencyConflicts.inc({ kind: "identity_or_payload" });
  }

  recordInboxDuplicate(): void {
    this.inboxDuplicates.inc();
  }

  recordRetry(source: "database" | "consumer" | "outbox"): void {
    this.retries.inc({ source });
  }

  recordLockConflict(
    kind: "serialization" | "deadlock" | "lock_unavailable",
  ): void {
    this.lockConflicts.inc({ kind });
  }

  recordDeadLetter(
    reason: "invalid_message" | "message_conflict" | "business_failure",
  ): void {
    this.deadLetters.inc({ reason });
  }

  observeWagerDuration(seconds: number, transport: "http" | "sqs"): void {
    this.wagerDuration.observe({ transport }, seconds);
  }

  recordOutboxBacklog(pendingCount: number, oldestAgeSeconds: number): void {
    this.outboxPending.set(pendingCount);
    this.outboxOldestAge.set(oldestAgeSeconds);
  }

  recordDeadLetterQueueDepth(messageCount: number): void {
    this.deadLetterQueueDepth.set(messageCount);
  }

  recordReconciliationDiscrepancy(): void {
    this.reconciliationDiscrepancies.inc();
  }

  async metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
