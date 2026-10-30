import { describe, expect, test } from "bun:test";
import { MetricsService } from "../../src/modules/metrics/metrics.service";

describe("operational metrics", () => {
  test("exports bounded-cardinality financial and recovery metrics", async () => {
    const metrics = new MetricsService();
    metrics.recordWagerOutcome("PROCESSED", false);
    metrics.recordWagerOutcome("PROCESSED", true);
    metrics.recordIdempotencyConflict();
    metrics.recordInboxDuplicate();
    metrics.recordRetry("database");
    metrics.recordRetry("consumer");
    metrics.recordRetry("outbox");
    metrics.recordLockConflict("deadlock");
    metrics.recordDeadLetter("business_failure");
    metrics.observeWagerDuration(0.01, "http");
    metrics.recordOutboxBacklog(2, 4.5);
    metrics.recordDeadLetterQueueDepth(3);
    metrics.recordReconciliationDiscrepancy();

    const output = await metrics.metrics();
    for (const name of [
      "wager_transactions_total",
      "wager_replays_total",
      "wager_idempotency_conflicts_total",
      "inbox_duplicate_deliveries_total",
      "processing_retries_total",
      "database_lock_conflicts_total",
      "messages_dead_lettered_total",
      "wager_processing_duration_seconds",
      "outbox_pending_messages",
      "outbox_oldest_pending_age_seconds",
      "sqs_dead_letter_queue_messages",
      "wallet_reconciliation_discrepancies_total",
    ]) {
      expect(output).toContain(`# HELP ${name}`);
    }
    expect(output).toContain('status="PROCESSED"');
    expect(output).toContain('source="database"');
    expect(output).toContain('kind="deadlock"');
    expect(output).toContain("outbox_pending_messages{");
    expect(output).toContain("} 2");
    expect(output).toContain("outbox_oldest_pending_age_seconds{");
    expect(output).toContain("} 4.5");
    expect(output).toContain("sqs_dead_letter_queue_messages{");
    expect(output).toContain("} 3");
  });
});
