import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../../src/modules/messaging/domain/inbox-message";
import {
  OUTBOX_MAX_ATTEMPTS,
  OutboxMessage,
} from "../../../src/modules/messaging/domain/outbox-message";
import { WagerTransactionPendingReference } from "../../../src/modules/messaging/contracts/integration-events";
import { WagerTransaction } from "../../../src/modules/wagering/domain/entities/wager-transaction";
import { Money } from "../../../src/modules/wallets/domain/value-objects/money";

const at = new Date("2026-10-30T12:00:00.000Z");

describe("InboxMessage", () => {
  const receive = () =>
    InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-sqs-v1",
      payloadHash: "hash-1",
      receivedAt: at,
    });

  test("starts unprocessed and records the processing instant once", () => {
    const message = receive();
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(at);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(at);
    expect(() => message.markProcessed(at)).toThrow();
  });

  test("distinguishes a replay from a payload conflict", () => {
    const message = receive();
    expect(message.matchesPayload("hash-1")).toBe(true);
    expect(message.matchesPayload("hash-2")).toBe(false);
  });

  test("rehydrates processed state without revalidating transitions", () => {
    const message = InboxMessage.rehydrate({
      messageId: "msg-1",
      consumerName: "wager-sqs-v1",
      payloadHash: "hash-1",
      receivedAt: at,
      processedAt: at,
    });
    expect(message.isProcessed()).toBe(true);
  });

  test("rejects blank identities", () => {
    expect(() =>
      InboxMessage.receive({
        messageId: " ",
        consumerName: "c",
        payloadHash: "h",
        receivedAt: at,
      }),
    ).toThrow();
  });
});

describe("OutboxMessage", () => {
  function enqueue(): OutboxMessage {
    const transaction = WagerTransaction.create({
      id: "tx-1",
      providerId: "provider-1",
      externalTransactionId: "ext-1",
      playerId: "player-1",
      walletId: "wallet-1",
      currency: "BRL",
      roundId: "round-1",
      kind: "REFUND",
      amount: Money.parse("5.00", "BRL"),
      referenceExternalTransactionId: "ext-0",
      createdAt: at,
    });
    return OutboxMessage.enqueue(
      WagerTransactionPendingReference.from(transaction, {
        correlationId: "corr-1",
        occurredAt: at,
        eventId: "event-1",
      }),
    );
  }

  test("captures the serialized event and is immediately due", () => {
    const message = enqueue();
    expect(message.id).toBe("event-1");
    expect(message.eventType).toBe("WagerTransactionPendingReference");
    expect(message.aggregateId).toBe("tx-1");
    expect(message.payload.eventType).toBe("WagerTransactionPendingReference");
    expect(message.payload.occurredAt).toBe(at.toISOString());
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at)).toBe(true);
    expect(message.attempts).toBe(0);
  });

  test("scheduleRetry counts attempts and backs off exponentially", () => {
    const message = enqueue();
    const noJitter = () => 0.5;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      message.scheduleRetry(at, noJitter);
      delays.push((message.nextAttemptAt?.getTime() ?? 0) - at.getTime());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(message.attempts).toBe(4);
    expect(message.isDue(at)).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 8_000))).toBe(true);
  });

  test("caps the backoff and exhausts after the maximum attempts", () => {
    const message = enqueue();
    for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      message.scheduleRetry(at, () => 1.5);
    }
    expect(message.nextAttemptAt?.getTime()).toBe(at.getTime() + 300_000);
    expect(message.isExhausted()).toBe(true);
    expect(message.isDue(new Date(at.getTime() + 600_000))).toBe(false);
  });

  test("a published message is no longer pending or retryable", () => {
    const message = enqueue();
    message.markPublished(at);
    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(at);
    expect(message.isDue(at)).toBe(false);
    expect(() => message.markPublished(at)).toThrow();
    expect(() => message.scheduleRetry(at)).toThrow();
  });
});
